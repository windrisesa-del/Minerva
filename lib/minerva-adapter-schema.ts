import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SourceRefSchema = Type.Object({
  path: Type.String(),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  block_ids: Type.Array(Type.String()),
});

const ContentBlockSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("formula"), latex: Type.String() }),
  Type.Object({ type: Type.Literal("image"), asset_id: Type.String() }),
  Type.Object({ type: Type.Literal("table"), data: Type.Array(Type.Array(Type.String())) }),
]);

const AssetSchema = Type.Object({
  path: Type.String({ pattern: "^/uploads/" }),
  storage_key: Type.Optional(Type.String({ pattern: "^/uploads/" })),
  mime_type: Type.String({ minLength: 1 }),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  bbox: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4 })),
  source_path: Type.String({ pattern: "^/uploads/" }),
});

const BboxSchema = Type.Union([
  Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }),
  Type.Null(),
]);

const NormalizedBlockSchema = Type.Union([
  Type.Object({ id: Type.String(), type: Type.Literal("text"), text: Type.String(), bbox: BboxSchema }),
  Type.Object({ id: Type.String(), type: Type.Literal("formula"), latex: Type.String(), bbox: BboxSchema }),
  Type.Object({ id: Type.String(), type: Type.Literal("image"), asset_id: Type.String(), bbox: BboxSchema }),
  Type.Object({ id: Type.String(), type: Type.Literal("table"), data: Type.Array(Type.Array(Type.String())), bbox: BboxSchema }),
]);

export const NormalizedDocumentSchema = Type.Object({
  schema_version: Type.Literal("minerva-normalized-document/0.1"),
  source: Type.Object({
    file_name: Type.String({ minLength: 1 }),
    path: Type.String({ pattern: "^/uploads/" }),
    format: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }),
  pages: Type.Array(Type.Object({
    page: Type.Integer({ minimum: 1 }),
    width: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
    height: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
    blocks: Type.Array(NormalizedBlockSchema),
  }), { minItems: 1 }),
  assets: Type.Record(Type.String(), Type.Object({
    path: Type.String({ pattern: "^/uploads/" }),
    mime_type: Type.String({ minLength: 1 }),
    page: Type.Integer({ minimum: 1 }),
    bbox: BboxSchema,
    source_path: Type.String({ pattern: "^/uploads/" }),
  })),
  warnings: Type.Array(Type.String()),
});

export type NormalizedDocument = Static<typeof NormalizedDocumentSchema>;

export function validateNormalizedDocument(value: unknown): NormalizedDocument {
  if (!Value.Check(NormalizedDocumentSchema, value)) {
    const errors = [...Value.Errors(NormalizedDocumentSchema, value)].slice(0, 8)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`document_parse schema validation failed: ${errors.join("; ")}`);
  }
  const document = value as NormalizedDocument;
  const assetIds = new Set(Object.keys(document.assets));
  for (const page of document.pages) {
    for (const block of page.blocks) {
      if (block.type === "image" && !assetIds.has(block.asset_id)) {
        throw new Error(`document_parse references missing asset: ${block.asset_id}`);
      }
    }
  }
  return document;
}

export const AssessmentSchema = Type.Object({
  schema_version: Type.Literal("minerva-assessment/0.1"),
  status: Type.Literal("ungraded"),
  metadata: Type.Object({
    title: Type.String({ minLength: 1 }),
    subject: Type.String({ minLength: 1 }),
    total_score: Type.Number({ exclusiveMinimum: 0 }),
  }),
  questions: Type.Array(Type.Object({
    question_id: Type.String({ minLength: 1 }),
    parent_question_id: Type.Optional(Type.String({ minLength: 1 })),
    position: Type.Integer({ minimum: 1 }),
    question_type: Type.String({ minLength: 1 }),
    content: Type.Array(ContentBlockSchema, { minItems: 1 }),
    reference_solution: Type.Object({
      answer: Type.String(),
      reasoning: Type.Array(Type.String()),
      max_score: Type.Number({ exclusiveMinimum: 0 }),
      scoring_criteria: Type.Array(Type.Object({
        score: Type.Number({ minimum: 0 }),
        requirement: Type.String({ minLength: 1 }),
      })),
      partial_credit: Type.Array(Type.Object({
        score: Type.Number({ minimum: 0 }),
        condition: Type.String({ minLength: 1 }),
      })),
    }),
    analysis: Type.Object({
      subject: Type.String({ minLength: 1 }),
      knowledge_domain: Type.String({ minLength: 1 }),
      question_type: Type.String({ minLength: 1 }),
      main_concepts: Type.Array(Type.String()),
      expected_path: Type.Array(Type.String()),
      dependencies: Type.Array(Type.String()),
      difficulty: Type.Union([
        Type.Literal("easy"),
        Type.Literal("medium"),
        Type.Literal("hard"),
        Type.Literal("unknown"),
      ]),
      required_abilities: Type.Array(Type.String()),
    }, { additionalProperties: false }),
    source_references: Type.Array(SourceRefSchema, { minItems: 1 }),
  }), { minItems: 1 }),
  assets: Type.Record(Type.String(), AssetSchema),
  student_submissions: Type.Array(Type.Object({
    student_id: Type.String({ minLength: 1 }),
    normalized_documents: Type.Array(Type.String({ pattern: "^/uploads/" }), { minItems: 1 }),
    assets: Type.Record(Type.String(), AssetSchema),
    answers: Type.Array(Type.Object({
      question_id: Type.String({ minLength: 1 }),
      status: Type.Union([Type.Literal("answered"), Type.Literal("blank"), Type.Literal("uncertain")]),
      content: Type.Array(ContentBlockSchema),
      selected_options: Type.Array(Type.String()),
      source_references: Type.Array(SourceRefSchema),
    }), { minItems: 1 }),
    uncertainties: Type.Array(Type.String()),
  }), { minItems: 1 }),
  normalized_documents: Type.Array(Type.String(), { minItems: 1 }),
  uncertainties: Type.Array(Type.String()),
});

export type MinervaAssessment = Static<typeof AssessmentSchema>;

export const QuestionsDraftSchema = Type.Omit(AssessmentSchema, ["student_submissions"]);
export type MinervaQuestionsDraft = Static<typeof QuestionsDraftSchema>;

function assertQuestionInvariants(assessment: Pick<MinervaAssessment, "questions" | "assets" | "metadata">): Set<string> {
  const positions = assessment.questions.map((question) => question.position);
  if (new Set(positions).size !== positions.length || positions.some((position, index) => position !== index + 1)) {
    throw new Error("Adapter assessment questions must use unique, continuous positions starting at 1");
  }
  const total = assessment.questions.reduce((sum, question) => sum + question.reference_solution.max_score, 0);
  if (Math.abs(total - assessment.metadata.total_score) > 0.01) {
    throw new Error("Adapter assessment total_score must equal the sum of question max scores");
  }
  const assetIds = new Set(Object.keys(assessment.assets));
  const questionIds = new Set(assessment.questions.map((question) => question.question_id));
  for (const question of assessment.questions) {
    for (const block of question.content) {
      if (block.type === "image" && !assetIds.has(block.asset_id)) {
        throw new Error(`Adapter assessment references missing asset: ${block.asset_id}`);
      }
    }
  }
  return questionIds;
}

export function validateQuestionsDraft(value: unknown): MinervaQuestionsDraft {
  if (!Value.Check(QuestionsDraftSchema, value)) {
    const errors = [...Value.Errors(QuestionsDraftSchema, value)].slice(0, 8)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`Adapter questions schema validation failed: ${errors.join("; ")}`);
  }
  const draft = value as MinervaQuestionsDraft;
  assertQuestionInvariants(draft);
  return draft;
}

export function validateAssessment(value: unknown): MinervaAssessment {
  if (!Value.Check(AssessmentSchema, value)) {
    const errors = [...Value.Errors(AssessmentSchema, value)].slice(0, 8)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`Adapter assessment schema validation failed: ${errors.join("; ")}`);
  }
  const assessment = value as MinervaAssessment;
  const questionIds = assertQuestionInvariants(assessment);
  const seenStudents = new Set<string>();
  for (const submission of assessment.student_submissions) {
    if (seenStudents.has(submission.student_id)) {
      throw new Error(`Adapter assessment has duplicate student submission: ${submission.student_id}`);
    }
    seenStudents.add(submission.student_id);
    const answerIds = submission.answers.map((answer) => answer.question_id);
    if (new Set(answerIds).size !== answerIds.length || answerIds.length !== questionIds.size || answerIds.some((id) => !questionIds.has(id))) {
      throw new Error(`Adapter student ${submission.student_id} must contain exactly one answer for every question`);
    }
    const submissionAssetIds = new Set(Object.keys(submission.assets));
    for (const answer of submission.answers) {
      for (const block of answer.content) {
        if (block.type === "image" && !submissionAssetIds.has(block.asset_id)) {
          throw new Error(`Adapter student ${submission.student_id} answer references missing asset: ${block.asset_id}`);
        }
      }
    }
  }
  return assessment;
}

export function validateAssessmentStudentCoverage(assessment: MinervaAssessment, expectedStudentIds: readonly string[]): void {
  const expected = new Set(expectedStudentIds);
  const actual = new Set(assessment.student_submissions.map((submission) => submission.student_id));
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length || unexpected.length) {
    throw new Error(`Adapter student submission coverage mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
}
