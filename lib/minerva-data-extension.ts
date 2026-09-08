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

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: undefined,
    isError: true,
  };
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
    attachmentOffset?: number;
    attachmentLimit?: number;
  },
): Promise<{
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  totalImages: number;
  nextAttachmentOffset: number | null;
}> {
  const jsonOnly = Boolean(options?.jsonOnly);
  const allowed = attachmentKindsForResource(resource, options);
  if (!allowed) return { images: [], totalImages: 0, nextAttachmentOffset: null };
  if (jsonOnly || (!options?.allAssignmentFiles && (resource === "questions" || resource === "assignment_items"))) {
    dropQuestionSourceFiles(records);
  }
  const attachments: Attachment[] = [];
  collectAttachments(records, attachments);
  const jsonByKey = new Map<string, unknown>();
  const loadedJsonKeys = new Set<string>();
  for (const attachment of attachments) {
    const storageKey = typeof attachment.storage_key === "string" ? attachment.storage_key : "";
    const kind = classifyMinervaAttachment(attachment);
    if (options?.assignmentId && !storageKey.startsWith(`/uploads/assignments/${options.assignmentId}/`)) continue;
    if (kind !== "json" || !allowed.has(kind) || loadedJsonKeys.has(storageKey)) continue;
    loadedJsonKeys.add(storageKey);
    try {
      const response = await fetch(`${dataApiUrl()}${storageKey}`, { cache: "no-store" });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || (!options?.allAssignmentFiles && bytes.length > MAX_ATTACHMENT_BYTES)) continue;
      const text = bytes.toString("utf8");
      try {
        const parsed = JSON.parse(text);
        jsonByKey.set(storageKey, parsed);
        collectAttachments(parsed, attachments);
      } catch {
        jsonByKey.set(storageKey, text);
      }
    } catch {
      // Keep the JSON metadata even if a single attachment cannot be loaded.
    }
  }
  if (jsonByKey.size > 0) injectJsonContent(records, jsonByKey);

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
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const attachment of selected) {
    const storageKey = String(attachment.storage_key);
    try {
      const response = await fetch(`${dataApiUrl()}${storageKey}`, { cache: "no-store" });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || (!options?.allAssignmentFiles && bytes.length > MAX_ATTACHMENT_BYTES)) continue;
      images.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: typeof attachment.mime_type === "string" ? attachment.mime_type : "image/png",
      });
    } catch {
      // Keep the attachment manifest even if a single image cannot be loaded.
    }
  }
  return {
    images,
    totalImages: imageAttachments.length,
    nextAttachmentOffset: offset + selected.length < imageAttachments.length ? offset + selected.length : null,
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
              "Read the question list first, then pass question_id when reading each question and its answer_attempts.",
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
            return errorResult(`Evaluator 不能读取观察任务范围外的资源: ${params.resource}`);
          }
          if (evaluatorMode && params.assignment_id && params.assignment_id !== evaluatorAssignmentId) {
            return errorResult("Evaluator 只能读取当前会话绑定的 assignment_id");
          }
          if (evaluatorMode && params.include_private) {
            return errorResult("Evaluator 不能读取学生隐私字段");
          }
          if (evaluatorMode && params.student_id && params.student_id !== evaluatorStudentId) {
            return errorResult("Evaluator 只能读取当前会话绑定的 student_id");
          }
          if (evaluatorMode && params.submission_id && params.submission_id !== evaluatorSubmissionId) {
            return errorResult("Evaluator 只能读取当前会话绑定的 submission_id");
          }
          if (graderMode && !GRADER_READ_RESOURCES.has(params.resource)) {
            return errorResult(`Marker 不能读取当前作业范围外的资源: ${params.resource}`);
          }
          if (graderMode && params.assignment_id && params.assignment_id !== graderAssignmentId) {
            return errorResult("Marker 只能读取当前会话绑定的 assignment_id");
          }
          if (graderMode && params.resource === "assignments" && params.id && params.id !== graderAssignmentId) {
            return errorResult("Marker 只能读取当前会话绑定的 assignment_id");
          }
          if (graderMode && graderStudentId && params.student_id && params.student_id !== graderStudentId) {
            return errorResult("Marker 只能读取当前工作会话绑定的 student_id");
          }
          if (graderMode && graderSubmissionId && params.submission_id && params.submission_id !== graderSubmissionId) {
            return errorResult("Marker 只能读取当前工作会话绑定的 submission_id");
          }
          if (graderMode && params.resource === "answer_attempts" && !params.question_id) {
            return errorResult("Marker 读取学生作答时必须提供 question_id，以便只加载当前题目的 JSON 和图片");
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
            const payload = await response.json().catch(() => ({ detail: "数据服务返回了无效响应" }));
            if (!response.ok) {
              return errorResult(typeof payload.detail === "string" ? payload.detail : `读取失败 HTTP ${response.status}`);
            }
            const records = Array.isArray(payload.records) ? payload.records : [];
            const attachments = await loadRecordAttachments(params.resource, records, {
              jsonOnly,
              allAssignmentFiles: graderMode && Boolean(params.question_id),
              assignmentId: graderMode ? graderAssignmentId : undefined,
              attachmentOffset: params.attachment_offset,
              attachmentLimit: params.attachment_limit,
            });
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
            return errorResult(error instanceof Error ? error.message : String(error));
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
              "Write all missing question results for the assigned student. Never call finalize; the host performs the assignment-wide completeness check.",
            ]
          : evaluatorMode
          ? [
              "Use only kind=student_observation for the current bound student.",
              "profile_fields may contain only knowledge_profile, problem_solving_and_learning_profile, or learning_trajectory. mastery_level is an integer from 1 to 5 or null.",
              "buffer_items is the complete active candidate list after this evaluation. Preserve teacher-authored observations unless evidence justifies a substantive change.",
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
          student_id: Type.Optional(Type.String({ description: "Required when saving per-student grading, description, or buffer items" })),
          authored_by: evaluatorMode ? Type.Optional(Type.Literal("agent")) : Type.Optional(Type.String({ description: "agent or teacher. Used for student_description." })),
          evaluation_complete: Type.Optional(Type.Boolean({ description: "Evaluator must set true on its final write, even if no changes are needed (change_notes: []). Freezes profile and evidence for reporting." })),
          fields: !evaluatorMode
            ? Type.Optional(Type.Any({ description: "Partial student_description fields to merge" }))
            : Type.Optional(Type.Any({ description: "Unused in Evaluator mode; use profile_fields." })),
          profile_fields: evaluatorMode
            ? Type.Optional(Type.Object({
                knowledge_profile: Type.Optional(Type.Any({ description: "knowledge_points keyed by existing knowledge_id; mastery_level is integer 1-5 or null." })),
                problem_solving_and_learning_profile: Type.Optional(Type.Any({ description: "Only the four fixed problem-solving/learning arrays plus evidence_refs." })),
                learning_trajectory: Type.Optional(Type.Any({ description: "Only the four fixed trajectory arrays plus evidence_refs." })),
              }, { additionalProperties: false, description: "Only materially changed top-level profile sections." }))
            : Type.Optional(Type.Any()),
          change_notes: Type.Optional(Type.Array(Type.Object({
            path: Type.String({ description: "Exact JSON Pointer of an actual changed value, e.g. /description/learning_trajectory/recent_progress. Arrays are atomic; buffer paths use candidate_id." }),
            reason: Type.String({ minLength: 1, description: "Why this specific change is justified; include promotion/removal rationale where applicable." }),
            evidence_refs: Type.Array(Type.Object({
              grading_result_id: Type.String(),
              assignment_id: Type.Optional(Type.String()),
              submission_id: Type.Optional(Type.String()),
              question_id: Type.Optional(Type.String()),
              answer_attempt_id: Type.Optional(Type.String()),
            }), { minItems: 1 }),
          }), { description: "Required for student_observation: one note per actual changed path. Server computes and stores before/after values." })),
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
          })) : Type.Optional(Type.Array(Type.Object({
            question_id: Type.Optional(Type.String()),
            score: Type.Optional(Type.Number()),
            feedback: Type.Optional(Type.String()),
            is_correct: Type.Optional(Type.Boolean()),
            max_score: Type.Optional(Type.Number()),
            confidence: Type.Optional(Type.Number()),
          }))),
          buffer_items: evaluatorMode ? Type.Optional(Type.Array(Type.Object({
            candidate_id: Type.String({ description: "Stable unique candidate ID" }),
            target: Type.Object({
              profile_section: Type.Union([
                Type.Literal("knowledge_profile"),
                Type.Literal("problem_solving_and_learning_profile"),
                Type.Literal("learning_trajectory"),
              ]),
              knowledge_id: Type.Optional(Type.String({ description: "Required only for knowledge_profile" })),
              attribute: Type.String({ description: "Fixed attribute under the selected profile section" }),
            }, { additionalProperties: false }),
            claim: Type.String({ description: "Specific, testable Chinese candidate judgment" }),
            status: Type.Union([Type.Literal("collecting"), Type.Literal("contradicted")]),
            evidence: Type.Array(Type.Object({
              evidence_id: Type.String(),
              observation: Type.String(),
              relationship: Type.Union([Type.Literal("supports"), Type.Literal("contradicts"), Type.Literal("context_only")]),
              evidence_type: Type.String(),
              relevance: Type.Optional(Type.Number()),
              reliability: Type.Optional(Type.Number()),
              source: Type.Object({
                assignment_id: Type.String(),
                submission_id: Type.String(),
                question_id: Type.String(),
                answer_attempt_id: Type.String(),
                grading_result_id: Type.String(),
                observed_at: Type.Optional(Type.String()),
              }, { additionalProperties: false }),
            }, { additionalProperties: false })),
            assessment: Type.Object({
              confidence: Type.Number(),
              reason: Type.String(),
              missing_evidence: Type.Array(Type.String()),
            }, { additionalProperties: false }),
            recommended_action: Type.Literal("KEEP_BUFFERED"),
            created_at: Type.Optional(Type.String()),
            updated_at: Type.Optional(Type.String()),
          }, { additionalProperties: false }))) : Type.Optional(Type.Any()),
        }),
        async execute(_toolCallId, params) {
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
                  ? {
                      ...params,
                      kind: "student_observation",
                      assignment_id: evaluatorAssignmentId,
                      student_id: evaluatorStudentId,
                      authored_by: "agent",
                    }
                  : params),
            });
            const payload = await response.json().catch(() => ({ detail: "数据服务返回了无效响应" }));
            if (!response.ok) {
              return errorResult(typeof payload.detail === "string" ? payload.detail : `写入失败 HTTP ${response.status}`);
            }
            return {
              content: [{ type: "text" as const, text: JSON.stringify(payload) }],
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
