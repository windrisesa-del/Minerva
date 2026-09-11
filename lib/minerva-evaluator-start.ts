import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { allowFileRoot } from "./file-access";
import { readEvaluatorRuns, upsertEvaluatorRun } from "./evaluator-run-store";
import { buildEvaluatorUserPrompt, type EvaluatorInputContext } from "./minerva-evaluator";
import { readProcessingState } from "./minerva-processing";
import { runStudentWaves, waitForStudentWorker } from "./minerva-student-pool";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const STUDENT_PAGE_SIZE = 25;

type GradedStudent = {
  student_id: string;
  student_name?: string;
  submission_id: string;
};

type EvaluatorWorker = {
  sessionId: string;
  session: {
    isRunning(): boolean;
    onEvent(listener: (event: {
      type?: string;
      errorMessage?: string;
      toolName?: string;
      result?: unknown;
      isError?: boolean;
    }) => void): () => void;
    send(command: Record<string, unknown>): Promise<unknown>;
    shutdown(): Promise<void>;
  };
  readFailure(): string | null;
  readToolFailure(): string | null;
  lastActivity(): number;
  unsubscribe(): void;
};

type EvaluatorFailureKind = "transient" | "stale_context" | "invalid_output";

export class EvaluatorAttemptError extends Error {
  readonly kind: EvaluatorFailureKind;

  constructor(kind: EvaluatorFailureKind, message: string) {
    super(message);
    this.name = "EvaluatorAttemptError";
    this.kind = kind;
  }
}

export function evaluatorFailureIsRetryable(error: unknown): boolean {
  return !(error instanceof EvaluatorAttemptError) || error.kind !== "invalid_output";
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function evaluatorToolFailure(message: string): EvaluatorAttemptError {
  const normalized = message.trim() || "write_minerva 返回了未知错误";
  if (/STUDENT_OBSERVATION_STALE/i.test(normalized)) {
    return new EvaluatorAttemptError("stale_context", normalized);
  }
  if (/(ECONN(?:REFUSED|RESET)|ETIMEDOUT|fetch failed|network|连接.*(?:失败|中断|拒绝)|服务.*(?:不可用|超时)|timed?\s*out|HTTP\s*5\d\d|\b50[234]\b)/i.test(normalized)) {
    return new EvaluatorAttemptError("transient", normalized);
  }
  return new EvaluatorAttemptError("invalid_output", normalized);
}

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
  retryable?: boolean;
}) {
  const retryable = options.retryable !== false;
  await upsertEvaluatorRun({
    assignmentId: options.assignmentId,
    sessionId: options.sessionId,
    title: options.title,
    startedAt: options.startedAt,
    status: retryable ? "waiting_for_reconnect" : "failed",
    completedStudents: options.completedStudents,
    totalStudents: options.totalStudents,
    error: retryable
      ? `学生描述自动更新中断：${options.reason}。已完成的学生结果已保留，将在服务重连后继续`
      : `学生描述自动更新失败：${options.reason}`,
    failedAt: new Date().toISOString(),
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

async function readEvaluatorResource(params: URLSearchParams): Promise<{
  records?: unknown[];
  has_more?: boolean;
  next_offset?: number | null;
  detail?: string;
}> {
  const response = await fetch(`${dataApiUrl()}/api/minerva/read?${params}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({ detail: "Evaluator 输入返回了无效响应" })) as {
    records?: unknown[];
    has_more?: boolean;
    next_offset?: number | null;
    detail?: string;
  };
  if (!response.ok) throw new Error(payload.detail || `读取 Evaluator 输入失败 HTTP ${response.status}`);
  return payload;
}

export async function readEvaluatorInputContext(
  assignmentId: string,
  student: GradedStudent,
): Promise<EvaluatorInputContext> {
  const scoped = {
    assignment_id: assignmentId,
    student_id: student.student_id,
    submission_id: student.submission_id,
  };
  const [profilePage, bufferPage] = await Promise.all([
    readEvaluatorResource(new URLSearchParams({
      resource: "student_description",
      student_id: student.student_id,
    })),
    readEvaluatorResource(new URLSearchParams({
      resource: "evidence_buffer",
      student_id: student.student_id,
    })),
  ]);
  const gradingResults: unknown[] = [];
  let offset = 0;
  while (true) {
    const page = await readEvaluatorResource(new URLSearchParams({
      resource: "grading_results",
      ...scoped,
      grader_type: "ai",
      limit: String(STUDENT_PAGE_SIZE),
      offset: String(offset),
    }));
    gradingResults.push(...(page.records ?? []));
    if (!page.has_more || typeof page.next_offset !== "number") break;
    offset = page.next_offset;
  }
  const profile = profilePage.records?.[0] as {
    description?: unknown;
    teacher_fields?: unknown[];
    updated_at?: string | null;
  } | undefined;
  const buffer = bufferPage.records?.[0] as { items?: unknown[]; updated_at?: string | null } | undefined;
  return {
    schema_version: "minerva-evaluator-context/1",
    ...scoped,
    student_profile: profile?.description ?? {},
    teacher_fields: Array.isArray(profile?.teacher_fields) ? profile.teacher_fields : [],
    evidence_buffer: Array.isArray(buffer?.items) ? buffer.items : [],
    grading_results: gradingResults,
    observation_updated_at: profile?.updated_at ?? buffer?.updated_at ?? null,
  };
}

async function startStudentEvaluator(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  student: GradedStudent;
  groupId: string;
  agentIndex: number;
  attempt: number;
  context: EvaluatorInputContext;
}): Promise<EvaluatorWorker> {
  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd, {
    evaluator: {
      assignmentId: options.assignmentId,
      title: options.title,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
      observationUpdatedAt: options.context.observation_updated_at,
    },
  });
  const retryLabel = options.attempt > 1 ? ` · 重试 ${options.attempt}` : "";
  await registerWorkbenchSession({
    assignmentId: options.assignmentId,
    title: options.title,
    session: {
      sessionId: realSessionId,
      role: "evaluator",
      label: options.student.student_name ? `更新画像 · ${options.student.student_name}${retryLabel}` : `更新画像 · ${options.student.student_id.slice(0, 8)}${retryLabel}`,
      studentId: options.student.student_id,
      submissionId: options.student.submission_id,
      groupId: options.groupId,
      agentIndex: options.agentIndex,
      attempt: options.attempt,
    },
  }).catch((error) => console.error("[minerva] failed to register Evaluator workbench session:", error));
  let failure: string | null = null;
  let toolFailure: string | null = null;
  let lastActivity = Date.now();
  const unsubscribe = session.onEvent((event) => {
    lastActivity = Date.now();
    if (event.type === "prompt_error") {
      failure = typeof event.errorMessage === "string" && event.errorMessage
        ? event.errorMessage
        : "Evaluator 的 LLM 连接中断";
    }
    if (event.type === "tool_execution_end" && event.toolName === "write_minerva") {
      toolFailure = event.isError ? resultText(event.result) || "write_minerva 返回了未知错误" : null;
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
        context: options.context,
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
    readToolFailure: () => toolFailure,
    lastActivity: () => lastActivity,
    unsubscribe,
  };
}

async function hasCurrentEvaluationReceipt(assignmentId: string, student: GradedStudent): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}/evaluation/${encodeURIComponent(student.student_id)}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
  } catch (error) {
    throw new EvaluatorAttemptError(
      "transient",
      `读取评估完成记录失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const payload = await response.json().catch(() => null) as {
    completed?: boolean;
    submission_id?: string | null;
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new EvaluatorAttemptError(
      "transient",
      payload?.detail || `读取评估完成记录失败 HTTP ${response.status}`,
    );
  }
  return payload?.completed === true && payload.submission_id === student.submission_id;
}

async function runStudentEvaluators(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  students: GradedStudent[];
  startedAt: string;
}) {
  let completedStudents = 0;
  try {
    const contexts = new Map(await Promise.all(options.students.map(async (student) => [
      student.student_id,
      await readEvaluatorInputContext(options.assignmentId, student),
    ] as const)));
    const { failed, failures } = await runStudentWaves({
      items: options.students,
      groupPrefix: "evaluator",
      concurrency: 2,
      retries: 3,
      shouldRetry: (error) => evaluatorFailureIsRetryable(error),
      worker: async ({ item, groupId, agentIndex, attempt }) => {
        if (await hasCurrentEvaluationReceipt(options.assignmentId, item)) return;
        const context = attempt === 1
          ? contexts.get(item.student_id)!
          : await readEvaluatorInputContext(options.assignmentId, item);
        const worker = await startStudentEvaluator({
          ...options,
          student: item,
          groupId,
          agentIndex,
          attempt,
          context,
        });
        try {
          await waitForStudentWorker(worker, "Evaluator 单个学生处理");
          const toolFailure = worker.readToolFailure();
          if (toolFailure) throw evaluatorToolFailure(toolFailure);
          if (!await hasCurrentEvaluationReceipt(options.assignmentId, item)) {
            throw new EvaluatorAttemptError("invalid_output", "Evaluator 已结束但未保存明确的评估完成记录");
          }
          await updateWorkbenchSession(options.assignmentId, worker.sessionId, { status: "completed" })
            .catch((error) => console.error("[minerva] failed to update Evaluator workbench session:", error));
          completedStudents += 1;
          await upsertEvaluatorRun({
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
          throw error;
        }
      },
    });
    if (failed.length > 0) {
      const reasons = failures
        .map(({ item, error }) => `${item.student_name || item.student_id.slice(0, 8)}：${error instanceof Error ? error.message : String(error)}`)
        .join("；");
      await recordEvaluatorFailure({
        assignmentId: options.assignmentId,
        sessionId: `evaluator-${options.assignmentId}`,
        title: options.title,
        startedAt: options.startedAt,
        completedStudents,
        totalStudents: options.students.length,
        reason: `${failed.length} 名学生未完成。${reasons}`,
        retryable: failures.every(({ error }) => evaluatorFailureIsRetryable(error)),
      });
      return;
    }
    await upsertEvaluatorRun({
      assignmentId: options.assignmentId,
      sessionId: `evaluator-${options.assignmentId}`,
      title: options.title,
      startedAt: options.startedAt,
      status: "completed",
      completedStudents,
      totalStudents: options.students.length,
    });
    const { startSummarizer } = await import("./minerva-summarizer-start");
    void startSummarizer(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordEvaluatorFailure({
      assignmentId: options.assignmentId,
      sessionId: `evaluator-${options.assignmentId}`,
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
  if (isEvaluatorPipelineActive(options.assignmentId)) {
    return { sessionId: `evaluator-${options.assignmentId}`, assignmentId: options.assignmentId };
  }
  const state = await readProcessingState(options.assignmentId);
  const students = state.students
    .filter((student) => student.grading_complete && !student.evaluation_complete)
    .map((student) => ({
      student_id: student.student_id,
      student_name: student.student_name,
      submission_id: student.submission_id,
    }));
  if (!students.length) {
    if (!state.students.some((student) => student.grading_complete)) {
      throw new Error("没有可供 Evaluator 处理的有效 AI 批改结果");
    }
    const { startSummarizer } = await import("./minerva-summarizer-start");
    void startSummarizer(options);
    return { sessionId: `evaluator-${options.assignmentId}`, assignmentId: options.assignmentId };
  }
  const startedAt = new Date().toISOString();
  allowFileRoot(options.cwd);
  invalidateSessionListCache();
  await upsertEvaluatorRun({
    assignmentId: options.assignmentId,
    sessionId: `evaluator-${options.assignmentId}`,
    title: options.title,
    startedAt,
    status: "running",
    completedStudents: state.students.filter((student) => student.evaluation_complete).length,
    totalStudents: state.students.length,
  });
  getActiveEvaluatorAssignments().add(options.assignmentId);
  void runStudentEvaluators({ ...options, students, startedAt })
    .catch((error) => {
      console.error("[minerva] evaluator pipeline failed unexpectedly:", error instanceof Error ? error.message : error);
    })
    .finally(() => getActiveEvaluatorAssignments().delete(options.assignmentId));
  return { sessionId: `evaluator-${options.assignmentId}`, assignmentId: options.assignmentId };
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
    if (existing?.status === "completed") return;
    if (existing?.status === "running" && isEvaluatorPipelineActive(options.assignmentId)) return;
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
