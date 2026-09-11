import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { assignmentSessionTitle, chunkTranscript, fitTranscriptBlocks, serializeWorkbenchSession } = await createJiti(import.meta.url)
  .import("./assignment-session-finalizer.ts");

test("serializes a worker session with its role, ids, and message order", () => {
  const parts = serializeWorkbenchSession({
    sessionId: "marker-1",
    role: "marker",
    label: "批改 · 学生甲",
    startedAt: "2026-09-08T08:00:00.000Z",
    status: "completed",
    studentId: "student-1",
    submissionId: "submission-1",
  }, [
    { type: "message", message: { role: "user", content: "开始批改" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "完成" }] } },
  ]);
  const joined = parts.join("\n");
  assert.match(joined, /Marker · 批改 · 学生甲/);
  assert.match(joined, /student_id: student-1/);
  assert.ok(joined.indexOf("开始批改") < joined.indexOf("完成"));
});

test("chunks concatenated transcripts without dropping content", () => {
  const parts = ["a".repeat(7), "b".repeat(7), "c".repeat(2)];
  const chunks = chunkTranscript(parts, 10);
  assert.deepEqual(chunks, ["a".repeat(7), "b".repeat(7), "cc"]);
  assert.equal(chunks.join(""), parts.join(""));
});

test("removes large internal payloads and fairly caps compaction input", () => {
  const serialized = serializeWorkbenchSession({
    sessionId: "evaluator-1",
    role: "evaluator",
    label: "更新画像 · 学生甲",
    startedAt: "2026-09-10T08:00:00.000Z",
    status: "completed",
  }, [{
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret".repeat(10_000) }],
      details: { duplicate: "x".repeat(20_000) },
    },
  }]);
  const text = serialized.join("\n");
  assert.doesNotMatch(text, /secretsecret/);
  assert.doesNotMatch(text, /"duplicate"/);

  const fitted = fitTranscriptBlocks([
    ["===== Adapter =====", "a".repeat(20_000)],
    ["===== Summarizer =====", "z".repeat(20_000)],
  ], 10_000);
  assert.ok(fitted.join("\n").length < 11_000);
  assert.match(fitted[0], /Adapter/);
  assert.match(fitted[1], /Summarizer/);
});

test("uses the assignment date and title for the canonical Pi session", () => {
  assert.equal(assignmentSessionTitle("2026-09-08T08:00:00.000Z", "A组试题"), "2026-09-08 · A组试题");
});

test("keeps the bounded merged session when native compaction fails", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./assignment-session-finalizer.ts", import.meta.url), "utf8"));
  assert.match(source, /workbench compaction failed; keeping bounded merged context/);
  assert.match(source, /compacted = false/);
});
