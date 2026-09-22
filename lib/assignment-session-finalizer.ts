import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  readAssignmentWorkbench,
  setWorkbenchCurrentSession,
  type WorkbenchSessionEntry,
} from "./assignment-workbench-store";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  resolveSessionPath,
} from "./session-reader";
import { ASSIGNMENT_SESSION_HISTORY_BOUNDARY } from "./assignment-session-display";

const COMPACTION_INSTRUCTIONS = `你正在整理一次作业处理完成后的当前会话内容。
请把此前按时间拼接的 Adapter、Marker、Evaluator 与 Summarizer 原始会话压缩为一份可供 Pi 后续继续对话的上下文。
保留作业身份、题目结构、批改结论、已经确认的学生画像更新、作业报告、异常与尚未解决事项。
Evidence Buffer 是 Evaluator 私有状态，不得保留、概括、引用或推测其中的内容。
明确区分模型判断、数据库事实和工具执行结果。省略重复的工具调用细节、重复读取结果和无后续价值的过程性表述。
不要产生新的评分、学生判断或报告结论。`;

const ROLE_NAMES: Record<WorkbenchSessionEntry["role"], string> = {
  adapter: "Adapter",
  marker: "Marker",
  evaluator: "Evaluator",
  summarizer: "Summarizer",
};

const MAX_COMPACTION_INPUT_CHARS = 850_000;
const MAX_MESSAGE_TEXT_CHARS = 24_000;

function shortenText(text: string, maxChars = MAX_MESSAGE_TEXT_CHARS): string {
  const withoutDataUrls = text.replace(
    /data:(?:image\/[a-z0-9.+-]+|application\/octet-stream);base64,[a-z0-9+/=]+/gi,
    "[二进制 data URL 已省略]",
  );
  if (withoutDataUrls.length <= maxChars) return withoutDataUrls;
  const headLength = Math.floor(maxChars * 0.65);
  const tailLength = maxChars - headLength;
  return `${withoutDataUrls.slice(0, headLength)}\n[过长内容已省略 ${withoutDataUrls.length - maxChars} 字符]\n${withoutDataUrls.slice(-tailLength)}`;
}

export function assignmentSessionTitle(createdAt: string, title: string): string {
  const date = new Date(createdAt);
  const dateText = Number.isNaN(date.getTime())
    ? createdAt.slice(0, 10)
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
  return `${dateText} · ${title}`;
}

const PRIVATE_BUFFER_KEYS = new Set([
  "evidence_buffer",
  "rollback_evidence_buffer",
  "buffer_items",
  "buffer_candidate_ids",
  "buffer_change_refs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactEmbeddedEvaluatorContext(text: string): string {
  const marker = "evaluator_context:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return `${text.slice(0, start)}${JSON.stringify(redactPrivateBuffer(parsed))}${text.slice(index + 1)}`;
        } catch {
          return text;
        }
      }
    }
  }
  return text;
}

function redactPrivateBuffer(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(isRecord(item) && typeof item.path === "string" && item.path.startsWith("/evidence_buffer/")))
      .map(redactPrivateBuffer);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PRIVATE_BUFFER_KEYS.has(key))
      .map(([key, item]) => [key, redactPrivateBuffer(item)]));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(redactPrivateBuffer(JSON.parse(trimmed)));
      } catch {
        // Continue with embedded evaluator-context redaction.
      }
    }
    return redactEmbeddedEvaluatorContext(value);
  }
  return value;
}

function sanitizedJson(value: unknown, evaluatorPrivate = false): string {
  const safeValue = evaluatorPrivate ? redactPrivateBuffer(value) : value;
  return JSON.stringify(safeValue, (key, item) => {
    if (key === "thinking" && typeof item === "string") return "[内部思考过程已省略]";
    if (key === "details") return "[工具详情副本已省略，保留工具结果正文]";
    if (["data", "image", "image_url", "audio_url"].includes(key) && typeof item === "string" && item.length > 2048) {
      return `[二进制内容已省略，原始长度 ${item.length}]`;
    }
    if (typeof item === "string") return shortenText(item);
    return item;
  });
}

function evaluatorMessageForWorkbench(value: unknown): unknown {
  const redacted = redactPrivateBuffer(value);
  if (!isRecord(redacted) || redacted.role !== "assistant") return redacted;
  if (!Array.isArray(redacted.content)) {
    return { ...redacted, content: "[Evaluator 过程说明已省略；仅保留结构化画像写入]" };
  }
  const content = redacted.content.filter((block) => (
    !isRecord(block) || (block.type !== "text" && block.type !== "thinking")
  ));
  return {
    ...redacted,
    content: content.length ? content : [{ type: "text", text: "[Evaluator 过程说明已省略；仅保留结构化画像写入]" }],
  };
}

export function fitTranscriptBlocks(blocks: string[][], maxChars = MAX_COMPACTION_INPUT_CHARS): string[] {
  if (blocks.length === 0) return [];
  const joined = blocks.map((block) => block.join("\n"));
  if (joined.reduce((sum, block) => sum + block.length, 0) <= maxChars) return joined;
  const quota = Math.max(2_000, Math.floor(maxChars / blocks.length));
  return joined.map((block) => shortenText(block, quota));
}

export function serializeWorkbenchSession(
  session: WorkbenchSessionEntry,
  entries: Array<Record<string, unknown>>,
): string[] {
  const lines = [
    `===== ${ROLE_NAMES[session.role]} · ${session.label} =====`,
    `session_id: ${session.sessionId}`,
    `started_at: ${session.startedAt}`,
    `status: ${session.status}`,
  ];
  if (session.studentId) lines.push(`student_id: ${session.studentId}`);
  if (session.submissionId) lines.push(`submission_id: ${session.submissionId}`);
  if (session.error) lines.push(`error: ${session.error}`);

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message as { role?: unknown };
      const safeMessage = session.role === "evaluator" ? evaluatorMessageForWorkbench(entry.message) : entry.message;
      lines.push(`\n[${typeof message.role === "string" ? message.role : "message"}]\n${sanitizedJson(safeMessage, session.role === "evaluator")}`);
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      lines.push(`\n[既有压缩摘要]\n${session.role === "evaluator" ? "[Evaluator 既有摘要已省略]" : entry.summary}`);
    } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      lines.push(`\n[分支摘要]\n${session.role === "evaluator" ? "[Evaluator 分支摘要已省略]" : entry.summary}`);
    }
  }
  return lines;
}

export function chunkTranscript(parts: string[], maxChars = 12000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length + 2 > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (part.length <= maxChars) {
      current += `${current ? "\n\n" : ""}${part}`;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    for (let offset = 0; offset < part.length; offset += maxChars) chunks.push(part.slice(offset, offset + maxChars));
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function finalizeAssignmentSession(options: {
  cwd: string;
  assignmentId: string;
  title: string;
  compact?: boolean;
}): Promise<string | null> {
  const workbench = await readAssignmentWorkbench(options.assignmentId);
  if (!workbench) return null;
  if (workbench.currentSession?.status === "ready" && workbench.currentSession.privacyVersion === 1) {
    const existingPath = await resolveSessionPath(workbench.currentSession.sessionId);
    if (existingPath && existsSync(existingPath)) {
      const existingManager = SessionManager.open(existingPath);
      const currentModel = existingManager.buildSessionContext().model;
      if (currentModel?.provider === "minerva-local" || currentModel?.modelId === "assignment-workbench") {
        const preferredModel = existingManager.getEntries().find((entry) => (
          entry.type === "model_change" && entry.provider !== "minerva-local"
        ));
        if (preferredModel?.type === "model_change") {
          existingManager.appendModelChange(preferredModel.provider, preferredModel.modelId);
        }
      }
      cacheSessionPath(workbench.currentSession.sessionId, existingPath);
      return workbench.currentSession.sessionId;
    }
    invalidateSessionPathCache(workbench.currentSession.sessionId);
  }

  const ordered = [...workbench.sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const transcriptBlocks: string[][] = [];
  for (const source of ordered) {
    const path = await resolveSessionPath(source.sessionId);
    if (!path) {
      transcriptBlocks.push([`===== ${ROLE_NAMES[source.role]} · ${source.label} =====\n[原始会话文件未找到]`]);
      continue;
    }
    const entries = SessionManager.open(path).getBranch() as unknown as Array<Record<string, unknown>>;
    transcriptBlocks.push(serializeWorkbenchSession(source, entries));
  }
  const transcript = fitTranscriptBlocks(transcriptBlocks);
  if (transcript.length === 0) return null;

  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", options.cwd);
  const createdAt = new Date().toISOString();
  await setWorkbenchCurrentSession(options.assignmentId, {
    sessionId: realSessionId,
    status: "building",
    compacted: false,
    createdAt,
    privacyVersion: 1,
  });
  invalidateSessionListCache();

  try {
    await session.send({
      type: "set_session_name",
      name: assignmentSessionTitle(workbench.createdAt, workbench.title || options.title),
    });
    const manager = session.inner.sessionManager;
    manager.appendMessage({ role: "user", content: "以下是本次作业四个处理阶段按时间直接拼接的完整会话记录。请将它作为当前作业会话的历史。", timestamp: Date.now() });
    for (const chunk of chunkTranscript(transcript)) {
      manager.appendMessage({ role: "user", content: chunk, timestamp: Date.now() });
    }
    const activeModel = session.inner.model;
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: ASSIGNMENT_SESSION_HISTORY_BOUNDARY }],
      api: "minerva-local",
      provider: "minerva-local",
      model: "assignment-workbench",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    if (activeModel) manager.appendModelChange(activeModel.provider, activeModel.id);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      throw new Error("合并后的当前会话未能写入磁盘");
    }
    cacheSessionPath(realSessionId, sessionFile);

    let compacted = false;
    if (options.compact !== false) {
      compacted = true;
      try {
        await session.send({ type: "compact", customInstructions: COMPACTION_INSTRUCTIONS });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Nothing to compact (session too small)")) {
          console.error("[minerva] workbench compaction failed; keeping bounded merged context:", error instanceof Error ? error.message : error);
        }
        compacted = false;
      }
    }

    await setWorkbenchCurrentSession(options.assignmentId, {
      sessionId: realSessionId,
      status: "ready",
      compacted,
      createdAt,
      privacyVersion: 1,
    });
    invalidateSessionListCache();
    return realSessionId;
  } catch (error) {
    await setWorkbenchCurrentSession(options.assignmentId, {
      sessionId: realSessionId,
      status: "failed",
      compacted: false,
      createdAt,
      privacyVersion: 1,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    await session.shutdown().catch(() => undefined);
  }
}
