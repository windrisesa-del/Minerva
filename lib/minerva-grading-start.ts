import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { allowFileRoot } from "./file-access";
import { upsertGradingRun, type GradingRunRecord } from "./grading-run-store";
import { startEvaluatorAfterGrading } from "./minerva-evaluator-start";
import { buildGradingUserPrompt } from "./minerva-grading";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const STUDENT_PAGE_SIZE = 25;
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

type SubmissionRecord = {
  id: string;
  student_id: string;
  student_name?: string;
};

type GraderWorker = {
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

async function readSubmittedStudents(assignmentId: string): Promise<SubmissionRecord[]> {
  const submissions: SubmissionRecord[] = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      resource: "submissions",
      assignment_id: assignmentId,
      limit: String(STUDENT_PAGE_SIZE),
      offset: String(offset),
    });
    const response = await fetch(`${dataApiUrl()}/api/minerva/read?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({ detail: "学生提交列表返回了无效响应" })) as {
      records?: unknown[];
      has_more?: boolean;
      next_offset?: number | null;
      detail?: string;
    };
    if (!response.ok) throw new Error(payload.detail || `读取学生提交失败 HTTP ${response.status}`);
    const records = (payload.records ?? []).filter((record): record is SubmissionRecord => (
      typeof record === "object"
      && record !== null
      && typeof (record as SubmissionRecord).id === "string"
      && typeof (record as SubmissionRecord).student_id === "string"
    ));
    submissions.push(...records);
    if (!payload.has_more || typeof payload.next_offset !== "number") break;
    offset = payload.next_offset;
  }
  return submissions;
}

async function startStudentWorker(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  submission: SubmissionRecord;
  unmatched?: { filename: string; reason: string }[];
}): Promise<GraderWorker> {
  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd, {
    grader: {
      assignmentId: options.assignmentId,
      title: options.title,
      studentId: options.submission.student_id,
      submissionId: options.submission.id,
    },
  });
  await registerWorkbenchSession({
    assignmentId: options.assignmentId,
    title: options.title,
    session: {
      sessionId: realSessionId,
      role: "marker",
      label: options.submission.student_name ? `批改 · ${options.submission.student_name}` : `批改 · ${options.submission.student_id.slice(0, 8)}`,
      studentId: options.submission.student_id,
      submissionId: options.submission.id,
    },
  }).catch((error) => console.error("[minerva] failed to register Marker workbench session:", error));
  let failure: string | null = null;
  const unsubscribe = session.onEvent((event) => {
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
        studentId: options.submission.student_id,
        submissionId: options.submission.id,
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

async function waitForWorker(worker: GraderWorker): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  try {
    while (worker.session.isRunning()) {
      if (Date.now() >= deadline) throw new Error("Marker 单个学生批改超过 10 分钟");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    const failure = worker.readFailure();
    if (failure) throw new Error(failure);
  } finally {
    worker.unsubscribe();
  }
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

async function discardFailedAssignment(assignmentId: string): Promise<void> {
  const response = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: `HTTP ${response.status}` })) as { detail?: string };
    throw new Error(payload.detail || `清理失败 HTTP ${response.status}`);
  }
}

async function runStudentWorkers(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  submissions: SubmissionRecord[];
  firstWorker: GraderWorker;
  startedAt: string;
  unmatched?: { filename: string; reason: string }[];
}) {
  let currentWorker = options.firstWorker;
  let completedStudents = 0;
  try {
    for (let index = 0; index < options.submissions.length; index += 1) {
      if (index > 0) {
        currentWorker = await startStudentWorker({
          cwd: options.cwd,
          assignmentId: options.assignmentId,
          title: options.title,
          submission: options.submissions[index],
          unmatched: options.unmatched,
        });
      }
      await upsertGradingRun({
        assignmentId: options.assignmentId,
        sessionId: currentWorker.sessionId,
        title: options.title,
        startedAt: options.startedAt,
        status: "running",
        completedStudents,
        totalStudents: options.submissions.length,
      });
      await waitForWorker(currentWorker);
      await updateWorkbenchSession(options.assignmentId, currentWorker.sessionId, { status: "completed" })
        .catch((error) => console.error("[minerva] failed to update Marker workbench session:", error));
      completedStudents += 1;
    }
    await finalizeAssignment(options.assignmentId);
    await upsertGradingRun({
      assignmentId: options.assignmentId,
      sessionId: currentWorker.sessionId,
      title: options.title,
      startedAt: options.startedAt,
      status: "completed",
      completedStudents,
      totalStudents: options.submissions.length,
    });
    await startEvaluatorAfterGrading({
      cwd: options.cwd,
      assignmentId: options.assignmentId,
      title: options.title,
    });
  } catch (error) {
    await currentWorker.session.shutdown().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    await updateWorkbenchSession(options.assignmentId, currentWorker.sessionId, { status: "failed", error: reason })
      .catch(() => undefined);
    let cleanupError = "";
    try {
      await discardFailedAssignment(options.assignmentId);
    } catch (cleanup) {
      cleanupError = `；清理数据失败：${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
    }
    await upsertGradingRun({
      assignmentId: options.assignmentId,
      sessionId: currentWorker.sessionId,
      title: options.title,
      startedAt: options.startedAt,
      status: "failed",
      completedStudents,
      totalStudents: options.submissions.length,
      error: `自动批改失败：${reason}。本次导入数据已清理，请重新导入${cleanupError}`,
      failedAt: new Date().toISOString(),
    });
  }
}

export async function startGradingSession(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  unmatched?: { filename: string; reason: string }[];
}) {
  if (!existsSync(options.cwd)) throw new Error(`Directory does not exist: ${options.cwd}`);
  const submissions = await readSubmittedStudents(options.assignmentId);
  if (!submissions.length) throw new Error("没有可批改的学生提交");
  const startedAt = new Date().toISOString();
  const firstWorker = await startStudentWorker({ ...options, submission: submissions[0] });
  allowFileRoot(options.cwd);
  invalidateSessionListCache();
  const run: GradingRunRecord = await upsertGradingRun({
    assignmentId: options.assignmentId,
    sessionId: firstWorker.sessionId,
    title: options.title,
    startedAt,
    status: "running",
    completedStudents: 0,
    totalStudents: submissions.length,
  });
  void runStudentWorkers({ ...options, submissions, firstWorker, startedAt }).catch((error) => {
    console.error("[minerva] grading pipeline failed unexpectedly:", error instanceof Error ? error.message : error);
  });
  return { sessionId: firstWorker.sessionId, assignmentId: options.assignmentId, run };
}
