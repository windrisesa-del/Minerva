import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

async function proxyJson(target: string, init?: RequestInit, timeoutMs = 6_000) {
  const { headers, ...rest } = init ?? {};
  try {
    const upstream = await fetch(target, {
      cache: "no-store",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...rest,
    });
    const payload = await upstream.json().catch(() => ({ detail: "数据服务返回了无效响应" }));
    return NextResponse.json(payload, {
      status: upstream.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "暂时无法连接本机学习数据服务，请确认 FastAPI 已启动。" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export async function GET(request: NextRequest) {
  const resource = request.nextUrl.searchParams.get("resource");
  if (resource === "classes") {
    return proxyJson(`${dataApiUrl()}/api/classes`);
  }

  const assignmentId = request.nextUrl.searchParams.get("id");
  if (assignmentId && !UUID_PATTERN.test(assignmentId)) {
    return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
  }

  const target = assignmentId
    ? `${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}`
    : `${dataApiUrl()}/api/assignments`;
  return proxyJson(target);
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "上传请求必须使用 multipart/form-data" }, { status: 415 });
  }
  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "无法读取上传内容" }, { status: 400 });
  }
  return proxyJson(`${dataApiUrl()}/api/assignments/import`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  }, 120_000);
}

export async function PATCH(request: NextRequest) {
  const assignmentId = request.nextUrl.searchParams.get("id");
  if (!assignmentId || !UUID_PATTERN.test(assignmentId)) {
    return NextResponse.json({ error: "作业编号格式无效" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容无效" }, { status: 400 });
  }
  return proxyJson(`${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
