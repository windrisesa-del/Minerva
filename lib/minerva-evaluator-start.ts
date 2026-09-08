import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { allowFileRoot } from "./file-access";
import { readEvaluatorRuns, upsertEvaluatorRun } from "./evaluator-run-store";
import { buildEvaluatorUserPrompt } from "./minerva-evaluator";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const STUDENT_PAGE_SIZE = 25;
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

type GradedStudent = {
  student_id: string;
  student_name?: string;
  submission_id: string;
};

type EvaluatorWorker = {
  sessionId: string;
  session: {
    isRunning(): boolean;
    onEvent(listener: (event: { type?: string; errorMessage?: string }) => void): () => void;
    send(command: Record<string, unknown>): Promise<unknown>;
    shutdown(): Promise<void>;
  };
  readFailure(): string | null;
  unsubscribe(): void;
};

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

export async function discardFailedEvaluatorAssignment(assignmentId: string): Promise<void> {
  const response = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: `HTTP ${response.status}` })) as { detail?: string };
    throw new Error(payload.detail || `清理失败 HTTP ${response.status}`);
  }
}

declare global {
  var __minervaActiveEvaluatorAssignments: Set<string> | undefined;
}

function getActiveEvaluatorAssignments(): Set<string> {
  if (!globalThis.__minervaActiveEvaluatorAssignments) {
    globalThis.__minervaActiveEvaluatorAssignments = new Set<string>();
  }
  return globalThis.__minervaActiveEvaluatorAssignments;
}

export function isEvaluatorPipelineActive(assignmentId: string): boolean {
  return getActiveEvaluatorAssignments().has(assignmentId);
}

async function recordEvaluatorFailure(options: {
  assignmentId: string;
  sessionId: string;
  title: string;
  startedAt: string;
  completedStudents: number;
  totalStudents: number;
  reason: string;
}) {
  let cleanupError = "";
  let cleanupPending = false;
  try {
    await discardFailedEvaluatorAssignment(options.assignmentId);
  } catch (error) {
    cleanupPending = true;
    cleanupError = `；清理数据暂未完成：${error instanceof Error ? error.message : String(error)}`;
  }
  await upsertEvaluatorRun({
    assignmentId: options.assignmentId,
    sessionId: options.sessionId,
    title: options.title,
    startedAt: options.startedAt,
    status: "failed",
    completedStudents: options.completedStudents,
    totalStudents: options.totalStudents,
    error: cleanupPending
      ? `学生描述自动更新失败：${options.reason}${cleanupError}。系统恢复后会继续清理，请勿使用这份作业`
      : `学生描述自动更新失败：${options.reason}。本次 Evaluator 更改和导入数据已清理，请重新导入`,
    failedAt: new Date().toISOString(),
    ...(cleanupPending ? { cleanupPending: true } : {}),
  });
}

export async function readGradedStudents(assignmentId: string): Promise<GradedStudent[]> {
  const students: GradedStudent[] = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      resource: "graded_students",
      assignment_id: assignmentId,
      limit: String(STUDENT_PAGE_SIZE),
      offset: String(offset),
    });
    const response = await fetch(`${dataApiUrl()}/api/minerva/read?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({ detail: "已批改学生列表返回了无效响应" })) as {
      records?: unknown[];
      has_more?: boolean;
      next_offset?: number | null;
      detail?: string;
    };
    if (!response.ok) throw new Error(payload.detail || `读取已批改学生失败 HTTP ${response.status}`);
    const records = (payload.records ?? []).filter((record): record is GradedStudent => (
      typeof record === "object"
      && record !== null
      && typeof (record as GradedStudent).student_id === "string"
      && typeof (record as GradedStudent).submission_id === "string"
    ));
    students.push(...records);
    if (!payload.has_more || typeof payload.next_offset !== "number") break;
    offset = payload.next_offset;
  }
  return students;
}

async function startStudentEvaluator(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  student: GradedStudent;
}): Promise<EvaluatorWorker> {
  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd, {
    evaluator: {
      assignmentId: options.assignmentId,
      title: options.title,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
    },
  });
  await registerWorkbenchSession({
    assignmentId: options.assignmentId,
    title: options.title,
    session: {
      sessionId: realSessionId,
      role: "evaluator",
      label: options.student.student_name ? `更新画像 · ${options.student.student_name}` : `更新画像 · ${options.student.student_id.slice(0, 8)}`,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
    },
  }).catch((error) => console.error("[minerva] failed to register Evaluator workbench session:", error));
  let failure: string | null = null;
  const unsubscribe = session.onEvent((event) => {
    if (event.type === "prompt_error") {
      failure = typeof event.errorMessage === "string" && event.errorMessage
        ? event.errorMessage
        : "Evaluator 的 LLM 连接中断";
    }
  });
  try {
    await session.send({
      type: "prompt",
      message: buildEvaluatorUserPrompt({
        assignmentId: options.assignmentId,
        title: options.title,
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
    throw error;
  }
  return {
    sessionId: realSessionId,
    session,
    readFailure: () => failure,
    unsubscribe,
  };
}

async function waitForWorker(worker: EvaluatorWorker): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  try {
    while (worker.session.isRunning()) {
      if (Date.now() >= deadline) throw new Error("Evaluator 单个学生处理超过 10 分钟");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    const failure = worker.readFailure();
    if (failure) throw new Error(failure);
  } finally {
    worker.unsubscribe();
  }
}

async function runStudentEvaluators(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  students: GradedStudent[];
  firstWorker: EvaluatorWorker;
  startedAt: string;
}) {
  let currentWorker = options.firstWorker;
  let completedStudents = 0;
  try {
    for (let index = 0; index < options.students.length; index += 1) {
      if (index > 0) {
        currentWorker = await startStudentEvaluator({
          cwd: options.cwd,
          assignmentId: options.assignmentId,
          title: options.title,
          student: options.students[index],
        });
      }
      await upsertEvaluatorRun({
        assignmentId: options.assignmentId,
        sessionId: currentWorker.sessionId,
        title: options.title,
        startedAt: options.startedAt,
        status: "running",
        completedStudents,
        totalStudents: options.students.length,
      });
      await waitForWorker(currentWorker);
      const student = options.students[index];
      const receiptResponse = await fetch(`${dataApiUrl()}/api/assignments/${options.assignmentId}/evaluation/${student.student_id}`, { cache: "no-store" });
      const receipt = await receiptResponse.json();
      if (!receiptResponse.ok || !receipt.completed || receipt.submission_id !== student.submission_id) {
        throw new Error("Evaluator 已结束但未保存明确的评估完成记录");
      }
      await updateWorkbenchSession(options.assignmentId, currentWorker.sessionId, { status: "completed" })
        .catch((error) => console.error("[minerva] failed to update Evaluator workbench session:", error));
      completedStudents += 1;
    }
    await upsertEvaluatorRun({
      assignmentId: options.assignmentId,
      sessionId: currentWorker.sessionId,
      title: options.title,
      startedAt: options.startedAt,
      status: "completed",
      completedStudents,
      totalStudents: options.students.length,
    });
    const { startSummarizer } = await import("./minerva-summarizer-start");
    void startSummarizer(options);
  } catch (error) {
    await currentWorker.session.shutdown().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    await updateWorkbenchSession(options.assignmentId, currentWorker.sessionId, { status: "failed", error: reason })
      .catch(() => undefined);
    await recordEvaluatorFailure({
      assignmentId: options.assignmentId,
      sessionId: currentWorker.sessionId,
      title: options.title,
      startedAt: options.startedAt,
      completedStudents,
      totalStudents: options.students.length,
      reason,
    });
  }
}

export async function startEvaluatorSession(options: {
  cwd: string;
  assignmentId: string;
  title: string;
}): Promise<{ sessionId: string; assignmentId: string }> {
  if (!existsSync(options.cwd)) throw new Error(`Directory does not exist: ${options.cwd}`);
  const students = await readGradedStudents(options.assignmentId);
  if (!students.length) throw new Error("没有可供 Evaluator 处理的有效 AI 批改结果");
  const startedAt = new Date().toISOString();
  const firstWorker = await startStudentEvaluator({ ...options, student: students[0] });
  allowFileRoot(options.cwd);
  invalidateSessionListCache();
  await upsertEvaluatorRun({
    assignmentId: options.assignmentId,
    sessionId: firstWorker.sessionId,
    title: options.title,
    startedAt,
    status: "running",
    completedStudents: 0,
    totalStudents: students.length,
  });
  getActiveEvaluatorAssignments().add(options.assignmentId);
  void runStudentEvaluators({ ...options, students, firstWorker, startedAt })
    .catch((error) => {
      console.error("[minerva] evaluator pipeline failed unexpectedly:", error instanceof Error ? error.message : error);
    })
    .finally(() => getActiveEvaluatorAssignments().delete(options.assignmentId));
  return { sessionId: firstWorker.sessionId, assignmentId: options.assignmentId };
}

const startingAssignments = new Set<string>();

export async function startEvaluatorAfterGrading(options: {
  cwd: string;
  assignmentId: string;
  title: string;
}): Promise<void> {
  if (startingAssignments.has(options.assignmentId)) return;
  startingAssignments.add(options.assignmentId);
  try {
    const response = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(options.assignmentId)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ detail: `HTTP ${response.status}` })) as { detail?: string };
      throw new Error(payload.detail || `读取作业失败 HTTP ${response.status}`);
    }
    const body = await response.json() as { assignment?: { status?: string } };
    if (body.assignment?.status !== "graded") return;
    const existing = (await readEvaluatorRuns()).find((run) => run.assignmentId === options.assignmentId);
    if (existing?.status === "completed" || existing?.status === "failed") return;
    if (existing?.status === "running") {
      const { getRunningRpcSessionIds } = await import("./rpc-manager");
      if (new Set(getRunningRpcSessionIds()).has(existing.sessionId)) return;
    }
    await startEvaluatorSession(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const existing = (await readEvaluatorRuns()).find((run) => run.assignmentId === options.assignmentId);
    await recordEvaluatorFailure({
      assignmentId: options.assignmentId,
      sessionId: existing?.sessionId || `evaluator-start-${options.assignmentId}`,
      title: options.title,
      startedAt: existing?.startedAt || new Date().toISOString(),
      completedStudents: existing?.completedStudents || 0,
      totalStudents: existing?.totalStudents || 0,
      reason,
    }).catch((cleanupError) => {
      console.error("[minerva] failed to record evaluator cleanup:", cleanupError instanceof Error ? cleanupError.message : cleanupError);
    });
    console.error(
      "[minerva] failed to start evaluator after grading:",
      reason,
    );
  } finally {
    startingAssignments.delete(options.assignmentId);
  }
}
