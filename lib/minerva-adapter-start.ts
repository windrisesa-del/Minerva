import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowFileRoot } from "./file-access";
import {
  ADAPTER_SESSION_TYPE,
  buildAdapterAnswersPrompt,
  buildAdapterQuestionsPrompt,
  type AdapterSessionData,
} from "./minerva-adapter";
import {
  validateAssessment,
  validateAssessmentStudentCoverage,
  validateQuestionsDraft,
  type MinervaAssessment,
} from "./minerva-adapter-schema";
import { startGradingSession } from "./minerva-grading-start";
import { invalidateSessionListCache } from "./session-reader";
import { registerWorkbenchSession, updateWorkbenchSession } from "./assignment-workbench-store";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";
const ADAPTER_PHASE_TIMEOUT_MS = 10 * 60 * 1000;

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

export function resolveMinervaProjectRoot(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
    resolve(process.cwd(), "Minerva"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "backend", "app", "main.py")) && existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  throw new Error("找不到 Minerva 项目目录");
}

async function discardImportedAssignment(assignmentId: string): Promise<void> {
  const response = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404 || response.ok) return;
  const payload = await response.json().catch(() => ({ detail: `HTTP ${response.status}` })) as { detail?: string };
  throw new Error(payload.detail || `HTTP ${response.status}`);
}

async function readCompleteJsonFile(outputPath: string): Promise<string | null> {
  try {
    const text = await readFile(outputPath, "utf8");
    JSON.parse(text);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function waitUntilIdle(
  session: { isRunning(): boolean; send(command: Record<string, unknown>): Promise<unknown> },
  timeoutMs = 15_000,
): Promise<void> {
  if (!session.isRunning()) return;
  await session.send({ type: "abort" }).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  while (session.isRunning() && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function waitForAdapterOutput(
  session: { isRunning(): boolean; send(command: Record<string, unknown>): Promise<unknown> },
  outputPath: string,
  label: string,
  timeoutMs = ADAPTER_PHASE_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readCompleteJsonFile(outputPath);
    if (text) {
      await waitUntilIdle(session);
      return text;
    }
    if (!session.isRunning()) {
      throw new Error(`Adapter ${label} ended without writing a complete JSON file`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Adapter ${label} did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
}

export type AdapterSource = {
  role: "assessment_material" | "student_submission";
  storage_key: string;
  original_name: string;
  mime_type: string;
  student_id?: string;
};

export async function runAdapterPipeline(options: {
  assignmentId: string;
  title: string;
  sources: AdapterSource[];
  unmatched?: { filename: string; reason: string }[];
  cwd?: string;
}) {
  if (!options.sources.length) throw new Error("Adapter has no uploaded sources to process");
  if (options.sources.some((source) => !source.storage_key.startsWith("/uploads/"))) {
    throw new Error("Adapter source path is outside the upload store");
  }
  const cwd = resolveMinervaProjectRoot();
  const runDirectory = resolve(cwd, "backend", ".data", "adapter-runs", options.assignmentId);
  const requestPath = join(runDirectory, "request.json");
  const questionsPath = join(runDirectory, "questions.json");
  const outputPath = join(runDirectory, "assessment.json");
  await mkdir(runDirectory, { recursive: true });
  for (const path of [questionsPath, outputPath]) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const studentIds = [...new Set(options.sources
    .filter((source) => source.role === "student_submission" && source.student_id)
    .map((source) => source.student_id as string))];
  await writeFile(requestPath, `${JSON.stringify({
    schema_version: "minerva-adapter-request/0.1",
    assignment_id: options.assignmentId,
    title: options.title,
    sources: options.sources,
    questions_output_path: questionsPath,
    output_path: outputPath,
    output_contract: {
      schema_version: "minerva-assessment/0.1",
      status: "ungraded",
      questions_file: "metadata, questions, assets, normalized_documents, uncertainties; omit student_submissions",
      assessment_file: "copy questions file, then add student_submissions covering every listed student_id and question_id",
    },
  }, null, 2)}\n`, "utf8");

  const data: AdapterSessionData = {
    version: 1,
    assignmentId: options.assignmentId,
    title: options.title,
    requestPath,
    outputPath,
    questionsPath,
  };
  const { startRpcSession } = await import("./rpc-manager");
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", cwd, {
    adapter: data,
    thinkingLevel: "off",
    persistPreferences: false,
  });
  await registerWorkbenchSession({
    assignmentId: options.assignmentId,
    title: options.title,
    session: { sessionId: realSessionId, role: "adapter", label: "题目与答卷结构化" },
  }).catch((error) => console.error("[minerva] failed to register Adapter workbench session:", error));
  allowFileRoot(cwd);
  invalidateSessionListCache();
  let adapterCompleted = false;
  try {
    await session.send({ type: "prompt", message: buildAdapterQuestionsPrompt(data) });
    validateQuestionsDraft(JSON.parse(await waitForAdapterOutput(session, questionsPath, "questions phase")) as unknown);
    await session.send({ type: "prompt", message: buildAdapterAnswersPrompt(data) });
    const assessment: MinervaAssessment = validateAssessment(
      JSON.parse(await waitForAdapterOutput(session, outputPath, "answers phase")) as unknown,
    );
    validateAssessmentStudentCoverage(assessment, studentIds);
    const saved = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(options.assignmentId)}/assessment`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(assessment),
    });
    const savedBody = await saved.json().catch(() => ({ detail: "Assessment persistence returned invalid JSON" }));
    if (!saved.ok) {
      throw new Error(typeof savedBody.detail === "string" ? savedBody.detail : `Assessment persistence failed with HTTP ${saved.status}`);
    }
    adapterCompleted = true;
    await updateWorkbenchSession(options.assignmentId, realSessionId, { status: "completed" })
      .catch((error) => console.error("[minerva] failed to update Adapter workbench session:", error));
    const grading = await startGradingSession({
      cwd,
      assignmentId: options.assignmentId,
      title: assessment.metadata.title,
      unmatched: options.unmatched,
    });
    return { adapterSessionId: realSessionId, assessment: savedBody, grading };
  } catch (error) {
    await session.shutdown().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    if (!adapterCompleted) {
      await updateWorkbenchSession(options.assignmentId, realSessionId, { status: "failed", error: reason })
        .catch((workbenchError) => console.error("[minerva] failed to update Adapter workbench failure:", workbenchError));
    }
    try {
      await discardImportedAssignment(options.assignmentId);
    } catch (cleanupError) {
      throw new Error(`自动处理失败：${reason}。相关数据清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw new Error(`自动处理失败：${reason}。本次导入数据已清理，请重新导入`);
  }
}

export { ADAPTER_SESSION_TYPE };
