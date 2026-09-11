import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_PATH = join(homedir(), ".pi", "minerva", "evaluator-runs.json");

export interface EvaluatorRunRecord {
  assignmentId: string;
  sessionId: string;
  title: string;
  startedAt: string;
  status?: "running" | "completed" | "failed" | "waiting_for_reconnect" | "archived";
  completedStudents?: number;
  totalStudents?: number;
  error?: string;
  failedAt?: string;
  updatedAt?: string;
  cleanupPending?: boolean;
  hostPid?: number;
}

interface EvaluatorRunStore {
  version: 2;
  runs: Record<string, EvaluatorRunRecord>;
}

const EMPTY_STORE: EvaluatorRunStore = { version: 2, runs: {} };
let mutationQueue: Promise<void> = Promise.resolve();

function validateStore(value: unknown): EvaluatorRunStore {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STORE);
  const candidate = value as Partial<EvaluatorRunStore>;
  if (![1, 2].includes(candidate.version as number) || !candidate.runs || typeof candidate.runs !== "object") {
    return structuredClone(EMPTY_STORE);
  }
  const runs: Record<string, EvaluatorRunRecord> = {};
  for (const [assignmentId, run] of Object.entries(candidate.runs)) {
    if (!run || typeof run !== "object") continue;
    if (typeof run.sessionId !== "string" || !run.sessionId) continue;
    runs[assignmentId] = {
      assignmentId,
      sessionId: run.sessionId,
      title: typeof run.title === "string" ? run.title : "",
      startedAt: typeof run.startedAt === "string" ? run.startedAt : new Date().toISOString(),
      ...(run.status === "running" || run.status === "completed" || run.status === "failed" || run.status === "waiting_for_reconnect" || run.status === "archived" ? { status: run.status } : {}),
      ...(typeof run.completedStudents === "number" ? { completedStudents: run.completedStudents } : {}),
      ...(typeof run.totalStudents === "number" ? { totalStudents: run.totalStudents } : {}),
      ...(typeof run.error === "string" ? { error: run.error } : {}),
      ...(typeof run.failedAt === "string" ? { failedAt: run.failedAt } : {}),
      ...(typeof run.updatedAt === "string" ? { updatedAt: run.updatedAt } : {}),
      ...(run.cleanupPending === true ? { cleanupPending: true } : {}),
      ...(typeof run.hostPid === "number" ? { hostPid: run.hostPid } : {}),
    };
  }
  return { version: 2, runs };
}

export async function readEvaluatorRuns(): Promise<EvaluatorRunRecord[]> {
  try {
    const store = validateStore(JSON.parse(await readFile(STORE_PATH, "utf8")) as unknown);
    return Object.values(store.runs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function upsertEvaluatorRun(run: EvaluatorRunRecord): Promise<EvaluatorRunRecord> {
  let resolveResult!: (value: EvaluatorRunRecord) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<EvaluatorRunRecord>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      let store = structuredClone(EMPTY_STORE);
      try {
        store = validateStore(JSON.parse(await readFile(STORE_PATH, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const stored = { ...run, updatedAt: new Date().toISOString(), hostPid: run.hostPid ?? process.pid };
      store.runs[run.assignmentId] = stored;
      await mkdir(dirname(STORE_PATH), { recursive: true });
      const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      await rename(temporaryPath, STORE_PATH);
      resolveResult(stored);
    } catch (error) {
      rejectResult(error);
    }
  }, (error) => {
    rejectResult(error);
  });
  return result;
}
