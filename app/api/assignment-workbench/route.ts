import { NextResponse } from "next/server";
import { readAssignmentWorkbench, readAssignmentWorkbenches, type AssignmentWorkbenchRecord } from "@/lib/assignment-workbench-store";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

function displayTitle(workbench: AssignmentWorkbenchRecord): string {
  const date = new Date(workbench.createdAt);
  const dateText = Number.isNaN(date.getTime())
    ? workbench.createdAt.slice(0, 10)
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
  return `${dateText} · ${workbench.title}`;
}

export async function GET(request: Request) {
  const assignmentId = new URL(request.url).searchParams.get("assignment_id");
  if (!assignmentId) {
    try {
      const running = new Set(getRunningRpcSessionIds());
      const workbenches = (await readAssignmentWorkbenches())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((workbench) => ({
          assignmentId: workbench.assignmentId,
          title: workbench.title,
          displayTitle: displayTitle(workbench),
          createdAt: workbench.createdAt,
          updatedAt: workbench.updatedAt,
          sessionCount: workbench.sessions.length,
          running: workbench.sessions.some((session) => running.has(session.sessionId)),
          failed: workbench.sessions.some((session) => session.status === "failed"),
        }));
      return NextResponse.json({ workbenches }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }
  if (!UUID_PATTERN.test(assignmentId)) {
    return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
  }
  try {
    const workbench = await readAssignmentWorkbench(assignmentId);
    if (!workbench) return NextResponse.json({ workbench: null }, { headers: { "Cache-Control": "no-store" } });
    const running = new Set(getRunningRpcSessionIds());
    return NextResponse.json({
      workbench: {
        ...workbench,
        displayTitle: displayTitle(workbench),
        sessions: workbench.sessions.map((session) => ({
          ...session,
          running: running.has(session.sessionId),
        })),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
