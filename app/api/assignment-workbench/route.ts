import { NextResponse } from "next/server";
import { readAssignmentWorkbench, readAssignmentWorkbenches, updateAssignmentWorkbench, type AssignmentWorkbenchRecord } from "@/lib/assignment-workbench-store";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { finalizeAssignmentSession } from "@/lib/assignment-session-finalizer";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

function displayTitle(workbench: AssignmentWorkbenchRecord): string {
  const date = new Date(workbench.createdAt);
  const dateText = Number.isNaN(date.getTime())
    ? workbench.createdAt.slice(0, 10)
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
  return `${dateText} · ${workbench.title}`;
}

export function workbenchProcessingFailed(workbench: AssignmentWorkbenchRecord): boolean {
  const processingCompleted = workbench.sessions.some((session) => (
    session.role === "summarizer" && session.status === "completed"
  ));
  return !processingCompleted && workbench.sessions.some((session) => session.status === "failed");
}

export async function GET(request: Request) {
  const assignmentId = new URL(request.url).searchParams.get("assignment_id");
  if (!assignmentId) {
    try {
      const running = new Set(getRunningRpcSessionIds());
      const summaries = (await readAssignmentWorkbenches())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((workbench) => ({
          assignmentId: workbench.assignmentId,
          title: workbench.title,
          displayTitle: displayTitle(workbench),
          createdAt: workbench.createdAt,
          updatedAt: workbench.updatedAt,
          sessionCount: workbench.sessions.length,
          running: workbench.sessions.some((session) => running.has(session.sessionId)),
          failed: workbenchProcessingFailed(workbench),
          archivedAt: workbench.archivedAt,
        }));
      return NextResponse.json({
        workbenches: summaries.filter((workbench) => !workbench.archivedAt),
        archivedWorkbenches: summaries.filter((workbench) => Boolean(workbench.archivedAt)),
      }, { headers: { "Cache-Control": "no-store" } });
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
        currentSession: workbench.currentSession ? {
          ...workbench.currentSession,
          running: running.has(workbench.currentSession.sessionId),
        } : undefined,
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

export async function PATCH(request: Request) {
  const assignmentId = new URL(request.url).searchParams.get("assignment_id");
  if (!assignmentId || !UUID_PATTERN.test(assignmentId)) {
    return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
  }
  try {
    const body = await request.json() as { title?: unknown; archived?: unknown };
    const hasTitle = typeof body.title === "string";
    const hasArchived = typeof body.archived === "boolean";
    if (!hasTitle && !hasArchived) {
      return NextResponse.json({ error: "缺少可更新的字段" }, { status: 400 });
    }
    const title = hasTitle ? (body.title as string).trim() : undefined;
    if (hasTitle && !title) {
      return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    }
    if (body.archived === true) {
      const workbench = await readAssignmentWorkbench(assignmentId);
      if (!workbench) return NextResponse.json({ error: "未找到批改工作台" }, { status: 404 });
      const running = new Set(getRunningRpcSessionIds());
      if (workbench.sessions.some((session) => running.has(session.sessionId))) {
        return NextResponse.json({ error: "正在处理的批改工作台无法归档" }, { status: 409 });
      }
    }
    const workbench = await updateAssignmentWorkbench(assignmentId, {
      ...(title !== undefined ? { title } : {}),
      ...(hasArchived ? { archived: body.archived as boolean } : {}),
    });
    if (!workbench) return NextResponse.json({ error: "未找到批改工作台" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      workbench: { ...workbench, displayTitle: displayTitle(workbench) },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const assignmentId = new URL(request.url).searchParams.get("assignment_id");
  if (!assignmentId || !UUID_PATTERN.test(assignmentId)) {
    return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
  }
  try {
    const workbench = await readAssignmentWorkbench(assignmentId);
    if (!workbench) return NextResponse.json({ error: "未找到批改工作台" }, { status: 404 });
    const running = new Set(getRunningRpcSessionIds());
    if (workbench.sessions.some((session) => running.has(session.sessionId))) {
      return NextResponse.json({ error: "作业仍在处理中" }, { status: 409 });
    }
    if (!workbench.sessions.some((session) => session.role === "summarizer" && session.status === "completed")) {
      return NextResponse.json({ error: "作业处理尚未完成" }, { status: 409 });
    }
    const sessionId = await finalizeAssignmentSession({
      cwd: process.cwd(),
      assignmentId,
      title: workbench.title,
      compact: false,
    });
    return NextResponse.json({ ok: true, sessionId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
