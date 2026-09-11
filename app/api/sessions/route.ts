import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { reconcileInterruptedEvaluatorRuns } from "@/lib/minerva-evaluator-recovery";
import { readAssignmentWorkbenches } from "@/lib/assignment-workbench-store";
import { readSessionArchiveIndex } from "@/lib/session-archive-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    void reconcileInterruptedEvaluatorRuns().catch((error) => {
      console.error("[minerva] failed to reconcile interrupted evaluator runs:", error);
    });
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions, workbenches, archiveIndex] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
      readAssignmentWorkbenches().catch(() => []),
      readSessionArchiveIndex(),
    ]);
    const internalSessionIds = new Set(workbenches.flatMap((workbench) => [
      ...workbench.sessions.map((session) => session.sessionId),
      ...(workbench.currentSession ? [workbench.currentSession.sessionId] : []),
    ]));
    const mergedSessions = mergeSessionLists(persistedSessions, runtimeSessions).map((session) => (
      internalSessionIds.has(session.id) ? { ...session, minervaInternal: true } : session
    ));
    const archivedIds = new Set(Object.keys(archiveIndex.sessions));
    const sessions = mergedSessions.filter((session) => !archivedIds.has(session.id));
    const archivedSessions = mergedSessions
      .filter((session) => archivedIds.has(session.id))
      .map((session) => ({ ...session, archivedAt: archiveIndex.sessions[session.id]?.archivedAt }));
    return NextResponse.json(
      {
        sessions,
        archivedSessions,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
