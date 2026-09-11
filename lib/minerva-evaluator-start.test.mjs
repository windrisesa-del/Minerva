import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const {
  discardFailedEvaluatorAssignment,
  evaluatorFailureIsRetryable,
  evaluatorToolFailure,
  readEvaluatorInputContext,
  readGradedStudents,
} = await createJiti(import.meta.url).import("./minerva-evaluator-start.ts");
const { archivedRunRecord, shouldResume } = await createJiti(import.meta.url).import("./minerva-evaluator-recovery.ts");

test("evaluator host paginates every graded student before scheduling", async (t) => {
  const offsets = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    const records = offset === 0
      ? [{ student_id: "student-1", submission_id: "submission-1" }]
      : [{ student_id: "student-2", submission_id: "submission-2" }];
    return new Response(JSON.stringify({
      records,
      has_more: offset === 0,
      next_offset: offset === 0 ? 25 : null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(await readGradedStudents("assignment-1"), [
    { student_id: "student-1", submission_id: "submission-1" },
    { student_id: "student-2", submission_id: "submission-2" },
  ]);
  assert.deepEqual(offsets, [0, 25]);
});

test("evaluator host freezes profile, buffer, and every grade into one context", async (t) => {
  const originalFetch = globalThis.fetch;
  const gradeOffsets = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const resource = url.searchParams.get("resource");
    if (resource === "student_description") {
      return Response.json({ records: [{ description: { learning_trajectory: {} }, teacher_fields: ["learning_trajectory"], updated_at: "2026-09-10T00:00:00Z" }] });
    }
    if (resource === "evidence_buffer") {
      return Response.json({ records: [{ items: [{ candidate_id: "candidate-1" }], updated_at: "2026-09-10T00:00:00Z" }] });
    }
    const offset = Number(url.searchParams.get("offset"));
    gradeOffsets.push(offset);
    return Response.json({
      records: [{ id: offset === 0 ? "grade-1" : "grade-2" }],
      has_more: offset === 0,
      next_offset: offset === 0 ? 25 : null,
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const context = await readEvaluatorInputContext("assignment-1", {
    student_id: "student-1",
    submission_id: "submission-1",
  });
  assert.deepEqual(context.grading_results.map((item) => item.id), ["grade-1", "grade-2"]);
  assert.deepEqual(context.evidence_buffer, [{ candidate_id: "candidate-1" }]);
  assert.equal(context.observation_updated_at, "2026-09-10T00:00:00Z");
  assert.deepEqual(gradeOffsets, [0, 25]);
});

test("evaluator worker loop runs parallel waves and resumes instead of deleting", async () => {
  const source = await readFile(new URL("./minerva-evaluator-start.ts", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("async function runStudentEvaluators"), source.indexOf("export async function startEvaluatorSession"));
  assert.match(loop, /runStudentWaves/);
  assert.match(loop, /groupPrefix: "evaluator"/);
  assert.match(source, /studentId: options\.student\.student_id/);
  assert.match(source, /submissionId: options\.student\.submission_id/);
  assert.doesNotMatch(loop, /await discardFailedEvaluatorAssignment\(options\.assignmentId\)/);
  assert.match(source, /waiting_for_reconnect/);
  assert.match(source, /已完成的学生结果已保留，将在服务重连后继续/);
  assert.match(loop, /concurrency: 2/);
  assert.match(loop, /retries: 3/);
  assert.match(loop, /readToolFailure/);
  assert.match(loop, /attempt === 1/);
});

test("evaluator retries stale context but stops on invalid tool output", () => {
  const stale = evaluatorToolFailure("STUDENT_OBSERVATION_STALE: 学生画像已经变化");
  const unavailable = evaluatorToolFailure("学习数据服务不可用：HTTP 503");
  const invalid = evaluatorToolFailure("operations[0].path 不受支持");
  assert.equal(stale.kind, "stale_context");
  assert.equal(evaluatorFailureIsRetryable(stale), true);
  assert.equal(unavailable.kind, "transient");
  assert.equal(evaluatorFailureIsRetryable(unavailable), true);
  assert.equal(invalid.kind, "invalid_output");
  assert.equal(evaluatorFailureIsRetryable(invalid), false);
});

test("evaluator cleanup accepts an already removed assignment and surfaces rollback conflicts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(null, { status: 404 });
  await discardFailedEvaluatorAssignment("assignment-gone");

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "学生描述已发生后续变化" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(
    discardFailedEvaluatorAssignment("assignment-conflict"),
    /学生描述已发生后续变化/,
  );
});

test("evaluator run recovery resumes unfinished work after a new process starts", async () => {
  const source = await readFile(new URL("./minerva-evaluator-recovery.ts", import.meta.url), "utf8");
  assert.match(source, /waiting_for_reconnect/);
  assert.match(source, /readArchivedAssignmentIds/);
  assert.match(source, /status: "archived"/);
  assert.match(source, /run\.hostPid !== process\.pid/);
  assert.match(source, /resetStuckGradingStudents/);
  assert.match(source, /startGradingSession/);
  assert.doesNotMatch(source, /discardFailedEvaluatorAssignment\(run\.assignmentId\)/);
});

test("archived assignments clear stale failures and cannot be resumed", () => {
  const archived = archivedRunRecord({
    assignmentId: "assignment-1",
    sessionId: "session-1",
    startedAt: "2026-09-10T00:00:00Z",
    status: "waiting_for_reconnect",
    error: "old failure",
    failedAt: "2026-09-10T00:01:00Z",
    cleanupPending: true,
  });
  assert.equal(archived.status, "archived");
  assert.equal(archived.error, undefined);
  assert.equal(archived.failedAt, undefined);
  assert.equal(archived.cleanupPending, undefined);
  assert.equal(shouldResume(archived, false, false), false);
});
