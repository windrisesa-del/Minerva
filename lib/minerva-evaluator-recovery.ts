import { readEvaluatorRuns, upsertEvaluatorRun, type EvaluatorRunRecord } from "./evaluator-run-store";
import { discardFailedEvaluatorAssignment, isEvaluatorPipelineActive } from "./minerva-evaluator-start";
import { getRunningRpcSessionIds } from "./rpc-manager";

const INTERRUPTED_GRACE_MS = 30_000;

declare global {
  var __minervaEvaluatorCleanupInFlight: Set<string> | undefined;
}

function getCleanupInFlight(): Set<string> {
  if (!globalThis.__minervaEvaluatorCleanupInFlight) {
    globalThis.__minervaEvaluatorCleanupInFlight = new Set<string>();
  }
  return globalThis.__minervaEvaluatorCleanupInFlight;
}

function runAgeMs(run: EvaluatorRunRecord): number {
  const timestamp = Date.parse(run.updatedAt || run.startedAt);
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function cleanupMessage(reason: string, pending: boolean): string {
  if (pending) {
    return `学生描述自动更新中断：${reason}。相关数据暂未清理完成，系统恢复后会继续清理，请勿使用这份作业`;
  }
  return `学生描述自动更新中断：${reason}。本次 Evaluator 更改和导入数据已清理，请重新导入`;
}

async function cleanInterruptedRun(run: EvaluatorRunRecord): Promise<EvaluatorRunRecord> {
  const cleanupInFlight = getCleanupInFlight();
  if (cleanupInFlight.has(run.assignmentId)) return { ...run, cleanupPending: true };
  cleanupInFlight.add(run.assignmentId);
  try {
    await discardFailedEvaluatorAssignment(run.assignmentId);
    return await upsertEvaluatorRun({
      ...run,
      status: "failed",
      error: cleanupMessage("运行进程或 API 服务异常退出", false),
      failedAt: new Date().toISOString(),
      cleanupPending: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return await upsertEvaluatorRun({
      ...run,
      status: "failed",
      error: cleanupMessage(reason, true),
      failedAt: run.failedAt || new Date().toISOString(),
      cleanupPending: true,
    });
  } finally {
    cleanupInFlight.delete(run.assignmentId);
  }
}

export async function reconcileInterruptedEvaluatorRuns(): Promise<Array<EvaluatorRunRecord & { running: boolean }>> {
  const liveSessions = new Set(getRunningRpcSessionIds());
  const runs = await readEvaluatorRuns();
  const reconciled: Array<EvaluatorRunRecord & { running: boolean }> = [];

  for (const original of runs) {
    const live = liveSessions.has(original.sessionId);
    const active = isEvaluatorPipelineActive(original.assignmentId);
    const withinGrace = original.status === "running" && runAgeMs(original) <= INTERRUPTED_GRACE_MS;
    const interrupted = original.status === "running" && !live && !active && !withinGrace;
    let run = original;
    if (interrupted || original.cleanupPending) {
      run = await cleanInterruptedRun(original);
    }
    reconciled.push({
      ...run,
      running: live || active || withinGrace || run.cleanupPending === true,
    });
  }
  return reconciled;
}
