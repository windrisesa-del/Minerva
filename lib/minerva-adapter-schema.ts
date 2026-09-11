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

export function parseAdapterJsonText(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  try {
    JSON.parse(normalized);
    return normalized;
  } catch (initialError) {
    let candidate = normalized;
    for (let removed = 0; removed < 3 && candidate.endsWith("}"); removed += 1) {
      candidate = candidate.slice(0, -1).trimEnd();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Only tolerate unmatched closing braces appended after a complete JSON object.
      }
    }
    throw initialError;
  }
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asUploadPath(value: unknown): string {
  const text = asString(value);
  return text.startsWith("/uploads/") ? text : "";
}

function normalizeContentBlocks(value: unknown, fallbackText = ""): Array<Record<string, unknown>> {
  if (Array.isArray(value) && value.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    for (const item of value) {
      const block = asRecord(item);
      if (!block) continue;
      const type = asString(block.type);
      if (type === "text" && asString(block.text)) blocks.push({ type: "text", text: asString(block.text) });
      else if (type === "formula" && asString(block.latex)) blocks.push({ type: "formula", latex: asString(block.latex) });
      else if (type === "image" && asString(block.asset_id)) blocks.push({ type: "image", asset_id: asString(block.asset_id) });
      else if (type === "table" && Array.isArray(block.data)) blocks.push({ type: "table", data: block.data });
    }
    if (blocks.length) return blocks;
  }
  const text = fallbackText.trim();
  return text ? [{ type: "text", text }] : [{ type: "text", text: "（题干缺失）" }];
}

function normalizeSourceRefs(question: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(question.source_references) && question.source_references.length) {
    return question.source_references.flatMap((item) => {
      const ref = asRecord(item);
      const path = asUploadPath(ref?.path);
      if (!path) return [];
      const page = asNumber(ref?.page);
      return [{
        path,
        ...(page && page >= 1 ? { page: Math.trunc(page) } : {}),
        block_ids: asStringList(ref?.block_ids),
      }];
    });
  }
  const source = asRecord(question.source);
  const path = asUploadPath(source?.path ?? question.source);
  if (!path) return [{ path: "/uploads/unknown", block_ids: [] }];
  const page = asNumber(source?.page);
  return [{
    path,
    ...(page && page >= 1 ? { page: Math.trunc(page) } : {}),
    block_ids: asStringList(source?.block_ids),
  }];
}

function defaultMaxScore(questionType: string): number {
  const type = questionType.toLowerCase();
  if (type.includes("multiple") || type.includes("多选")) return 8;
  if (type.includes("fill") || type.includes("填空")) return 8;
  if (type.includes("subject") || type.includes("constructed") || type.includes("解答")) return 20;
  return 6;
}

function normalizeReferenceSolution(question: Record<string, unknown>, questionType: string): Record<string, unknown> {
  const raw = asRecord(question.reference_solution) ?? asRecord(question.scoring) ?? {};
  const answer = asString(raw.answer)
    || asString(question.provided_answer)
    || asString(question.standard_answer)
    || "";
  const parsedMax = asNumber(raw.max_score) ?? asNumber(question.max_score);
  const maxScore = parsedMax && parsedMax > 0 ? parsedMax : defaultMaxScore(questionType);
  const reasoning = asStringList(raw.reasoning);
  const rubric = asString(question.rubric);
  const scoringCriteria = Array.isArray(raw.scoring_criteria)
    ? raw.scoring_criteria.flatMap((item) => {
      const row = asRecord(item);
      if (!row) return [];
      const score = asNumber(row.score) ?? maxScore;
      const requirement = asString(row.requirement) || asString(row.condition) || asString(row.text) || rubric || "按参考答案给分";
      return [{ score, requirement }];
    })
    : [];
  const partialCredit = Array.isArray(raw.partial_credit)
    ? raw.partial_credit.flatMap((item) => {
      const row = asRecord(item);
      if (!row) return [];
      const score = asNumber(row.score) ?? 0;
      const condition = asString(row.condition) || asString(row.requirement) || asString(row.text);
      if (!condition) return [];
      return [{ score, condition }];
    })
    : [];
  return {
    answer,
    reasoning,
    max_score: maxScore,
    scoring_criteria: scoringCriteria.length ? scoringCriteria : [{ score: maxScore, requirement: rubric || "按参考答案给分" }],
    partial_credit: partialCredit,
  };
}

function normalizeAnalysis(question: Record<string, unknown>): Record<string, unknown> {
  const analysis = asRecord(question.analysis) ?? {};
  const classification = asRecord(question.classification) ?? {};
  const difficultyRaw = asString(analysis.difficulty).toLowerCase();
  const difficulty = ["easy", "medium", "hard", "unknown"].includes(difficultyRaw) ? difficultyRaw : "unknown";
  return {
    subject: asString(analysis.subject) || asString(classification.subject) || asString(question.subject) || "数学",
    knowledge_domain: asString(analysis.knowledge_domain) || asString(classification.knowledge_domain) || "未分类",
    question_type: asString(analysis.question_type) || asString(classification.question_type) || asString(question.question_type) || "unknown",
    main_concepts: asStringList(analysis.main_concepts).length ? asStringList(analysis.main_concepts) : asStringList(analysis.key_concepts).length ? asStringList(analysis.key_concepts) : asStringList(question.knowledge_points),
    expected_path: asStringList(analysis.expected_path).length ? asStringList(analysis.expected_path) : asString(analysis.expected_response_form) ? [asString(analysis.expected_response_form)] : [],
    dependencies: asStringList(analysis.dependencies),
    difficulty,
    required_abilities: asStringList(analysis.required_abilities),
  };
}

function fallbackQuestionText(question: Record<string, unknown>): string {
  const parts = [asString(question.stem), asString(question.prompt)];
  if (Array.isArray(question.options)) {
    for (const option of question.options) {
      const row = asRecord(option);
      if (!row) continue;
      const label = asString(row.label);
      const text = asString(row.text);
      if (label || text) parts.push(label ? `${label}. ${text}` : text);
    }
  }
  return parts.filter(Boolean).join("\n");
}

function normalizeQuestion(raw: unknown, index: number): Record<string, unknown> {
  const question = asRecord(raw) ?? {};
  const position = Math.trunc(asNumber(question.position) ?? asNumber(question.number) ?? index + 1);
  const questionType = asString(question.question_type)
    || asString(asRecord(question.classification)?.question_type)
    || asString(question.prompt)
    || "unknown";
  const parent = asString(question.parent_question_id);
  return {
    question_id: asString(question.question_id) || `Q${position}`,
    ...(parent ? { parent_question_id: parent } : {}),
    position: position > 0 ? position : index + 1,
    question_type: questionType,
    content: normalizeContentBlocks(question.content, fallbackQuestionText(question)),
    reference_solution: normalizeReferenceSolution(question, questionType),
    analysis: normalizeAnalysis(question),
    source_references: normalizeSourceRefs(question),
  };
}

function normalizeAssets(value: unknown): Record<string, unknown> {
  const assets = asRecord(value) ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(assets)) {
    const asset = asRecord(raw);
    const path = asUploadPath(asset?.path ?? asset?.storage_key);
    const sourcePath = asUploadPath(asset?.source_path) || path;
    if (!asset || !path) continue;
    cleaned[id] = {
      path,
      mime_type: asString(asset.mime_type) || "application/octet-stream",
      source_path: sourcePath,
      ...(asString(asset.storage_key).startsWith("/uploads/") ? { storage_key: asString(asset.storage_key) } : {}),
      ...(asNumber(asset.page) ? { page: Math.trunc(asNumber(asset.page) as number) } : {}),
      ...(Array.isArray(asset.bbox) ? { bbox: asset.bbox } : {}),
    };
  }
  return cleaned;
}

function normalizeStudentSubmission(raw: unknown, questionIds: string[]): Record<string, unknown> {
  const submission = asRecord(raw) ?? {};
  const answersById = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(submission.answers) ? submission.answers : []) {
    const answer = asRecord(item);
    if (!answer) continue;
    const questionId = asString(answer.question_id);
    if (!questionId) continue;
    const statusRaw = asString(answer.status);
    const status = ["answered", "blank", "uncertain"].includes(statusRaw) ? statusRaw : "uncertain";
    answersById.set(questionId, {
      question_id: questionId,
      status,
      content: normalizeContentBlocks(answer.content, asString(answer.text)),
      selected_options: asStringList(answer.selected_options),
      source_references: normalizeSourceRefs(answer),
    });
  }
  const documents = asStringList(submission.normalized_documents).filter((path) => path.startsWith("/uploads/"));
  return {
    student_id: asString(submission.student_id),
    normalized_documents: documents.length ? documents : ["/uploads/unknown"],
    assets: normalizeAssets(submission.assets),
    answers: questionIds.map((questionId) => answersById.get(questionId) ?? {
      question_id: questionId,
      status: "blank",
      content: [],
      selected_options: [],
      source_references: [],
    }),
    uncertainties: asStringList(submission.uncertainties),
  };
}

export function normalizeAssessmentInput(value: unknown, options?: { includeStudents?: boolean }): Record<string, unknown> {
  const raw = asRecord(value) ?? {};
  const metadataIn = asRecord(raw.metadata) ?? {};
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((item, index) => normalizeQuestion(item, index));
  const totalScore = questions.reduce((sum, question) => sum + (asNumber((asRecord(question.reference_solution) ?? {}).max_score) ?? 0), 0);
  const sourcePaths = questions.flatMap((question) => {
    const refs = Array.isArray(question.source_references) ? question.source_references : [];
    return refs.map((ref) => asUploadPath(asRecord(ref)?.path)).filter(Boolean);
  });
  const normalizedDocuments = asStringList(raw.normalized_documents).filter((path) => path.startsWith("/uploads/") || path.length > 0);
  const draft: Record<string, unknown> = {
    schema_version: "minerva-assessment/0.1",
    status: "ungraded",
    metadata: {
      title: asString(metadataIn.title) || asString(raw.title) || "未命名作业",
      subject: asString(metadataIn.subject) || "数学",
      total_score: totalScore > 0 ? totalScore : 1,
    },
    questions,
    assets: normalizeAssets(raw.assets),
    normalized_documents: normalizedDocuments.length ? normalizedDocuments : [...new Set(sourcePaths.length ? sourcePaths : ["/uploads/unknown"])],
    uncertainties: asStringList(raw.uncertainties),
  };
  if (options?.includeStudents !== false && Array.isArray(raw.student_submissions)) {
    const questionIds = questions.map((question) => asString(question.question_id));
    draft.student_submissions = raw.student_submissions.map((item) => normalizeStudentSubmission(item, questionIds));
  }
  return draft;
}

export function validateQuestionsDraft(value: unknown): MinervaQuestionsDraft {
  const normalized = normalizeAssessmentInput(value, { includeStudents: false });
  if (!Value.Check(QuestionsDraftSchema, normalized)) {
    const errors = [...Value.Errors(QuestionsDraftSchema, normalized)].slice(0, 8)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`Adapter questions schema validation failed: ${errors.join("; ")}`);
  }
  const draft = normalized as MinervaQuestionsDraft;
  assertQuestionInvariants(draft);
  return draft;
}

export function validateAssessment(value: unknown): MinervaAssessment {
  const normalized = normalizeAssessmentInput(value, { includeStudents: true });
  if (!Value.Check(AssessmentSchema, normalized)) {
    const errors = [...Value.Errors(AssessmentSchema, normalized)].slice(0, 8)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`Adapter assessment schema validation failed: ${errors.join("; ")}`);
  }
  const assessment = normalized as MinervaAssessment;
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
