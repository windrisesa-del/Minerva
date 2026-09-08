import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_PATH = process.env.MINERVA_WORKBENCH_STORE_PATH
  || join(homedir(), ".pi", "minerva", "assignment-workbenches.json");

export type WorkbenchRole = "adapter" | "marker" | "evaluator" | "summarizer";
export type WorkbenchSessionStatus = "running" | "completed" | "failed";

export interface WorkbenchSessionEntry {
  sessionId: string;
  role: WorkbenchRole;
  label: string;
  startedAt: string;
  status: WorkbenchSessionStatus;
  studentId?: string;
  submissionId?: string;
  error?: string;
}

export interface AssignmentWorkbenchRecord {
  assignmentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessions: WorkbenchSessionEntry[];
}

interface WorkbenchStore {
  version: 1;
  workbenches: Record<string, AssignmentWorkbenchRecord>;
}

const EMPTY_STORE: WorkbenchStore = { version: 1, workbenches: {} };
let mutationQueue: Promise<void> = Promise.resolve();

function validateStore(value: unknown): WorkbenchStore {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STORE);
  const candidate = value as Partial<WorkbenchStore>;
  if (candidate.version !== 1 || !candidate.workbenches || typeof candidate.workbenches !== "object") {
    return structuredClone(EMPTY_STORE);
  }
  const workbenches: Record<string, AssignmentWorkbenchRecord> = {};
  for (const [assignmentId, raw] of Object.entries(candidate.workbenches)) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) continue;
    const sessions = raw.sessions.filter((entry): entry is WorkbenchSessionEntry => (
      Boolean(entry)
      && typeof entry.sessionId === "string"
      && ["adapter", "marker", "evaluator", "summarizer"].includes(entry.role)
      && typeof entry.label === "string"
      && typeof entry.startedAt === "string"
      && ["running", "completed", "failed"].includes(entry.status)
    ));
    workbenches[assignmentId] = {
      assignmentId,
      title: typeof raw.title === "string" ? raw.title : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      sessions,
    };
  }
  return { version: 1, workbenches };
}

async function readStore(): Promise<WorkbenchStore> {
  try {
    return validateStore(JSON.parse(await readFile(STORE_PATH, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STORE);
    throw error;
  }
}

async function mutateStore<T>(mutation: (store: WorkbenchStore) => T): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      const store = await readStore();
      const value = mutation(store);
      await mkdir(dirname(STORE_PATH), { recursive: true });
      const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      await rename(temporaryPath, STORE_PATH);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  }, rejectResult);
  return result;
}

export async function readAssignmentWorkbench(assignmentId: string): Promise<AssignmentWorkbenchRecord | null> {
  return (await readStore()).workbenches[assignmentId] ?? null;
}

export async function readAssignmentWorkbenches(): Promise<AssignmentWorkbenchRecord[]> {
  return Object.values((await readStore()).workbenches);
}

export async function registerWorkbenchSession(options: {
  assignmentId: string;
  title: string;
  session: Omit<WorkbenchSessionEntry, "startedAt" | "status"> & Partial<Pick<WorkbenchSessionEntry, "startedAt" | "status">>;
}): Promise<AssignmentWorkbenchRecord> {
  return mutateStore((store) => {
    const now = new Date().toISOString();
    const current = store.workbenches[options.assignmentId] ?? {
      assignmentId: options.assignmentId,
      title: options.title,
      createdAt: now,
      updatedAt: now,
      sessions: [],
    };
    const entry: WorkbenchSessionEntry = {
      ...options.session,
      startedAt: options.session.startedAt || now,
      status: options.session.status || "running",
    };
    const index = current.sessions.findIndex((item) => item.sessionId === entry.sessionId);
    if (index >= 0) current.sessions[index] = { ...current.sessions[index], ...entry };
    else current.sessions.push(entry);
    current.title = options.title || current.title;
    current.updatedAt = now;
    store.workbenches[options.assignmentId] = current;
    return structuredClone(current);
  });
}

export async function updateWorkbenchSession(
  assignmentId: string,
  sessionId: string,
  patch: Pick<WorkbenchSessionEntry, "status"> & Partial<Pick<WorkbenchSessionEntry, "error">>,
): Promise<void> {
  await mutateStore((store) => {
    const workbench = store.workbenches[assignmentId];
    const session = workbench?.sessions.find((entry) => entry.sessionId === sessionId);
    if (!workbench || !session) return;
    Object.assign(session, patch);
    workbench.updatedAt = new Date().toISOString();
  });
}
