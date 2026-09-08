import { randomUUID } from "node:crypto";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const active = new Set<string>();
const baseUrl = () => (process.env.MINERVA_DATA_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
async function request(path: string, payload?: unknown) {
  const response = await fetch(`${baseUrl()}${path}`, { cache: "no-store", ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
  return body;
}

export async function startSummarizer(options: { cwd: string; assignmentId: string; title: string }) {
  if (active.has(options.assignmentId)) return;
  active.add(options.assignmentId);
  let reportId: string | undefined;
  try {
    const report = await request(`/api/assignments/${options.assignmentId}/summary/prepare`, {});
    reportId = report.id;
    if (report.status === "completed") return;
    await request(`/api/summary/${reportId}`, { status: "running" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { startRpcSession } = await import("./rpc-manager");
      const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd, {
        summarizer: { assignmentId: options.assignmentId, reportId: report.id, title: options.title },
      });
      await registerWorkbenchSession({
        assignmentId: options.assignmentId,
        title: options.title,
        session: {
          sessionId: realSessionId,
          role: "summarizer",
          label: attempt === 0 ? "生成作业报告" : "生成作业报告 · 自动重试",
        },
      }).catch((error) => console.error("[minerva] failed to register Summarizer workbench session:", error));
      invalidateSessionListCache();
      let failure: string | null = null;
      const unsubscribe = session.onEvent(event => { if (event.type === "prompt_error") failure = typeof event.errorMessage === "string" ? event.errorMessage : "模型连接失败"; });
      try {
        await session.send({ type: "prompt", message: `为作业“${options.title}”生成报告。先读 statistics，再分页读完 students。仅报告有价值的学生变化，允许没有学生重点。最后调用 write_minerva 保存。` });
        const deadline = Date.now() + 10 * 60 * 1000;
        while (session.isRunning()) {
          if (Date.now() > deadline) throw new Error("报告生成超过10分钟");
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        const current = await request(`/api/assignments/${options.assignmentId}/summary`);
        if (current.report?.id === report.id && current.report.status === "completed") {
          await updateWorkbenchSession(options.assignmentId, realSessionId, { status: "completed" }).catch(() => undefined);
          return;
        }
        throw new Error(failure || "模型结束但未成功保存报告");
      } catch (error) {
        await updateWorkbenchSession(options.assignmentId, realSessionId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        if (attempt === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      } finally {
        unsubscribe();
        await session.shutdown().catch(() => undefined);
      }
    }
  } catch (error) {
    if (reportId) await request(`/api/summary/${reportId}`, { status: "failed", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    console.error("[summarizer]", error);
  } finally { active.delete(options.assignmentId); }
}
