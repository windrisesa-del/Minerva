import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionInfo } from "./types";

export type SessionArchiveIndex = {
  version: 1;
  sessions: Record<string, { archivedAt: string }>;
};

const EMPTY_INDEX: SessionArchiveIndex = { version: 1, sessions: {} };
let mutationQueue = Promise.resolve();

export function sessionArchivePath(): string {
  return join(homedir(), ".pi", "agent", "session-archive.json");
}

export async function readSessionArchiveIndex(filePath = sessionArchivePath()): Promise<SessionArchiveIndex> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionArchiveIndex>;
    if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") return { ...EMPTY_INDEX, sessions: {} };
    return { version: 1, sessions: parsed.sessions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_INDEX, sessions: {} };
    throw error;
  }
}

async function writeSessionArchiveIndex(index: SessionArchiveIndex, filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function setSessionsArchived(
  sessionIds: string[],
  archived: boolean,
  filePath = sessionArchivePath(),
): Promise<SessionArchiveIndex> {
  let result: SessionArchiveIndex = { ...EMPTY_INDEX, sessions: {} };
  mutationQueue = mutationQueue.then(async () => {
    const current = await readSessionArchiveIndex(filePath);
    const sessions = { ...current.sessions };
    const archivedAt = new Date().toISOString();
    for (const sessionId of sessionIds) {
      if (archived) sessions[sessionId] = { archivedAt };
      else delete sessions[sessionId];
    }
    result = { version: 1, sessions };
    await writeSessionArchiveIndex(result, filePath);
  });
  await mutationQueue;
  return result;
}

export function collectSessionFamilyIds(sessions: SessionInfo[], rootSessionId: string): string[] {
  const family = new Set([rootSessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (
        session.relation?.kind === "subagent"
        && family.has(session.relation.parentSessionId)
        && !family.has(session.id)
      ) {
        family.add(session.id);
        changed = true;
      }
    }
  }
  return [...family];
}
