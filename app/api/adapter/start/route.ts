import { after, NextResponse } from "next/server";
import { runAdapterPipeline, type AdapterSource } from "@/lib/minerva-adapter-start";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      assignmentId?: string;
      title?: string;
      sources?: AdapterSource[];
      unmatched?: { filename: string; reason: string }[];
    };
    const assignmentId = typeof body.assignmentId === "string" ? body.assignmentId : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!UUID_PATTERN.test(assignmentId)) return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
    if (!title) return NextResponse.json({ error: "请填写作业标题" }, { status: 400 });
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const unmatched = Array.isArray(body.unmatched) ? body.unmatched : [];
    after(async () => {
      try {
        await runAdapterPipeline({ assignmentId, title, sources, unmatched });
      } catch (error) {
        console.error(`[minerva] Adapter pipeline failed for ${assignmentId}:`, error);
      }
    });
    return NextResponse.json({ success: true, accepted: true, assignmentId }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
