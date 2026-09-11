import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  EVALUATOR_PROMPT_MARKER,
  EVALUATOR_SESSION_TYPE,
  EVALUATOR_SYSTEM_PROMPT,
  MINERVA_EVALUATOR_TOOLS,
  buildEvaluatorUserPrompt,
} = await createJiti(import.meta.url).import("./minerva-evaluator.ts");

test("evaluator prompt enforces one student's three-part profile and structured buffer", () => {
  assert.deepEqual([...MINERVA_EVALUATOR_TOOLS], ["write_minerva"]);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /一个 Evaluator 会话只处理任务中绑定的一名学生和一次提交/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /kind=student_observation/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /使用 operations 增量更新 Student Profile 和 Evidence Buffer/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /knowledge_profile/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /problem_solving_and_learning_profile/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /learning_trajectory/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /mastery_level/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /1 至 5 的整数，证据不足时为 null/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /answer_payload/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /你负责判断 Evidence Buffer/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /系统不使用固定证据条数替你决定/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /不得根据题目本身推测学生可能出现的常见错误/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /不得写入 Student Profile 三个固定部分之外的长期描述、教学建议/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /调度器在本次会话开始前固定的完整输入/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /grading_result_id/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /report_significance/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /include_in_teacher_report/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /rubric_result.error_type/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /question_analysis.main_concepts/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /不需要你预测后端 diff/);
  assert.match(EVALUATOR_SYSTEM_PROMPT, /没有实质变化时提交 operations=\[\]/);
  assert.doesNotMatch(EVALUATOR_SYSTEM_PROMPT, /每个实际变更恰好一项/);
  const prompt = buildEvaluatorUserPrompt({
    assignmentId: "11111111-2222-4333-a444-555555555555",
    title: "C 组卷",
    studentId: "99999999-8888-4777-a666-555555555555",
    submissionId: "77777777-8888-4999-a666-555555555555",
    context: {
      schema_version: "minerva-evaluator-context/1",
      assignment_id: "11111111-2222-4333-a444-555555555555",
      student_id: "99999999-8888-4777-a666-555555555555",
      submission_id: "77777777-8888-4999-a666-555555555555",
      student_profile: { learning_trajectory: {} },
      teacher_fields: [],
      evidence_buffer: [],
      grading_results: [{ id: "grade-1" }],
      observation_updated_at: null,
    },
  });
  assert.match(prompt, new RegExp(EVALUATOR_PROMPT_MARKER.replace("[", "\\[").replace("]", "\\]")));
  assert.match(prompt, /11111111-2222-4333-a444-555555555555/);
  assert.match(prompt, /99999999-8888-4777-a666-555555555555/);
  assert.match(prompt, /77777777-8888-4999-a666-555555555555/);
  assert.match(prompt, /只评估这个学生的这一次提交/);
  assert.match(prompt, /minerva-evaluator-context\/1/);
  assert.match(prompt, /"id":"grade-1"/);
  assert.equal(EVALUATOR_SESSION_TYPE, "pi-web:minerva-evaluator");
});

test("evaluator session metadata requires version two student and submission scope", async () => {
  const { readEvaluatorSessionData } = await createJiti(import.meta.url).import("./minerva-evaluator.ts");
  assert.equal(readEvaluatorSessionData([{
    type: "custom",
    customType: EVALUATOR_SESSION_TYPE,
    data: { version: 1, assignmentId: "assignment" },
  }]), null);
  assert.deepEqual(readEvaluatorSessionData([{
    type: "custom",
    customType: EVALUATOR_SESSION_TYPE,
    data: {
      version: 2,
      assignmentId: "assignment",
      title: "作业",
      studentId: "student",
      submissionId: "submission",
    },
  }]), {
    version: 2,
    assignmentId: "assignment",
    title: "作业",
    studentId: "student",
    submissionId: "submission",
  });
});
