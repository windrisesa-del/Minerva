import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { discardFailedEvaluatorAssignment, readGradedStudents } = await createJiti(import.meta.url).import("./minerva-evaluator-start.ts");

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

test("evaluator worker loop is sequential and passes one student scope", async () => {
  const source = await readFile(new URL("./minerva-evaluator-start.ts", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("async function runStudentEvaluators"), source.indexOf("export async function startEvaluatorSession"));
  assert.match(loop, /for \(let index = 0; index < options\.students\.length; index \+= 1\)/);
  assert.ok(loop.indexOf("await startStudentEvaluator") < loop.indexOf("await waitForWorker"));
  assert.ok(loop.indexOf("await waitForWorker") < loop.indexOf("completedStudents += 1"));
  assert.match(source, /studentId: options\.student\.student_id/);
  assert.match(source, /submissionId: options\.student\.submission_id/);
  assert.match(source, /await discardFailedEvaluatorAssignment\(options\.assignmentId\)/);
  assert.match(source, /本次 Evaluator 更改和导入数据已清理，请重新导入/);
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

test("evaluator run recovery detects stale work and retries pending cleanup", async () => {
  const source = await readFile(new URL("./minerva-evaluator-recovery.ts", import.meta.url), "utf8");
  assert.match(source, /original\.status === "running" && !live && !active && !withinGrace/);
  assert.match(source, /interrupted \|\| original\.cleanupPending/);
  assert.match(source, /discardFailedEvaluatorAssignment\(run\.assignmentId\)/);
});
