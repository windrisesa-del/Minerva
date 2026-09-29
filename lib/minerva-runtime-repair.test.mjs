import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createMinervaDataExtension, markerAssessmentView } = await jiti.import("./minerva-data-extension.ts");
const { buildSummarizerPrompt, createSummarizerExtension } = await jiti.import("./minerva-summarizer.ts");
const { compactEvidenceContext, compactReportContext } = await jiti.import("./minerva-model-context.ts");
const { nextModelFailure, isModelConnectionFailure } = await jiti.import("./minerva-worker-errors.ts");
const { waitForStudentWorker, runStudentWaves } = await jiti.import("./minerva-student-pool.ts");

async function dataTools(options) {
  const tools = new Map();
  await createMinervaDataExtension(options).factory({ registerTool(t) { tools.set(t.name, t); }, on() {}, setActiveTools() {} });
  return tools;
}

test("Marker assessment attachments contain no other answers and only this question's assets", async t => {
  const tools = await dataTools({ graderAssignmentId: "a", graderStudentId: "s", graderSubmissionId: "v" });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  const asset = id => ({ source_path: `/uploads/assignments/a/spec/${id}.png`, mime_type: "image/png" });
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.includes("/api/minerva/read?")) return Response.json({ records: [{ id: "db-q1", question_snapshot: {
      source: "adapter", question_id: "Q1", stem: "diagram question", content: [{ type: "image", asset_id: "one" }],
      reference_solution: { answer: "A" }, spec_attachments: [{ storage_key: "/uploads/assignments/a/spec/assessment.adapter.json", mime_type: "application/json" }],
    } }] });
    if (url.endsWith(".json")) return Response.json({ schema_version: "minerva-assessment/0.1",
      questions: [{ question_id: "Q1", content: [{ type: "image", asset_id: "one" }] }, { question_id: "Q2", secret: "OTHER_QUESTION" }],
      assets: { one: asset("one"), two: asset("two") }, uncertainties: ["COMMON_RUBRIC_WARNING"], student_submissions: [{ student_id: "other", answers: ["OTHER_STUDENT_ANSWER"] }],
    });
    return new Response(new Uint8Array([1]));
  };
  const out = await tools.get("read_minerva").execute("r", { resource: "questions", question_id: "db-q1" });
  assert.doesNotMatch(out.content[0].text, /OTHER_STUDENT_ANSWER|student_submissions|OTHER_QUESTION|two.png/);
  assert.equal(out.content.filter(c => c.type === "image").length, 1);
  assert.equal(requests.some(url => url.endsWith("two.png")), false);
  assert.match(out.content[0].text, /diagram question/);
  assert.match(out.content[0].text, /COMMON_RUBRIC_WARNING/);
});

test("Marker write schema is grading-only and requires the bound student", async () => {
  const write = (await dataTools({ graderAssignmentId: "a", graderStudentId: "s" })).get("write_minerva");
  for (const key of ["fields", "profile_fields", "buffer_items", "change_notes", "authored_by"]) assert.equal(write.parameters.properties[key], undefined);
  assert.ok(write.parameters.required.includes("student_id"));
  assert.ok(write.parameters.required.includes("items"));
  assert.equal(write.parameters.additionalProperties, false);
});

test("Minerva rejected writes throw so Pi persists a real tool error", async () => {
  const write = (await dataTools({ graderAssignmentId: "a", graderStudentId: "s" })).get("write_minerva");
  await assert.rejects(() => write.execute("r", { kind: "grading", assignment_id: "a", student_id: "other", items: [] }), /绑定的 student_id/);
});

test("Evaluator success returns a compact receipt instead of echoed snapshots", async t => {
  const write = (await dataTools({ evaluatorAssignmentId: "a", evaluatorStudentId: "s", evaluatorSubmissionId: "v" })).get("write_minerva");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ kind: "student_observation", student_id: "s", assignment_id: "a", evaluation_complete: true,
    updated_fields: ["knowledge_profile"], changes: [{ before: "HUGE_OLD_PROFILE", after: "HUGE_NEW_PROFILE", path: "/description/knowledge_profile" }] });
  const out = await write.execute("r", { kind: "student_observation", assignment_id: "a", student_id: "s", operations: [], evaluation_complete: true });
  assert.doesNotMatch(out.content[0].text, /HUGE_/);
  assert.equal(JSON.parse(out.content[0].text).evaluation_complete, true);
});

test("report prompt retains full current profile and changed-node evidence without repeating full snapshots", () => {
  const context = { students: [{ description: { current: "CURRENT" }, profile_changes: [{ id: "audit", created_at: "date",
    before: { description: { huge: "OLD_FULL_PROFILE" } }, after: { description: { huge: "DUPLICATED_FULL_PROFILE" },
      changes: [{ path: "/description/knowledge_profile/p", before: { mastery_level: 2 }, after: { mastery_level: 3 }, reason: "evidence" }] } }] }] };
  const before = JSON.stringify(context);
  const out = buildSummarizerPrompt(context);
  assert.doesNotMatch(out, /OLD_FULL_PROFILE|DUPLICATED_FULL_PROFILE/);
  assert.match(out, /CURRENT|audit/);
  assert.match(out, /"mastery_level":2/);
  assert.match(out, /"mastery_level":3/);
  assert.equal(JSON.stringify(context), before);
});

test("Summarizer rejects unsuccessful HTTP writes as actual tool errors", async t => {
  let write;
  createSummarizerExtension({ assignmentId: "a", reportId: "r", title: "t" }).factory({ registerTool(t) { write = t; } });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ detail: "stale report" }, { status: 409 });
  await assert.rejects(() => write.execute("r", { narrative: {} }), /stale report/);
});

test("evidence dictionary preserves every source ID, does not mutate or compress conflicting sources", () => {
  const source = { grading_result_id: "g", assignment_id: "a", submission_id: "s", question_id: "q", answer_attempt_id: "x" };
  const context = { refs: Array.from({ length: 20 }, () => ({ ...source })), evidence: { observation: "keep", source } };
  const original = JSON.stringify(context);
  const projected = compactEvidenceContext(context);
  assert.deepEqual(projected.evidence_sources.g, source);
  assert.deepEqual(projected.refs, Array.from({ length: 20 }, () => ({ grading_result_id: "g" })));
  assert.deepEqual(projected.evidence, { observation: "keep", source: { grading_result_id: "g" } });
  assert.equal(JSON.stringify(context), original);
  const conflict = { refs: [source, { ...source, assignment_id: "other" }] };
  assert.deepEqual(compactEvidenceContext(conflict), conflict);
  const history = { students: [{ profile_changes: [{ before: { description: "only legacy evidence" }, after: {} }] }] };
  assert.deepEqual(compactReportContext(history), history);
  const partial = { students: [{ profile_changes: [{ before: { description: "legacy" }, after: { changes: [{ path: "/description/p" }] } }] }] };
  assert.deepEqual(compactReportContext(partial), partial);
});

test("assessment projection fails closed for unknown questions, missing images and non-question reads", () => {
  const record = { question_snapshot: { source: "adapter", question_id: "Q1" } };
  assert.throws(() => markerAssessmentView({ questions: [] }, record), /缺少当前题目/);
  assert.throws(() => markerAssessmentView({ questions: [{ question_id: "Q1", content: [{ type: "image", asset_id: "missing" }] }], assets: {} }, record), /图片资产缺失/);
  assert.throws(() => markerAssessmentView({ questions: [], student_submissions: [] }, {}), /安全定位/);
});

test("invalid JSON attachment is a sticky Marker failure, not raw text evidence", async t => {
  const tools = await dataTools({ graderAssignmentId: "a", graderStudentId: "s" });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => String(input).includes("/api/minerva/read?")
    ? Response.json({ records: [{ attachments: [{ storage_key: "/uploads/assignments/a/s/broken.json", mime_type: "application/json" }] }] })
    : new Response('{"student_submissions": invalid');
  await assert.rejects(() => tools.get("read_minerva").execute("read", { resource: "answer_attempts", question_id: "q" }), /附件读取失败/);
  await assert.rejects(() => tools.get("write_minerva").execute("write", { kind: "grading", assignment_id: "a", student_id: "s", items: [] }), /禁止写入成绩/);
});

test("a live worker timeout cannot be bypassed by a saved receipt", async () => {
  let verified = false;
  const worker = { session: { isRunning: () => true }, readFailure: () => null, lastActivity: () => 0, unsubscribe() {} };
  await assert.rejects(() => waitForStudentWorker(worker, "test", async () => { verified = true; return true; }), /8 分钟/);
  assert.equal(verified, false);
});

test("terminal model errors surface, healed SDK retries clear the error", () => {
  let error = nextModelFailure(null, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Connection error." } });
  assert.equal(error, "Connection error.");
  assert.equal(nextModelFailure(error, { type: "message_end", message: { role: "toolResult" } }), error);
  error = nextModelFailure(error, { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
  assert.equal(error, null);
  assert.equal(nextModelFailure(error, { type: "prompt_error", errorMessage: "terminated" }), "terminated");
  assert.equal(isModelConnectionFailure(new Error("Connection error.")), true);
  assert.equal(isModelConnectionFailure(new Error("items required")), false);
});

test("a disconnected final reply cannot invalidate a committed current result", async () => {
  let unsubscribed = 0;
  const worker = { session: { isRunning: () => false }, readFailure: () => "Connection error.", lastActivity: () => Date.now(), unsubscribe: () => { unsubscribed++; } };
  await waitForStudentWorker(worker, "test", async () => true);
  await assert.rejects(() => waitForStudentWorker(worker, "test", async () => false), /Connection error/);
  await assert.rejects(() => waitForStudentWorker(worker, "test", async () => { throw new Error("database unavailable"); }), /database unavailable/);
  assert.equal(unsubscribed, 3);
});

test("persistent transport failure defers to reconnect rather than launching fresh worker retries", async () => {
  let attempts = 0;
  const out = await runStudentWaves({ items: ["s"], groupPrefix: "test", retries: 5, retryDelayMs: () => 0,
    shouldRetry: error => !isModelConnectionFailure(error), worker: async () => { attempts++; throw new Error("Connection error."); } });
  assert.equal(attempts, 1);
  assert.deepEqual(out.failed, ["s"]);
});

test("actual Pi loop emits isError=true for a rejected Minerva write", async t => {
  const { agentLoop } = await import("@earendil-works/pi-agent-core");
  const { EventStream } = await import("@earendil-works/pi-ai");
  const write = (await dataTools({ graderAssignmentId: "a", graderStudentId: "s" })).get("write_minerva");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ detail: "grading rejected by backend" }, { status: 409 });
  const model = { id: "mock", name: "mock", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let turn = 0;
  const streamFn = () => {
    const stream = new EventStream(e => e.type === "done", e => e.message);
    const first = turn++ === 0;
    queueMicrotask(() => stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: first ? [{ type: "toolCall", id: "call", name: "write_minerva", arguments: { kind: "grading", assignment_id: "a", student_id: "s", items: [{ question_id: "q", score: 1 }] } }] : [{ type: "text", text: "done" }],
    } }));
    return stream;
  };
  const events = [];
  const loop = agentLoop([{ role: "user", content: "test", timestamp: Date.now() }], { systemPrompt: "", messages: [], tools: [write] }, { model, convertToLlm: x => x }, undefined, streamFn);
  for await (const event of loop) events.push(event);
  assert.equal(events.find(e => e.type === "tool_execution_end").isError, true);
  const result = (await loop.result()).find(m => m.role === "toolResult");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /grading rejected by backend/);
});
