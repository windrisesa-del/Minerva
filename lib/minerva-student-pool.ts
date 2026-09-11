export const STUDENT_WORKER_CONCURRENCY = 4;
export const STUDENT_WORKER_RETRIES = 5;
export const WORKER_IDLE_TIMEOUT_MS = 8 * 60 * 1000;
export const WORKER_HARD_TIMEOUT_MS = 25 * 60 * 1000;

export type StudentAgentWorker = {
  session: { isRunning(): boolean };
  readFailure(): string | null;
  lastActivity(): number;
  unsubscribe(): void;
};

export async function waitForStudentWorker(worker: StudentAgentWorker, label: string): Promise<void> {
  const hardDeadline = Date.now() + WORKER_HARD_TIMEOUT_MS;
  try {
    while (worker.session.isRunning()) {
      const now = Date.now();
      if (now - worker.lastActivity() >= WORKER_IDLE_TIMEOUT_MS) {
        throw new Error(`${label} 已连续 8 分钟没有新的模型或工具活动`);
      }
      if (now >= hardDeadline) {
        throw new Error(`${label} 超过 25 分钟仍未结束`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    const failure = worker.readFailure();
    if (failure) throw new Error(failure);
  } finally {
    worker.unsubscribe();
  }
}

export type StudentWaveSlot<T> = {
  item: T;
  groupId: string;
  agentIndex: number;
  attempt: number;
};

export type StudentWaveFailure<T> = {
  item: T;
  error: unknown;
};

export async function runStudentWaves<T>(options: {
  items: T[];
  groupPrefix: string;
  concurrency?: number;
  retries?: number;
  worker: (slot: StudentWaveSlot<T>) => Promise<void>;
  shouldRetry?: (error: unknown, slot: StudentWaveSlot<T>) => boolean;
  retryDelayMs?: (error: unknown, slot: StudentWaveSlot<T>) => number;
}): Promise<{ failed: T[]; failures: StudentWaveFailure<T>[] }> {
  const concurrency = Math.max(1, options.concurrency ?? STUDENT_WORKER_CONCURRENCY);
  const retries = Math.max(1, options.retries ?? STUDENT_WORKER_RETRIES);
  const failed: T[] = [];
  const failures: StudentWaveFailure<T>[] = [];
  for (let offset = 0; offset < options.items.length; offset += concurrency) {
    const wave = options.items.slice(offset, offset + concurrency);
    const groupId = `${options.groupPrefix}:${offset}`;
    await Promise.all(wave.map(async (item, index) => {
      const agentIndex = index + 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          await options.worker({ item, groupId, agentIndex, attempt });
          return;
        } catch (error) {
          lastError = error;
          const slot = { item, groupId, agentIndex, attempt };
          if (attempt >= retries || options.shouldRetry?.(error, slot) === false) break;
          const retryDelayMs = Math.max(0, options.retryDelayMs?.(error, slot) ?? Math.min(10_000, 1_000 * (2 ** (attempt - 1))));
          if (retryDelayMs > 0) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
          }
        }
      }
      failed.push(item);
      failures.push({ item, error: lastError });
      if (lastError) {
        console.error(
          `[minerva] student worker failed:`,
          lastError instanceof Error ? lastError.message : lastError,
        );
      }
    }));
  }
  return { failed, failures };
}
