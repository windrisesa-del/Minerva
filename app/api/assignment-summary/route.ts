export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("assignment_id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "作业ID无效" }, { status: 400 });
  try {
    const base = (process.env.MINERVA_DATA_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
    const response = await fetch(`${base}/api/assignments/${id}/summary`, { cache: "no-store" });
    return Response.json(await response.json(), { status: response.status });
  } catch { return Response.json({ error: "报告服务暂时不可用" }, { status: 502 }); }
}
