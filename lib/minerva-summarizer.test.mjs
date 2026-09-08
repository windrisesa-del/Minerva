import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createSummarizerExtension } = await createJiti(import.meta.url).import("./minerva-summarizer.ts");

test("summary tools bind report ID and require contiguous full student coverage", async t => {
  const tools = new Map();
  createSummarizerExtension({ assignmentId: "a", reportId: "fixed-report", title: "test" }).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); urls.push(url);
    if (options?.method === "POST") return Response.json({ status: "completed" });
    const first = url.searchParams.get("resource") === "students" && url.searchParams.get("offset") === "0";
    return Response.json({ records: [{}], has_more: first, next_offset: first ? 1 : null });
  };
  t.after(() => { globalThis.fetch = original; });
  const read = tools.get("read_minerva"), write = tools.get("write_minerva");
  assert.equal((await write.execute("x", { narrative: {} })).isError, true);
  assert.equal((await read.execute("x", { resource: "students", offset: 20 })).isError, true);
  await read.execute("x", { resource: "statistics" });
  await read.execute("x", { resource: "students", offset: 0 });
  await read.execute("x", { resource: "evidence", student_id: "s" });
  assert.equal((await write.execute("x", { narrative: {} })).isError, true);
  await read.execute("x", { resource: "students", offset: 1 });
  assert.equal((await write.execute("x", { narrative: {} })).isError, false);
  assert.ok(urls.every(url => url.pathname.startsWith("/api/summary/fixed-report")));
  assert.equal((await read.execute("x", { resource: "evidence_buffer" })).isError, true);
});
