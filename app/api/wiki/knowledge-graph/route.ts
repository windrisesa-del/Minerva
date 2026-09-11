import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const studentId = request.nextUrl.searchParams.get("studentId") ?? "";
  if (!UUID_PATTERN.test(studentId)) {
    return NextResponse.json({ error: "学生编号格式无效" }, { status: 400 });
  }
  const dataApiUrl = (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
  try {
    const upstream = await fetch(
      `${dataApiUrl}/api/wiki/knowledge-graph/${encodeURIComponent(studentId)}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    const payload = await upstream.json().catch(() => ({ detail: "知识图谱服务返回了无效响应" }));
    return NextResponse.json(payload, {
      status: upstream.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "暂时无法连接本机知识图谱服务。" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
