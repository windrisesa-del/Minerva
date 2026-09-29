import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";

export const HOST_MINERVA_DATA_EXTENSION_NAME = "pi-web-minerva-data";
const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const MAX_ATTACHMENT_IMAGES = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const GRADER_READ_RESOURCES = new Set([
  "assignments",
  "submissions",
  "questions",
  "assignment_items",
  "answer_attempts",
  "grading_results",
]);
const EVALUATOR_READ_RESOURCES = new Set([
  "grading_results",
  "student_description",
  "evidence_buffer",
]);

type Attachment = {
  storage_key?: unknown;
  mime_type?: unknown;
  original_name?: unknown;
};

export function classifyMinervaAttachment(attachment: Attachment): "image" | "json" | "skip" {
  const storageKey = typeof attachment.storage_key === "string" ? attachment.storage_key : "";
  const mimeType = typeof attachment.mime_type === "string" ? attachment.mime_type.toLowerCase() : "";
  const originalName = typeof attachment.original_name === "string" ? attachment.original_name.toLowerCase() : "";
  if (!storageKey.startsWith("/uploads/")) return "skip";
  if (IMAGE_MIMES.has(mimeType)) return "image";
  if (mimeType === "application/json" || storageKey.toLowerCase().endsWith(".json") || originalName.endsWith(".json")) {
    return "json";
  }
  return "skip";
}

export function attachmentKindsForResource(
  resource: string,
  options?: { jsonOnly?: boolean; allAssignmentFiles?: boolean },
): ReadonlySet<"json" | "image"> | null {
  if (options?.jsonOnly) return new Set(["json"]);
  if (options?.allAssignmentFiles && GRADER_READ_RESOURCES.has(resource)) {
    return new Set(["json", "image"]);
  }
  if (resource === "questions" || resource === "assignment_items") return new Set(["json"]);
  if (resource === "answer_attempts") return new Set(["json", "image"]);
  return null;
}

export function shouldLoadAttachment(
  resource: string,
  attachment: Attachment,
  options?: { jsonOnly?: boolean; allAssignmentFiles?: boolean },
): boolean {
  const allowed = attachmentKindsForResource(resource, options);
  if (!allowed) return false;
  const kind = classifyMinervaAttachment(attachment);
  return kind !== "skip" && allowed.has(kind);
}

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coerceEvidenceItem(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return value;
  const source = asRecord(item.source) ?? {};
  const gradingResultId = item.grading_result_id ?? source.grading_result_id;
  if (typeof gradingResultId === "string" && gradingResultId && !asRecord(item.source)?.grading_result_id) {
    item.source = { ...source, grading_result_id: gradingResultId };
  }
  return item;
}

export function coerceEvaluatorWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const bufferItems = payload.buffer_items;
  if (Array.isArray(bufferItems)) {
    payload.buffer_items = bufferItems.map((item) => {
      const record = asRecord(item);
      if (!record || !Array.isArray(record.evidence)) return item;
      return { ...record, evidence: record.evidence.map((entry) => coerceEvidenceItem(entry)) };
    });
  }
  if (Array.isArray(payload.operations)) {
    payload.operations = payload.operations.map((operation) => {
      const record = asRecord(operation);
      if (!record || typeof record.path !== "string" || !record.path.startsWith("/evidence_buffer/")) {
        return operation;
      }
      const value = asRecord(record.value);
      if (!value || !Array.isArray(value.evidence)) return operation;
      return {
        ...record,
        value: { ...value, evidence: value.evidence.map((entry) => coerceEvidenceItem(entry)) },
      };
    });
  }
  return payload;
}

function errorResult(message: string): never {
  // Pi marks normal returns successful. Throw to persist a real tool error.
  throw new Error(message);
}

function isAssessment(value: unknown): boolean {
  const record = asRecord(value);
  return record?.schema_version === "minerva-assessment/0.1" || Array.isArray(record?.student_submissions);
}

export function markerAssessmentView(value: unknown, record: unknown): unknown {
  const assessment = asRecord(value);
  const snapshot = asRecord(asRecord(record)?.question_snapshot);
  if (!assessment || !snapshot || snapshot.source !== "adapter" || !snapshot.question_id) {
    throw new Error("无法将完整 Assessment 安全定位到当前题目，禁止向 Marker 展开整份答卷");
  }
  const question = Array.isArray(assessment.questions)
    ? assessment.questions.find((item) => asRecord(item)?.question_id === snapshot.question_id)
    : null;
  if (!question) throw new Error("Assessment 缺少当前题目，不能继续批改");
  // Persisted snapshots contain the question/rubric, but not resolved assets.
  // Never expose student_submissions or unrelated questions and images.
  const assets = asRecord(assessment.assets) ?? {};
  const selected: Record<string, unknown> = Object.create(null);
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const block = asRecord(node);
    if (!block) return;
    if (block.type === "image" && typeof block.asset_id === "string") {
      if (!Object.hasOwn(assets, block.asset_id) || !asRecord(assets[block.asset_id])) throw new Error(`题目图片资产缺失：${block.asset_id}`);
      selected[block.asset_id] = assets[block.asset_id];
    }
    Object.values(block).forEach(visit);
  };
  visit(question);
  // Global assessment warnings concern the common grading material and must
  // not disappear when the redundant document body is removed.
  return { assets: selected, uncertainties: assessment.uncertainties ?? [] };
}

function collectAttachments(value: unknown, bucket: Attachment[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectAttachments(item, bucket);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const storageKey = typeof record.storage_key === "string"
    ? record.storage_key
    : typeof record.source_path === "string"
      ? record.source_path
      : "";
  if (storageKey) {
    bucket.push({
      storage_key: storageKey,
      mime_type: record.mime_type,
      original_name: record.original_name,
    });
  }
  for (const nested of Object.values(record)) collectAttachments(nested, bucket);
}

function injectJsonContent(value: unknown, byKey: Map<string, unknown>) {
  if (Array.isArray(value)) {
    for (const item of value) injectJsonContent(item, byKey);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const storageKey = typeof record.storage_key === "string" ? record.storage_key : "";
  if (storageKey && byKey.has(storageKey)) {
    record.content = byKey.get(storageKey);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === "content") continue;
    injectJsonContent(nested, byKey);
  }
}

function dropQuestionSourceFiles(value: unknown) {
  if (Array.isArray(value)) {
    const attachments = value.every((item) => item && typeof item === "object" && "storage_key" in item);
    if (attachments) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (classifyMinervaAttachment(value[index] as Attachment) !== "json") value.splice(index, 1);
      }
      return;
    }
    for (const item of value) dropQuestionSourceFiles(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const nested of Object.values(value)) dropQuestionSourceFiles(nested);
}

async function loadRecordAttachments(
  resource: string,
  records: unknown[],
  options?: {
    jsonOnly?: boolean;
    allAssignmentFiles?: boolean;
    assignmentId?: string;
    markerMode?: boolean;
    attachmentOffset?: number;
    attachmentLimit?: number;
  },
): Promise<{
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  totalImages: number;
  nextAttachmentOffset: number | null;
  failedAttachments: string[];
}> {
  const jsonOnly = Boolean(options?.jsonOnly);
  const allowed = attachmentKindsForResource(resource, options);
  if (!allowed) return { images: [], totalImages: 0, nextAttachmentOffset: null, failedAttachments: [] };
  if (jsonOnly || (!options?.allAssignmentFiles && (resource === "questions" || resource === "assignment_items"))) {
    dropQuestionSourceFiles(records);
  }
  const attachments: Attachment[] = [];
  collectAttachments(records, attachments);
  const jsonByKey = new Map<string, unknown>();
  const loadedJsonKeys = new Set<string>();
  const failedAttachments: string[] = [];
  for (const attachment of attachments) {
    const storageKey = typeof attachment.storage_key === "string" ? attachment.storage_key : "";
    const kind = classifyMinervaAttachment(attachment);
    if (options?.assignmentId && !storageKey.startsWith(`/uploads/assignments/${options.assignmentId}/`)) continue;
    if (kind !== "json" || !allowed.has(kind) || loadedJsonKeys.has(storageKey)) continue;
    loadedJsonKeys.add(storageKey);
    try {
      const response = await fetch(`${dataApiUrl()}${storageKey}`, { cache: "no-store" });
      if (!response.ok) {
        failedAttachments.push(storageKey);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || (!options?.allAssignmentFiles && bytes.length > MAX_ATTACHMENT_BYTES)) {
        failedAttachments.push(storageKey);
        continue;
      }
      const text = bytes.toString("utf8");
      try {
        const parsed = JSON.parse(text);
        jsonByKey.set(storageKey, parsed);
        if (!options?.markerMode || !isAssessment(parsed)) collectAttachments(parsed, attachments);
      } catch {
        if (options?.markerMode) failedAttachments.push(storageKey);
        else jsonByKey.set(storageKey, text);
      }
    } catch {
      failedAttachments.push(storageKey);
    }
  }
  if (jsonByKey.size > 0) {
    for (const record of records) {
      const scoped = new Map(jsonByKey);
      if (options?.markerMode) {
        for (const [key, value] of scoped) {
          if (isAssessment(value)) scoped.set(key, markerAssessmentView(value, record));
        }
      }
      injectJsonContent(record, scoped);
      collectAttachments(record, attachments);
    }
  }

  const uniqueImageKeys = new Set<string>();
  const imageAttachments = attachments.filter((attachment) => {
    const storageKey = typeof attachment.storage_key === "string" ? attachment.storage_key : "";
    if (options?.assignmentId && !storageKey.startsWith(`/uploads/assignments/${options.assignmentId}/`)) return false;
    if (classifyMinervaAttachment(attachment) !== "image" || !allowed.has("image") || uniqueImageKeys.has(storageKey)) return false;
    uniqueImageKeys.add(storageKey);
    return true;
  });
  const offset = Math.max(0, Math.floor(options?.attachmentOffset ?? 0));
  const configuredLimit = Math.max(1, Math.floor(options?.attachmentLimit ?? MAX_ATTACHMENT_IMAGES));
  const limit = options?.allAssignmentFiles ? Math.min(configuredLimit, 4) : Math.min(configuredLimit, MAX_ATTACHMENT_IMAGES);
  const selected = imageAttachments.slice(offset, offset + limit);
  // The existing page cap bounds IO concurrency; Promise.all retains source order.
  const loadedImages = await Promise.all(selected.map(async (attachment) => {
    const storageKey = String(attachment.storage_key);
    try {
      const response = await fetch(`${dataApiUrl()}${storageKey}`, { cache: "no-store" });
      if (!response.ok) {
        failedAttachments.push(storageKey);
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || (!options?.allAssignmentFiles && bytes.length > MAX_ATTACHMENT_BYTES)) {
        failedAttachments.push(storageKey);
        return null;
      }
      return {
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: typeof attachment.mime_type === "string" ? attachment.mime_type : "image/png",
      };
    } catch {
      failedAttachments.push(storageKey);
      return null;
    }
  }));
  const images = loadedImages.filter((image) => image !== null);
  return {
    images,
    totalImages: imageAttachments.length,
    nextAttachmentOffset: offset + selected.length < imageAttachments.length ? offset + selected.length : null,
    failedAttachments: [...new Set(failedAttachments)],
  };
}

export function createMinervaDataExtension(options?: {
  jsonAttachmentsOnly?: boolean;
  graderAssignmentId?: string;
  graderStudentId?: string;
  graderSubmissionId?: string;
  evaluatorAssignmentId?: string;
  evaluatorStudentId?: string;
  evaluatorSubmissionId?: string;
  evaluatorObservationUpdatedAt?: string | null;
}): InlineExtension {
  const evaluatorAssignmentId = options?.evaluatorAssignmentId?.trim() ?? "";
  const evaluatorMode = Boolean(evaluatorAssignmentId);
  const evaluatorStudentId = options?.evaluatorStudentId?.trim() ?? "";
  const evaluatorSubmissionId = options?.evaluatorSubmissionId?.trim() ?? "";
  const jsonOnly = Boolean(options?.jsonAttachmentsOnly || evaluatorMode);
  const graderAssignmentId = options?.graderAssignmentId?.trim() ?? "";
  const graderStudentId = options?.graderStudentId?.trim() ?? "";
  const graderSubmissionId = options?.graderSubmissionId?.trim() ?? "";
  const graderMode = Boolean(graderAssignmentId);
  if (evaluatorMode && (!evaluatorStudentId || !evaluatorSubmissionId)) {
    throw new Error("Evaluator session requires assignment_id, student_id, and submission_id");
  }
  return {
    name: HOST_MINERVA_DATA_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      let graderReadFailed = false;
      const readError = (message: string) => {
        if (graderMode) graderReadFailed = true;
        return errorResult(message);
      };
      pi.registerTool(defineTool({
        name: "read_minerva",
        label: "Read Minerva",
        description: graderMode
          ? "Read JSON records and JSON/image attachments for this Marker session's assigned assignment only. No PDF and no raw SQL."
          : evaluatorMode
          ? "Read only this Evaluator session's bound student's normalized answers, valid AI grading evidence, Student Profile, and Evidence Buffer."
          : jsonOnly
          ? "Read Minerva PostgreSQL JSON records only. No images or PDF. No raw SQL."
          : "Read Minerva PostgreSQL records. No raw SQL. Use resource names such as assignments, submissions, questions, answer_attempts, and grading_results.",
        promptSnippet: "Read Minerva assignment and student records",
        promptGuidelines: graderMode
          ? [
              "Read only the assignment_id bound to this Marker session.",
              "Read questions once for the list and scoring basis; do not also read assignment_items for the same information. Then pass question_id for each answer_attempts read and for question images.",
              "Each question may include JSON and image evidence; PDF files are not opened. Continue attachment_offset only when that question has more images.",
              "Read the scoring basis before student submissions, and do not read student profiles or observation data.",
            ]
          : evaluatorMode
          ? [
              "Read student_description and evidence_buffer for the student bound to this Evaluator session.",
              "Read every grading_results page for the bound assignment, student, and submission before making an observation.",
              "grading_results includes question context, normalized answer_payload, and structured Marker results. Images, PDF, private profiles, other students, and other assignments are forbidden.",
            ]
          : jsonOnly
          ? [
              "Use read_minerva to read JSON records only: student_description, evidence_buffer, grading_results, and other JSON fields.",
              "Never load images, PDF, or original submission files.",
              "Pass assignment_id for grading_results. Pass student_id for student_description or evidence_buffer.",
            ]
          : [
              "Use read_minerva to inspect assignments, submissions, answers, and existing AI grades.",
              "Pass assignment_id when reading submissions, questions, answer_attempts, or grading_results. Pass student_id when reading student_description or evidence_buffer.",
              "Questions load JSON only. Student answers load images and JSON. PDF files are not opened.",
              "Do not request include_private when scoring.",
            ],
        parameters: Type.Object({
          resource: evaluatorMode
              ? Type.Union([
                Type.Literal("grading_results"),
                Type.Literal("student_description"),
                Type.Literal("evidence_buffer"),
              ])
            : Type.String({
            description: graderMode
              ? "assignments | submissions | questions | assignment_items | answer_attempts | grading_results"
              : "assignments | submissions | students | classes | enrollments | questions | assignment_items | answer_attempts | grading_results | audit_logs | student_description | evidence_buffer | graded_students",
          }),
          id: Type.Optional(Type.String({ description: "Record UUID" })),
          assignment_id: Type.Optional(Type.String({ description: "Assignment UUID" })),
          student_id: Type.Optional(Type.String({ description: "Student UUID" })),
          submission_id: Type.Optional(Type.String({ description: "Submission UUID. Marker sessions are bound to the current submitted version." })),
          question_id: Type.Optional(Type.String({ description: "Question UUID. Required for Marker answer_attempts reads." })),
          status: Type.Optional(Type.String({ description: "Optional assignment status filter" })),
          limit: Type.Optional(Type.Number({ description: "Max rows, 1-200. Default 50." })),
          offset: Type.Optional(Type.Number({ description: "Record offset for program-controlled pagination" })),
          attachment_offset: Type.Optional(Type.Number({ description: "Image attachment offset. Marker receives at most 4 images per call." })),
          attachment_limit: Type.Optional(Type.Number({ description: "Requested image count, capped at 4 for Marker." })),
          include_private: Type.Optional(Type.Boolean({ description: "Include private student profile fields. Default false." })),
          grader_type: Type.Optional(Type.String({ description: "Optional grading source filter: rule | ai | teacher. Evaluator is forced to ai." })),
        }),
        async execute(_toolCallId, params) {
          if (evaluatorMode && !EVALUATOR_READ_RESOURCES.has(params.resource)) {
            return readError(`Evaluator 不能读取观察任务范围外的资源: ${params.resource}`);
          }
          if (evaluatorMode && params.assignment_id && params.assignment_id !== evaluatorAssignmentId) {
            return readError("Evaluator 只能读取当前会话绑定的 assignment_id");
          }
          if (evaluatorMode && params.include_private) {
            return readError("Evaluator 不能读取学生隐私字段");
          }
          if (evaluatorMode && params.student_id && params.student_id !== evaluatorStudentId) {
            return readError("Evaluator 只能读取当前会话绑定的 student_id");
          }
          if (evaluatorMode && params.submission_id && params.submission_id !== evaluatorSubmissionId) {
            return readError("Evaluator 只能读取当前会话绑定的 submission_id");
          }
          if (graderMode && !GRADER_READ_RESOURCES.has(params.resource)) {
            return readError(`Marker 不能读取当前作业范围外的资源: ${params.resource}`);
          }
          if (graderMode && params.assignment_id && params.assignment_id !== graderAssignmentId) {
            return readError("Marker 只能读取当前会话绑定的 assignment_id");
          }
          if (graderMode && params.resource === "assignments" && params.id && params.id !== graderAssignmentId) {
            return readError("Marker 只能读取当前会话绑定的 assignment_id");
          }
          if (graderMode && graderStudentId && params.student_id && params.student_id !== graderStudentId) {
            return readError("Marker 只能读取当前工作会话绑定的 student_id");
          }
          if (graderMode && graderSubmissionId && params.submission_id && params.submission_id !== graderSubmissionId) {
            return readError("Marker 只能读取当前工作会话绑定的 submission_id");
          }
          if (graderMode && params.resource === "answer_attempts" && !params.question_id) {
            return readError("Marker 读取学生作答时必须提供 question_id，以便只加载当前题目的 JSON 和图片");
          }
          const query = new URLSearchParams({ resource: params.resource });
          if (graderMode && params.resource === "assignments") query.set("id", graderAssignmentId);
          else if (params.id) query.set("id", params.id);
          if (evaluatorMode && params.resource === "grading_results") query.set("assignment_id", evaluatorAssignmentId);
          else if (graderMode && params.resource !== "assignments") query.set("assignment_id", graderAssignmentId);
          else if (params.assignment_id) query.set("assignment_id", params.assignment_id);
          if (evaluatorMode) {
            query.set("student_id", evaluatorStudentId);
          } else if (graderMode && graderStudentId && ["submissions", "answer_attempts", "grading_results"].includes(params.resource)) {
            query.set("student_id", graderStudentId);
          } else if (params.student_id) query.set("student_id", params.student_id);
          if (evaluatorMode && params.resource === "grading_results") {
            query.set("submission_id", evaluatorSubmissionId);
          } else if (graderMode && graderSubmissionId && ["answer_attempts", "grading_results"].includes(params.resource)) {
            query.set("submission_id", graderSubmissionId);
          } else if (params.submission_id) query.set("submission_id", params.submission_id);
          if (params.question_id) query.set("question_id", params.question_id);
          if (params.status) query.set("status", params.status);
          if (params.limit != null) query.set("limit", String(params.limit));
          if (params.offset != null) query.set("offset", String(params.offset));
          if (params.include_private) query.set("include_private", "true");
          if (evaluatorMode && params.resource === "grading_results") query.set("grader_type", "ai");
          else if (params.grader_type) query.set("grader_type", params.grader_type);
          try {
            const response = await fetch(`${dataApiUrl()}/api/minerva/read?${query}`, {
              cache: "no-store",
              headers: { Accept: "application/json" },
            });
            const payload = await response.json();
            if (!response.ok) {
              return readError(typeof payload.detail === "string" ? payload.detail : `读取失败 HTTP ${response.status}`);
            }
            const records = Array.isArray(payload.records) ? payload.records : [];
            const attachments = await loadRecordAttachments(params.resource, records, {
              jsonOnly,
              allAssignmentFiles: graderMode && Boolean(params.question_id),
              assignmentId: graderMode ? graderAssignmentId : undefined,
              markerMode: graderMode,
              attachmentOffset: params.attachment_offset,
              attachmentLimit: params.attachment_limit,
            });
            if (attachments.failedAttachments.length > 0) {
              return readError(`附件读取失败，不能继续处理：${attachments.failedAttachments.join(", ")}`);
            }
            const visiblePayload = graderMode
              ? {
                  ...payload,
                  attachment_page: {
                    total_images: attachments.totalImages,
                    next_attachment_offset: attachments.nextAttachmentOffset,
                  },
                }
              : payload;
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(visiblePayload) },
                ...attachments.images,
              ],
              details: {
                resource: params.resource,
                count: records.length,
                totalImages: attachments.totalImages,
                nextAttachmentOffset: attachments.nextAttachmentOffset,
              },
            };
          } catch (error) {
            return readError(error instanceof Error ? error.message : String(error));
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "write_minerva",
        label: "Write Minerva",
        description: graderMode
          ? "Write grading results for this Marker session's assigned student only. feedback stores grading evidence. The host finalizes the assignment."
          : evaluatorMode
          ? "Atomically update the three-part Student Profile and structured Evidence Buffer for this Evaluator session's bound student."
          : "Write Minerva records. kind must be grading, student_description, or evidence_buffer. Grading writes grading_results; finalize=true marks the assignment 完成批改.",
        promptSnippet: graderMode ? "Write scores and grading evidence" : evaluatorMode ? "Update student observations" : "Write Minerva grading results",
        promptGuidelines: graderMode
          ? [
              "Use kind=grading only and write only the assignment_id bound to this Marker session.",
              "Use feedback for the grading basis: concise for objective or fill-in items, detailed and rubric-linked for constructed responses.",
              "Each item must also include error_type, knowledge_results, and rubric_items. Do not leave those facts only in feedback.",
              "Write all missing question results for the assigned student. Never call finalize; the host performs the assignment-wide completeness check.",
            ]
          : evaluatorMode
            ? [
              "Use only kind=student_observation for the current bound student.",
              "Use operations for all changes. Each operation changes one allowed profile node or one buffer candidate and carries its own reason and current-assignment grading_result_id.",
              "Set a whole knowledge point at /description/knowledge_profile/knowledge_points/{knowledge_id}; set one fixed profile array at /description/{section}/{attribute}; set or remove one buffer candidate at /evidence_buffer/{candidate_id}.",
              "Preserve teacher-authored observations unless evidence justifies a substantive change. mastery_level is an integer from 1 to 5 or null.",
              "Each evidence item and evidence_ref may supply only grading_result_id; the host fills assignment, submission, question, and answer IDs from that grade.",
              "The final evaluation_complete write must include report_significance so the assignment report can consume it.",
              "Never write grading results and never finalize an assignment.",
            ]
          : [
              "Use write_minerva kind=grading to save AI scores and Chinese feedback.",
              "Skip students that already have AI grades.",
              "Call finalize=true only after every submitted student has AI grades.",
            ],
        parameters: Type.Object({
          kind: graderMode
            ? Type.Literal("grading")
            : evaluatorMode
              ? Type.Literal("student_observation")
              : Type.String({ description: "grading | student_description | evidence_buffer" }),
          assignment_id: Type.String({ description: "Assignment UUID" }),
          student_id: graderMode && graderStudentId
            ? Type.Literal(graderStudentId, { description: "This worker's bound student; required on every grading write." })
            : Type.Optional(Type.String({ description: "Required when saving per-student grading, description, or buffer items" })),
          ...(!graderMode ? { authored_by: evaluatorMode ? Type.Optional(Type.Literal("agent")) : Type.Optional(Type.String({ description: "agent or teacher. Used for student_description." })) } : {}),
          ...(evaluatorMode ? {
            evaluation_complete: Type.Optional(Type.Boolean({ description: "Set true on the final write, including when operations is empty. Freezes the profile, evidence buffer, and report_significance for reporting." })),
            report_significance: Type.Optional(Type.Object({
                include_in_teacher_report: Type.Boolean({ description: "True for medium or strong signals the teacher should see, even if the Student Profile did not change." }),
                level: Type.Union([
                  Type.Literal("none"),
                  Type.Literal("low"),
                  Type.Literal("medium"),
                  Type.Literal("high"),
                ]),
                type: Type.Optional(Type.Union([
                  Type.Literal("progress"),
                  Type.Literal("unusual_performance"),
                  Type.Literal("mixed_performance"),
                  Type.Literal("observation"),
                  Type.Null(),
                ])),
                message: Type.Optional(Type.String({ description: "One Chinese sentence the report can use directly." })),
                question_ids: Type.Optional(Type.Array(Type.String())),
                buffer_candidate_ids: Type.Optional(Type.Array(Type.String())),
              }, { additionalProperties: false })),
            operations: Type.Optional(Type.Array(Type.Object({
                op: Type.Union([Type.Literal("set"), Type.Literal("remove")]),
                path: Type.String({ description: "Exact allowed JSON Pointer for one knowledge point, one fixed profile array, or one buffer candidate." }),
                value: Type.Optional(Type.Any({ description: "Required for set; omit for remove." })),
                reason: Type.String({ minLength: 1, description: "Why this single update follows from the current assignment." }),
                evidence_refs: Type.Array(Type.Object({
                  grading_result_id: Type.String({ description: "A real AI grading result from the current assignment and student." }),
                }, { additionalProperties: false }), { minItems: 1 }),
              }, { additionalProperties: false }))),
          } : graderMode ? {} : {
            fields: Type.Optional(Type.Any({ description: "Partial student_description fields to merge" })),
            profile_fields: Type.Optional(Type.Any()),
            change_notes: Type.Optional(Type.Array(Type.Any())),
            buffer_items: Type.Optional(Type.Any()),
          }),
          ...(!graderMode && !evaluatorMode ? {
            finalize: Type.Optional(Type.Boolean({ description: "When true, mark the assignment graded if every submitted student has AI grades" })),
          } : {}),
          overall_feedback: Type.Optional(Type.String({ description: "Optional whole-paper comment" })),
          model_name: Type.Optional(Type.String({ description: "Optional model name stored with the grade" })),
          items: graderMode ? Type.Array(Type.Object({
            question_id: Type.String({ description: "Question UUID" }),
            score: Type.Number({ description: "Score written with Arabic numerals, from 0 through the question's database max_score." }),
            feedback: Type.Optional(Type.String({ description: "Grading basis. Keep objective/fill-in items concise; explain rubric evidence, awarded points, and deductions for constructed responses." })),
            is_correct: Type.Optional(Type.Boolean()),
            max_score: Type.Optional(Type.Number()),
            confidence: Type.Optional(Type.Number()),
            error_type: Type.Optional(Type.String({ description: "none | conceptual_error | procedural_error | careless_error | blank | unreadable" })),
            knowledge_results: Type.Optional(Type.Array(Type.Object({
              knowledge_id: Type.String({ description: "Must match the question knowledge_points or analysis.main_concepts." }),
              result: Type.String({ description: "correct | incorrect | partial | not_assessed" }),
              note: Type.Optional(Type.String()),
            }))),
            rubric_items: Type.Optional(Type.Array(Type.Object({
              requirement: Type.String(),
              score: Type.Number(),
              max_score: Type.Optional(Type.Number()),
              hit: Type.Optional(Type.Boolean()),
            }))),
          })) : Type.Optional(Type.Array(Type.Object({
            question_id: Type.Optional(Type.String()),
            score: Type.Optional(Type.Number()),
            feedback: Type.Optional(Type.String()),
            is_correct: Type.Optional(Type.Boolean()),
            max_score: Type.Optional(Type.Number()),
            confidence: Type.Optional(Type.Number()),
            error_type: Type.Optional(Type.String()),
            knowledge_results: Type.Optional(Type.Array(Type.Any())),
            rubric_items: Type.Optional(Type.Array(Type.Any())),
          }))),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
          if (graderMode && graderReadFailed) {
            return errorResult("本次 Marker 会话此前读取数据或附件失败，禁止写入成绩；请等待主机自动重试");
          }
          if (evaluatorMode && (params as { finalize?: boolean }).finalize) {
            return errorResult("Evaluator 不能 finalize");
          }
          if (evaluatorMode && params.kind !== "student_observation") {
            return errorResult("Evaluator 只能写入 student_observation");
          }
          if (evaluatorMode && params.assignment_id !== evaluatorAssignmentId) {
            return errorResult("Evaluator 只能写入当前会话绑定的 assignment_id");
          }
          if (evaluatorMode && params.student_id && params.student_id !== evaluatorStudentId) {
            return errorResult("Evaluator 只能更新当前会话绑定的 student_id");
          }
          if (graderMode && (params as { finalize?: boolean }).finalize) {
            return errorResult("Marker 不能 finalize；宿主会在所有学生批改完成后统一执行完整性检查");
          }
          if (graderMode && params.kind !== "grading") {
            return errorResult("Marker 只能使用 kind=grading");
          }
          if (graderMode && params.assignment_id !== graderAssignmentId) {
            return errorResult("Marker 只能写入当前会话绑定的 assignment_id");
          }
          if (graderMode && graderStudentId && params.student_id !== graderStudentId) {
            return errorResult("Marker 只能写入当前工作会话绑定的 student_id");
          }
          try {
            const response = await fetch(`${dataApiUrl()}/api/minerva/write`, {
              method: "POST",
              cache: "no-store",
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify(graderMode
                ? {
                    ...params,
                    kind: "grading",
                    assignment_id: graderAssignmentId,
                    ...(graderStudentId ? { student_id: graderStudentId } : {}),
                    ...(graderSubmissionId ? { submission_id: graderSubmissionId } : {}),
                  }
                : evaluatorMode
                  ? coerceEvaluatorWrite({
                      ...params,
                      kind: "student_observation",
                      assignment_id: evaluatorAssignmentId,
                      student_id: evaluatorStudentId,
                      authored_by: "agent",
                      expected_observation_updated_at: options?.evaluatorObservationUpdatedAt ?? null,
                    })
                  : params),
            });
            const payload = await response.json();
            if (!response.ok) {
              return errorResult(typeof payload.detail === "string" ? payload.detail : `写入失败 HTTP ${response.status}`);
            }
            const receipt = evaluatorMode ? {
              kind: payload.kind,
              assignment_id: payload.assignment_id,
              student_id: payload.student_id,
              evaluation_complete: (params as { evaluation_complete?: boolean }).evaluation_complete === true,
              updated_fields: payload.updated_fields,
              changed_paths: Array.isArray(payload.changes) ? payload.changes.map((change: { path?: string }) => change.path) : [],
            } : payload;
            return {
              content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
              details: payload,
            };
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      }));

    },
  };
}
