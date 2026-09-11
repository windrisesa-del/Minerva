import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_PATH = join(homedir(), ".pi", "minerva", "grading-runs.json");

export interface GradingRunRecord {
  assignmentId: string;
  sessionId: string;
  title: string;
  startedAt: string;
  status?: "running" | "completed" | "failed" | "waiting_for_reconnect" | "archived";
  completedStudents?: number;
  totalStudents?: number;
  error?: string;
  failedAt?: string;
  hostPid?: number;
}

interface GradingRunStore {
  version: 1;
  runs: Record<string, GradingRunRecord>;
}

const EMPTY_STORE: GradingRunStore = { version: 1, runs: {} };
let mutationQueue: Promise<void> = Promise.resolve();

function validateStore(value: unknown): GradingRunStore {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STORE);
  const candidate = value as Partial<GradingRunStore>;
  if (candidate.version !== 1 || !candidate.runs || typeof candidate.runs !== "object") {
    return structuredClone(EMPTY_STORE);
  }
  const runs: Record<string, GradingRunRecord> = {};
  for (const [assignmentId, run] of Object.entries(candidate.runs)) {
    if (!run || typeof run !== "object") continue;
    if (typeof run.sessionId !== "string" || !run.sessionId) continue;
    runs[assignmentId] = {
      assignmentId,
      sessionId: run.sessionId,
      title: typeof run.title === "string" ? run.title : "",
      startedAt: typeof run.startedAt === "string" ? run.startedAt : new Date().toISOString(),
      status: run.status === "running" || run.status === "failed" || run.status === "waiting_for_reconnect" || run.status === "archived"
        ? run.status
        : "completed",
      completedStudents: typeof run.completedStudents === "number" ? run.completedStudents : 0,
      totalStudents: typeof run.totalStudents === "number" ? run.totalStudents : 0,
      ...(typeof run.error === "string" ? { error: run.error } : {}),
      ...(typeof run.failedAt === "string" ? { failedAt: run.failedAt } : {}),
      ...(typeof run.hostPid === "number" ? { hostPid: run.hostPid } : {}),
    };
  }
  return { version: 1, runs };
}

export async function readGradingRuns(): Promise<GradingRunRecord[]> {
  try {
    const store = validateStore(JSON.parse(await readFile(STORE_PATH, "utf8")) as unknown);
    return Object.values(store.runs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function upsertGradingRun(run: GradingRunRecord): Promise<GradingRunRecord> {
  let resolveResult!: (value: GradingRunRecord) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<GradingRunRecord>((resolve, reject) => {
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
      store.runs[run.assignmentId] = { ...run, hostPid: run.hostPid ?? process.pid };
      await mkdir(dirname(STORE_PATH), { recursive: true });
      const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      await rename(temporaryPath, STORE_PATH);
      resolveResult(run);
    } catch (error) {
      rejectResult(error);
    }
  }, (error) => {
    rejectResult(error);
  });
  return result;
}
