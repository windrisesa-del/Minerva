import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("grading host paginates students, isolates workers, and finalizes before evaluation", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  assert.match(source, /runStudentWaves/);
  assert.match(source, /groupPrefix: "marker"/);
  assert.match(source, /studentId: options\.student\.student_id/);
  assert.match(source, /submissionId: options\.student\.submission_id/);
  assert.ok(source.indexOf("await finalizeAssignment(") < source.indexOf("await startEvaluatorAfterGrading("));
  assert.match(source, /status: "grading"/);
  assert.match(source, /status: "graded"/);
  assert.match(source, /status: "submitted"/);
});

test("grading failure preserves finished students and waits to resume after reconnect", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await discardFailedAssignment\(options\.assignmentId\)/);
  assert.match(source, /waiting_for_reconnect/);
  assert.match(source, /将在服务重连后继续/);
  assert.match(source, /STUDENT_WORKER_RETRIES|runStudentWaves/);
});
