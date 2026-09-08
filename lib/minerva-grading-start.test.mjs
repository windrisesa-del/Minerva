import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("grading host paginates students, isolates workers, and finalizes before evaluation", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  assert.match(source, /const STUDENT_PAGE_SIZE = 25/);
  assert.match(source, /while \(true\)[\s\S]*has_more[\s\S]*next_offset/);
  assert.match(source, /studentId: options\.submission\.student_id/);
  assert.match(source, /submissionId: options\.submission\.id/);
  assert.match(source, /for \(let index = 0; index < options\.submissions\.length/);
  assert.ok(source.indexOf("await finalizeAssignment(") < source.indexOf("await startEvaluatorAfterGrading("));
});

test("grading failure deletes the imported assignment and requires re-import", async () => {
  const source = await readFile(new URL("./minerva-grading-start.ts", import.meta.url), "utf8");
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /await discardFailedAssignment\(options\.assignmentId\)/);
  assert.match(source, /本次导入数据已清理，请重新导入/);
  assert.doesNotMatch(source, /retrying|waiting_for_service|next_retry_at/);
});
