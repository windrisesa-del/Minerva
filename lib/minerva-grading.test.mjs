import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  GRADING_PROMPT_MARKER,
  GRADER_SESSION_TYPE,
  GRADER_SYSTEM_PROMPT,
  MINERVA_GRADER_TOOLS,
  buildGradingUserPrompt,
  parseGradingAssignmentId,
  readGraderSessionData,
} = await createJiti(import.meta.url).import("./minerva-grading.ts");

const ASSIGNMENT_ID = "11111111-2222-4333-a444-555555555555";

test("grading user prompt carries assignment_id and is detectable", () => {
  const prompt = buildGradingUserPrompt({
    assignmentId: ASSIGNMENT_ID,
    title: "A 组卷",
    unmatched: [{ filename: "99.jpg", reason: "学号不在本班" }],
  });
  assert.match(prompt, new RegExp(GRADING_PROMPT_MARKER));
  assert.equal(parseGradingAssignmentId(prompt), ASSIGNMENT_ID);
  assert.match(prompt, /99\.jpg/);
  assert.equal(parseGradingAssignmentId("普通聊天里提到 assignment_id: " + ASSIGNMENT_ID), null);
});

test("grader session identity is stored as a custom entry", () => {
  assert.equal(GRADER_SESSION_TYPE, "pi-web:minerva-grader");
  const data = readGraderSessionData([
    { type: "message" },
    { type: "custom", customType: GRADER_SESSION_TYPE, data: { version: 1, assignmentId: ASSIGNMENT_ID, title: "C 组卷" } },
  ]);
  assert.deepEqual(data, { version: 1, assignmentId: ASSIGNMENT_ID, title: "C 组卷" });
  assert.equal(readGraderSessionData([{ type: "custom", customType: "other", data: { version: 1 } }]), null);
});

test("student worker prompt binds one submission and leaves finalization to the host", () => {
  const prompt = buildGradingUserPrompt({
    assignmentId: ASSIGNMENT_ID,
    title: "C 组卷",
    studentId: "student-1",
    submissionId: "submission-2",
  });
  assert.match(prompt, /student_id: student-1/);
  assert.match(prompt, /submission_id: submission-2/);
  assert.match(prompt, /Do not finalize/);
  assert.deepEqual(readGraderSessionData([{ type: "custom", customType: GRADER_SESSION_TYPE, data: {
    version: 1,
    assignmentId: ASSIGNMENT_ID,
    title: "C 组卷",
    studentId: "student-1",
    submissionId: "submission-2",
  } }]), {
    version: 1,
    assignmentId: ASSIGNMENT_ID,
    title: "C 组卷",
    studentId: "student-1",
    submissionId: "submission-2",
  });
});

test("frozen grader prompt keeps the scoring-only contract", () => {
  assert.deepEqual([...MINERVA_GRADER_TOOLS], ["read_minerva", "write_minerva"]);
  assert.match(GRADER_SYSTEM_PROMPT, /You are a grading assistant operating inside Minerva/);
  assert.match(GRADER_SYSTEM_PROMPT, /read_minerva/);
  assert.match(GRADER_SYSTEM_PROMPT, /write_minerva/);
  assert.match(GRADER_SYSTEM_PROMPT, /kind=grading/);
  assert.match(GRADER_SYSTEM_PROMPT, /assignment_id/);
  assert.match(GRADER_SYSTEM_PROMPT, /Write grading evidence in Chinese/);
  assert.match(GRADER_SYSTEM_PROMPT, /only that question's structured JSON and linked images/);
  assert.match(GRADER_SYSTEM_PROMPT, /objective and fill-in items/);
  assert.match(GRADER_SYSTEM_PROMPT, /detailed grading evidence tied to the rubric/);
  assert.match(GRADER_SYSTEM_PROMPT, /error_type/);
  assert.match(GRADER_SYSTEM_PROMPT, /knowledge_results/);
  assert.match(GRADER_SYSTEM_PROMPT, /rubric_items/);
  assert.match(GRADER_SYSTEM_PROMPT, /Do not finalize/);
  assert.match(GRADER_SYSTEM_PROMPT, /Arabic numerals \(0-9\)/);
  assert.match(GRADER_SYSTEM_PROMPT, /between 0 and that question's max_score, inclusive/);
  assert.match(GRADER_SYSTEM_PROMPT, /next_attachment_offset=null/);
  assert.match(GRADER_SYSTEM_PROMPT, /answer_attempts with that question_id/);
  assert.match(GRADER_SYSTEM_PROMPT, /Do not load unrelated question images/);
  assert.match(GRADER_SYSTEM_PROMPT, /do not skip the whole student/);
  assert.match(GRADER_SYSTEM_PROMPT, /Do not write standard answers or scoring rubrics/);
  assert.doesNotMatch(GRADER_SYSTEM_PROMPT, /file write/);
  assert.doesNotMatch(GRADER_SYSTEM_PROMPT, /file edit/);
});
