import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { allowFileRoot } from "./file-access";
import { upsertGradingRun, type GradingRunRecord } from "./grading-run-store";
import { startEvaluatorAfterGrading } from "./minerva-evaluator-start";
import { buildGradingUserPrompt } from "./minerva-grading";
import { readProcessingState, setStudentProcessing, type ProcessingStudent } from "./minerva-processing";
import { runStudentWaves, waitForStudentWorker } from "./minerva-student-pool";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";


type GraderWorker = {
  sessionId: string;
  session: {
    isRunning(): boolean;
    onEvent(listener: (event: { type?: string; errorMessage?: string }) => void): () => void;
    send(command: Record<string, unknown>): Promise<unknown>;
    shutdown(): Promise<void>;
  };
  readFailure(): string | null;
  lastActivity(): number;
  unsubscribe(): void;
};

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

declare global {
  var __minervaActiveGradingAssignments: Set<string> | undefined;
}

function getActiveGradingAssignments(): Set<string> {
  if (!globalThis.__minervaActiveGradingAssignments) {
    globalThis.__minervaActiveGradingAssignments = new Set<string>();
  }
  return globalThis.__minervaActiveGradingAssignments;
}

export function isGradingPipelineActive(assignmentId: string): boolean {
  return getActiveGradingAssignments().has(assignmentId);
}

async function finalizeAssignment(assignmentId: string): Promise<void> {
  const response = await fetch(`${dataApiUrl()}/api/minerva/write`, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "grading", assignment_id: assignmentId, finalize: true }),
  });
  const payload = await response.json().catch(() => ({ detail: "批改完成检查返回了无效响应" })) as { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `完成批改失败 HTTP ${response.status}`);
}

async function startStudentWorker(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  student: ProcessingStudent;
  unmatched?: { filename: string; reason: string }[];
  groupId: string;
  agentIndex: number;
  attempt: number;
}): Promise<GraderWorker> {
  await setStudentProcessing({
    assignmentId: options.assignmentId,
    studentId: options.student.student_id,
    status: "grading",
  });
  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd, {
    grader: {
      assignmentId: options.assignmentId,
      title: options.title,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
    },
  });
  const retryLabel = options.attempt > 1 ? ` · 重试 ${options.attempt}` : "";
  await registerWorkbenchSession({
    assignmentId: options.assignmentId,
    title: options.title,
    session: {
      sessionId: realSessionId,
      role: "marker",
      label: options.student.student_name ? `批改 · ${options.student.student_name}${retryLabel}` : `批改 · ${options.student.student_id.slice(0, 8)}${retryLabel}`,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
      groupId: options.groupId,
      agentIndex: options.agentIndex,
      attempt: options.attempt,
    },
  }).catch((error) => console.error("[minerva] failed to register Marker workbench session:", error));
  let failure: string | null = null;
  let lastActivity = Date.now();
  const unsubscribe = session.onEvent((event) => {
    lastActivity = Date.now();
    if (event.type === "prompt_error") {
      failure = typeof event.errorMessage === "string" && event.errorMessage
        ? event.errorMessage
        : "LLM 连接中断";
    }
  });
  try {
    await session.send({
      type: "prompt",
      message: buildGradingUserPrompt({
        assignmentId: options.assignmentId,
        title: options.title,
        unmatched: options.unmatched ?? [],
        studentId: options.student.student_id,
        submissionId: options.student.submission_id,
      }),
    });
  } catch (error) {
    unsubscribe();
    await session.shutdown().catch(() => undefined);
    await updateWorkbenchSession(options.assignmentId, realSessionId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    await setStudentProcessing({
      assignmentId: options.assignmentId,
      studentId: options.student.student_id,
      status: "submitted",
    }).catch(() => undefined);
    throw error;
  }
  return {
    sessionId: realSessionId,
    session,
    readFailure: () => failure,
    lastActivity: () => lastActivity,
    unsubscribe,
  };
}

async function runStudentWorkers(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  students: ProcessingStudent[];
  startedAt: string;
  unmatched?: { filename: string; reason: string }[];
}) {
  getActiveGradingAssignments().add(options.assignmentId);
  let completedStudents = 0;
  try {
    const { failed } = await runStudentWaves({
      items: options.students,
      groupPrefix: "marker",
      worker: async ({ item, groupId, agentIndex, attempt }) => {
        const worker = await startStudentWorker({
          ...options,
          student: item,
          groupId,
          agentIndex,
          attempt,
        });
        try {
          await waitForStudentWorker(worker, "Marker 单个学生批改");
          const state = await readProcessingState(options.assignmentId);
          const current = state.students.find((student) => student.student_id === item.student_id);
          if (!current?.grading_complete) {
            throw new Error("Marker 已结束但该生批改尚未完成");
          }
          await setStudentProcessing({
            assignmentId: options.assignmentId,
            studentId: item.student_id,
            status: "graded",
          });
          await updateWorkbenchSession(options.assignmentId, worker.sessionId, { status: "completed" })
            .catch((error) => console.error("[minerva] failed to update Marker workbench session:", error));
          completedStudents += 1;
          await upsertGradingRun({
            assignmentId: options.assignmentId,
            sessionId: worker.sessionId,
            title: options.title,
            startedAt: options.startedAt,
            status: "running",
            completedStudents,
            totalStudents: options.students.length,
          });
        } catch (error) {
          await worker.session.shutdown().catch(() => undefined);
          await updateWorkbenchSession(options.assignmentId, worker.sessionId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
          await setStudentProcessing({
            assignmentId: options.assignmentId,
            studentId: item.student_id,
            status: "submitted",
          }).catch(() => undefined);
          throw error;
        }
      },
    });
    if (failed.length > 0) {
      await upsertGradingRun({
        assignmentId: options.assignmentId,
        sessionId: `grading-${options.assignmentId}`,
        title: options.title,
        startedAt: options.startedAt,
        status: "waiting_for_reconnect",
        completedStudents,
        totalStudents: options.students.length,
        error: `${failed.length} 名学生批改在 5 次重连后仍未完成，将在服务重连后继续`,
      });
      return;
    }
    await finalizeAssignment(options.assignmentId);
    await upsertGradingRun({
      assignmentId: options.assignmentId,
      sessionId: `grading-${options.assignmentId}`,
      title: options.title,
      startedAt: options.startedAt,
      status: "completed",
      completedStudents,
      totalStudents: options.students.length,
    });
    await startEvaluatorAfterGrading({
      cwd: options.cwd,
      assignmentId: options.assignmentId,
      title: options.title,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await upsertGradingRun({
      assignmentId: options.assignmentId,
      sessionId: `grading-${options.assignmentId}`,
      title: options.title,
      startedAt: options.startedAt,
      status: "waiting_for_reconnect",
      completedStudents,
      totalStudents: options.students.length,
      error: `自动批改中断：${reason}。已完成的学生结果已保留，将在服务重连后继续`,
    });
  } finally {
    getActiveGradingAssignments().delete(options.assignmentId);
  }
}

export async function startGradingSession(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  unmatched?: { filename: string; reason: string }[];
}) {
  if (!existsSync(options.cwd)) throw new Error(`Directory does not exist: ${options.cwd}`);
  if (isGradingPipelineActive(options.assignmentId)) {
    return { sessionId: `grading-${options.assignmentId}`, assignmentId: options.assignmentId };
  }
  const state = await readProcessingState(options.assignmentId);
  const students = state.students.filter((student) => !student.grading_complete);
  const startedAt = new Date().toISOString();
  if (!students.length) {
    if (state.students.length === 0) throw new Error("没有可批改的学生提交");
    await finalizeAssignment(options.assignmentId);
    await startEvaluatorAfterGrading({
      cwd: options.cwd,
      assignmentId: options.assignmentId,
      title: options.title,
    });
    const run = await upsertGradingRun({
      assignmentId: options.assignmentId,
      sessionId: `grading-${options.assignmentId}`,
      title: options.title,
      startedAt,
      status: "completed",
      completedStudents: state.students.length,
      totalStudents: state.students.length,
    });
    return { sessionId: run.sessionId, assignmentId: options.assignmentId, run };
  }
  allowFileRoot(options.cwd);
  invalidateSessionListCache();
  const run: GradingRunRecord = await upsertGradingRun({
    assignmentId: options.assignmentId,
    sessionId: `grading-${options.assignmentId}`,
    title: options.title,
    startedAt,
    status: "running",
    completedStudents: state.students.length - students.length,
    totalStudents: state.students.length,
  });
  void runStudentWorkers({ ...options, students, startedAt }).catch((error) => {
    console.error("[minerva] grading pipeline failed unexpectedly:", error instanceof Error ? error.message : error);
  });
  return { sessionId: run.sessionId, assignmentId: options.assignmentId, run };
}
