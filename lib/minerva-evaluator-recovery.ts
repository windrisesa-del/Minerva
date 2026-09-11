import { readEvaluatorRuns, upsertEvaluatorRun, type EvaluatorRunRecord } from "./evaluator-run-store";
import { readGradingRuns, upsertGradingRun } from "./grading-run-store";
import { isEvaluatorPipelineActive, startEvaluatorAfterGrading } from "./minerva-evaluator-start";
import { isGradingPipelineActive, startGradingSession } from "./minerva-grading-start";
import { resetStuckGradingStudents } from "./minerva-processing";
import { resolveMinervaProjectRoot } from "./minerva-adapter-start";
import { getRunningRpcSessionIds } from "./rpc-manager";

const INTERRUPTED_GRACE_MS = 30_000;
const DEFAULT_DATA_API = "http://127.0.0.1:8000";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

async function readArchivedAssignmentIds(): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${dataApiUrl()}/api/assignments`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { assignments?: Array<{ id?: unknown; status?: unknown }> };
    return new Set((body.assignments ?? [])
      .filter((assignment) => assignment.status === "archived" && typeof assignment.id === "string")
      .map((assignment) => assignment.id as string));
  } catch {
    return null;
  }
}

function runAgeMs(run: { updatedAt?: string; startedAt: string }): number {
  const timestamp = Date.parse(run.updatedAt || run.startedAt);
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

export function shouldResume(run: { status?: string; sessionId: string; startedAt: string; updatedAt?: string; hostPid?: number }, live: boolean, active: boolean): boolean {
  if (active) return false;
  if (run.status === "completed" || run.status === "failed" || run.status === "archived") return false;
  const newProcess = run.hostPid !== process.pid;
  if (run.status === "waiting_for_reconnect") return newProcess;
  const withinGrace = run.status === "running" && runAgeMs(run) <= INTERRUPTED_GRACE_MS;
  return run.status === "running" && !live && !withinGrace;
}

export function archivedRunRecord<T extends {
  status?: string;
  error?: string;
  failedAt?: string;
  cleanupPending?: boolean;
}>(run: T): Omit<T, "status" | "error" | "failedAt" | "cleanupPending"> & { status: "archived" } {
  const { status: _status, error: _error, failedAt: _failedAt, cleanupPending: _cleanupPending, ...rest } = run;
  return { ...rest, status: "archived" };
}

async function resumeAssignment(run: { assignmentId: string; title: string }): Promise<void> {
  const cwd = resolveMinervaProjectRoot();
  await resetStuckGradingStudents(run.assignmentId);
  await startGradingSession({
    cwd,
    assignmentId: run.assignmentId,
    title: run.title,
  });
}

export async function reconcileInterruptedEvaluatorRuns(): Promise<Array<EvaluatorRunRecord & { running: boolean }>> {
  const liveSessions = new Set(getRunningRpcSessionIds());
  const archivedAssignmentIds = await readArchivedAssignmentIds();
  const gradingRuns = await readGradingRuns();
  for (const run of gradingRuns) {
    if (archivedAssignmentIds?.has(run.assignmentId)) {
      await upsertGradingRun(archivedRunRecord(run));
      continue;
    }
    const live = liveSessions.has(run.sessionId);
    const active = isGradingPipelineActive(run.assignmentId);
    if (!shouldResume(run, live, active)) continue;
    try {
      await resumeAssignment(run);
    } catch (error) {
      await upsertGradingRun({
        ...run,
        status: "waiting_for_reconnect",
        error: `服务重连后续跑失败：${error instanceof Error ? error.message : String(error)}。将在下次服务启动后继续`,
      });
    }
  }

  const runs = await readEvaluatorRuns();
  const reconciled: Array<EvaluatorRunRecord & { running: boolean }> = [];
  for (const original of runs) {
    if (archivedAssignmentIds?.has(original.assignmentId)) {
      const run = original.status === "archived"
        ? original
        : await upsertEvaluatorRun(archivedRunRecord(original));
      reconciled.push({ ...run, running: false });
      continue;
    }
    const live = liveSessions.has(original.sessionId);
    const active = isEvaluatorPipelineActive(original.assignmentId);
    let run = original;
    if (shouldResume(original, live, active) && !isGradingPipelineActive(original.assignmentId)) {
      try {
        const cwd = resolveMinervaProjectRoot();
        await startEvaluatorAfterGrading({
          cwd,
          assignmentId: original.assignmentId,
          title: original.title,
        });
        run = (await readEvaluatorRuns()).find((item) => item.assignmentId === original.assignmentId) ?? original;
      } catch (error) {
        run = await upsertEvaluatorRun({
          ...original,
          status: "waiting_for_reconnect",
          error: `学生描述将在服务重连后继续：${error instanceof Error ? error.message : String(error)}`,
          failedAt: original.failedAt || new Date().toISOString(),
          cleanupPending: false,
        });
      }
    }
    reconciled.push({
      ...run,
      running: live || active || run.status === "running",
    });
  }
  return reconciled;
}
