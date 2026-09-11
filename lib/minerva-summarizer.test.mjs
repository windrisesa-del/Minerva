import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { buildSummarizerPrompt, createSummarizerExtension, SUMMARIZER_SYSTEM_PROMPT } = await createJiti(import.meta.url).import("./minerva-summarizer.ts");

test("summarizer consumes evaluator report significance instead of rediscovering students", () => {
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /report_context/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /report_significance/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /include_in_teacher_report=true/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /include_in_teacher_report=false/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /buffer_candidate_ids/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /current_submission_anomaly/);
  assert.doesNotMatch(SUMMARIZER_SYSTEM_PROMPT, /read_minerva/);
});

test("summarizer prompt embeds the frozen context", () => {
  const prompt = buildSummarizerPrompt({ assignment: { title: "函数作业" }, students: [{ student_id: "s1" }] });
  assert.match(prompt, /<report_context>/);
  assert.match(prompt, /函数作业/);
  assert.match(prompt, /"student_id":"s1"/);
});

test("summary exposes only the report-bound write tool", async t => {
  const tools = new Map();
  createSummarizerExtension({ assignmentId: "a", reportId: "fixed-report", title: "test" }).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); urls.push(url);
    assert.equal(options?.method, "POST");
    return Response.json({ status: "completed" });
  };
  t.after(() => { globalThis.fetch = original; });
  assert.deepEqual([...tools.keys()], ["write_minerva"]);
  const write = tools.get("write_minerva");
  assert.equal((await write.execute("x", { narrative: {} })).isError, false);
  assert.ok(urls.every(url => url.pathname.startsWith("/api/summary/fixed-report")));
});
