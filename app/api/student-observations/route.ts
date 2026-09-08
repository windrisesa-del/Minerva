import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

async function proxyJson(target: string, init?: RequestInit) {
  try {
    const upstream = await fetch(target, {
      cache: "no-store",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      ...init,
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
  const studentId = request.nextUrl.searchParams.get("studentId") ?? "";
  if (!UUID_PATTERN.test(studentId)) {
    return NextResponse.json({ error: "学生编号格式无效" }, { status: 400 });
  }
  const [description, buffer] = await Promise.all([
    fetch(`${dataApiUrl()}/api/minerva/read?resource=student_description&student_id=${encodeURIComponent(studentId)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
    fetch(`${dataApiUrl()}/api/minerva/read?resource=evidence_buffer&student_id=${encodeURIComponent(studentId)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
  ]);
  const descriptionBody = await description.json().catch(() => ({}));
  const bufferBody = await buffer.json().catch(() => ({}));
  if (!description.ok) {
    return NextResponse.json(descriptionBody, { status: description.status });
  }
  return NextResponse.json({
    description: descriptionBody.records?.[0] ?? null,
    evidence_buffer: bufferBody.records?.[0] ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  let payload: {
    studentId?: string;
    fields?: Record<string, unknown>;
    items?: unknown[];
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容无效" }, { status: 400 });
  }
  const studentId = payload.studentId ?? "";
  if (!UUID_PATTERN.test(studentId)) {
    return NextResponse.json({ error: "学生编号格式无效" }, { status: 400 });
  }
  if (payload.fields && Object.keys(payload.fields).length > 0) {
    return proxyJson(`${dataApiUrl()}/api/minerva/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        kind: "student_description",
        student_id: studentId,
        authored_by: "teacher",
        fields: payload.fields,
      }),
    });
  }
  if (Array.isArray(payload.items)) {
    return proxyJson(`${dataApiUrl()}/api/minerva/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        kind: "evidence_buffer",
        student_id: studentId,
        items: payload.items,
      }),
    });
  }
  return NextResponse.json({ error: "没有可保存的观察内容" }, { status: 400 });
}
