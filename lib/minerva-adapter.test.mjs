import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const adapter = await jiti.import("./minerva-adapter.ts");
const schema = await jiti.import("./minerva-adapter-schema.ts");
const extensionModule = await jiti.import("./document-parse-extension.ts");

function validAssessment() {
  return {
    schema_version: "minerva-assessment/0.1",
    status: "ungraded",
    metadata: { title: "样例试卷", subject: "数学", total_score: 10 },
    questions: [{
      question_id: "Q1",
      position: 1,
      question_type: "解答题",
      content: [{ type: "text", text: "求 x 的值" }, { type: "image", asset_id: "asset_q1" }],
      reference_solution: {
        answer: "x=2",
        reasoning: ["解方程"],
        max_score: 10,
        scoring_criteria: [{ score: 10, requirement: "答案及过程正确" }],
        partial_credit: [],
      },
      analysis: {
        subject: "数学",
        knowledge_domain: "代数",
        question_type: "方程求解",
        main_concepts: ["方程"],
        expected_path: ["移项", "求解"],
        dependencies: [],
        difficulty: "easy",
        required_abilities: ["代数运算"],
      },
      source_references: [{ path: "/uploads/paper.txt", page: 1, block_ids: ["p1_b1"] }],
    }],
    assets: {
      asset_q1: { path: "/uploads/figure.png", mime_type: "image/png", page: 1, bbox: [0, 0, 10, 10], source_path: "/uploads/paper.pdf" },
    },
    student_submissions: [{
      student_id: "11111111-2222-4333-a444-555555555555",
      normalized_documents: ["/uploads/student-1.txt"],
      assets: {},
      answers: [{
        question_id: "Q1",
        status: "answered",
        content: [{ type: "text", text: "x=2" }],
        selected_options: [],
        source_references: [{ path: "/uploads/student-1.txt", page: 1, block_ids: ["p1_b1"] }],
      }],
      uncertainties: [],
    }],
    normalized_documents: ["/uploads/paper.txt"],
    uncertainties: [],
  };
}

test("adapter uses a separate prompt and only read/write/document_parse", () => {
  assert.deepEqual([...adapter.MINERVA_ADAPTER_TOOLS], ["read", "write", "document_parse"]);
  assert.equal(adapter.ADAPTER_SESSION_TYPE, "pi-web:minerva-adapter");
  assert.match(adapter.ADAPTER_SYSTEM_PROMPT, /Do not grade students/);
  assert.match(adapter.ADAPTER_SYSTEM_PROMPT, /two host-controlled phases/);
  assert.match(adapter.ADAPTER_SYSTEM_PROMPT, /analysis.main_concepts/);
  assert.match(adapter.ADAPTER_SYSTEM_PROMPT, /knowledge IDs/);
  const promptData = {
    version: 1,
    assignmentId: "11111111-2222-4333-a444-555555555555",
    title: "样例",
    requestPath: "C:\\request.json",
    outputPath: "C:\\assessment.json",
    questionsPath: "C:\\questions.json",
  };
  assert.match(adapter.buildAdapterQuestionsPrompt(promptData), /phase: questions/);
  assert.match(adapter.buildAdapterAnswersPrompt(promptData), /phase: answers/);
  assert.match(adapter.buildAdapterUserPrompt(promptData), /\[MINERVA_ADAPTER\]/);
});

test("adapter pipeline waits for the Pi tool loop before reading output", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./minerva-adapter-start.ts", import.meta.url), "utf8"));
  assert.match(source, /waitForAdapterOutput\(session, questionsPath, "questions phase"\)/);
  assert.match(source, /waitForAdapterOutput\(session, outputPath, "answers phase"\)/);
  assert.match(source, /session\.isRunning\(\)/);
  assert.match(source, /ended with an invalid JSON file/);
  assert.match(source, /thinkingLevel: "off"/);
  assert.match(source, /persistPreferences: false/);
  assert.match(source, /resolveMinervaProjectRoot/);
  assert.doesNotMatch(source, /output_schema: AssessmentSchema/);
  assert.match(source, /ADAPTER_PHASE_TIMEOUT_MS = 10 \* 60 \* 1000/);
});

test("assessment schema validates traceable assets and score totals", () => {
  assert.equal(schema.validateAssessment(validAssessment()).status, "ungraded");
  const missing = validAssessment();
  delete missing.assets.asset_q1;
  assert.throws(() => schema.validateAssessment(missing), /missing asset/);
  const wrongTotal = validAssessment();
  wrongTotal.metadata.total_score = 20;
  assert.equal(schema.validateAssessment(wrongTotal).metadata.total_score, 10);
  const obsoleteAnalysis = validAssessment();
  obsoleteAnalysis.questions[0].analysis.likely_errors = ["符号错误"];
  assert.equal(schema.validateAssessment(obsoleteAnalysis).questions[0].analysis.difficulty, "easy");
  assert.equal("likely_errors" in schema.validateAssessment(obsoleteAnalysis).questions[0].analysis, false);
  const missingStudentAnswer = validAssessment();
  missingStudentAnswer.student_submissions[0].answers = [];
  assert.equal(schema.validateAssessment(missingStudentAnswer).student_submissions[0].answers[0].status, "blank");
  assert.doesNotThrow(() => schema.validateAssessmentStudentCoverage(
    schema.validateAssessment(validAssessment()),
    ["11111111-2222-4333-a444-555555555555"],
  ));
  assert.throws(() => schema.validateAssessmentStudentCoverage(
    schema.validateAssessment(validAssessment()),
    ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
  ), /coverage mismatch/);
  const draft = validAssessment();
  delete draft.student_submissions;
  assert.equal(schema.validateQuestionsDraft(draft).questions.length, 1);
  const malformedWithTrailingBrace = `${JSON.stringify(draft)}\n}`;
  assert.deepEqual(JSON.parse(schema.parseAdapterJsonText(malformedWithTrailingBrace)), draft);
  assert.throws(() => schema.parseAdapterJsonText('{"incomplete":'), SyntaxError);
  assert.throws(() => schema.validateQuestionsDraft({ ...draft, questions: [] }), /schema validation failed/);
  const aliased = {
    schema_version: "minerva-assessment/0.1",
    status: "ungraded",
    metadata: { title: "A组试题", subject: "Mathematics" },
    questions: [{
      question_id: "q1",
      number: "1",
      parent_question_id: null,
      stem: "1+1=（    ）",
      prompt: "单项选择题",
      options: [{ label: "A", text: "2" }],
      provided_answer: "A",
      scoring: null,
      classification: { subject: "数学", knowledge_domain: "运算", question_type: "single_choice" },
      analysis: { key_concepts: ["加法"] },
      source: { path: "/uploads/paper.pdf", page: 1, block_ids: ["p1_b1"] },
    }],
    assets: {},
    normalized_documents: ["/uploads/paper.pdf"],
    uncertainties: [],
  };
  const normalized = schema.validateQuestionsDraft(aliased);
  assert.equal(normalized.questions[0].position, 1);
  assert.equal(normalized.questions[0].content[0].type, "text");
  assert.equal(normalized.metadata.total_score, normalized.questions[0].reference_solution.max_score);
  assert.equal(normalized.questions[0].analysis.difficulty, "unknown");
  const partial = JSON.parse(JSON.stringify(aliased));
  partial.questions[0].scoring = {
    max_score: 6,
    scoring_criteria: [{ score: 6 }],
    partial_credit: [{ score: 3 }, { score: 2, condition: "步骤正确" }],
  };
  const cleaned = schema.validateQuestionsDraft(partial);
  assert.equal(cleaned.questions[0].reference_solution.scoring_criteria[0].requirement.length > 0, true);
  assert.equal(cleaned.questions[0].reference_solution.partial_credit.length, 1);
  assert.equal(cleaned.questions[0].reference_solution.partial_credit[0].condition, "步骤正确");
  const zeroScore = JSON.parse(JSON.stringify(aliased));
  zeroScore.questions[0].max_score = 0;
  zeroScore.questions[0].scoring = { max_score: 0, scoring_criteria: [], partial_credit: [] };
  assert.ok(schema.validateQuestionsDraft(zeroScore).questions[0].reference_solution.max_score > 0);
  const mismatchedTotal = JSON.parse(JSON.stringify(aliased));
  mismatchedTotal.metadata.total_score = 999;
  assert.equal(
    schema.validateQuestionsDraft(mismatchedTotal).metadata.total_score,
    schema.validateQuestionsDraft(mismatchedTotal).questions[0].reference_solution.max_score,
  );
});

test("normalized document schema rejects missing visual assets", () => {
  const document = {
    schema_version: "minerva-normalized-document/0.1",
    source: { file_name: "paper.pdf", path: "/uploads/paper.pdf", format: "pdf", sha256: "a".repeat(64) },
    pages: [{ page: 1, width: 100, height: 100, blocks: [{ id: "p1_b1", type: "image", asset_id: "asset_001", bbox: [0, 0, 10, 10] }] }],
    assets: {},
    warnings: [],
  };
  assert.throws(() => schema.validateNormalizedDocument(document), /missing asset/);
  document.assets.asset_001 = { path: "/uploads/a.png", mime_type: "image/png", page: 1, bbox: [0, 0, 10, 10], source_path: "/uploads/paper.pdf" };
  assert.equal(schema.validateNormalizedDocument(document).pages.length, 1);
});

test("document_parse is registered as one unified tool", async () => {
  const names = [];
  await extensionModule.createDocumentParseExtension().factory({ registerTool(tool) { names.push(tool.name); } });
  assert.deepEqual(names, ["document_parse"]);
});
