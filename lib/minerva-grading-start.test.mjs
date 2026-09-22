import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { claimGradingPipeline } = await createJiti(import.meta.url).import("./minerva-grading-start.ts");

test("grading start claim is atomic before asynchronous setup", () => {
  const assignmentId = `grading-claim-${Date.now()}-${Math.random()}`;
  assert.equal(claimGradingPipeline(assignmentId), true);
  assert.equal(claimGradingPipeline(assignmentId), false);
});

test("grading host paginates students, isolates workers, and finalizes before evaluation", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  const backendSource = await readFile(new URL("../backend/app/minerva_tools.py", import.meta.url), "utf8");
  assert.match(source, /runStudentWaves/);
  assert.match(source, /groupPrefix: "marker"/);
  assert.match(source, /studentId: options\.student\.student_id/);
  assert.match(source, /submissionId: options\.student\.submission_id/);
  assert.ok(source.indexOf("await finalizeAssignment(") < source.indexOf("await startEvaluatorAfterGrading("));
  assert.match(source, /status: "grading"/);
  assert.match(source, /status: "graded"/);
  assert.match(source, /status: "submitted"/);
  assert.match(source, /initialCompletedStudents/);
  assert.match(source, /totalStudents: state\.students\.length/);
  assert.match(backendSource, /select\(AnswerAttempt\)[\s\S]*?\.with_for_update\(\)/);
});

test("grading failure preserves finished students and waits to resume after reconnect", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await discardFailedAssignment\(options\.assignmentId\)/);
  assert.match(source, /waiting_for_reconnect/);
  assert.match(source, /将在服务重连后继续/);
  assert.match(source, /STUDENT_WORKER_RETRIES|runStudentWaves/);
});
