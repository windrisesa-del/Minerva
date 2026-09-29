import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  runStudentWaves,
  STUDENT_WORKER_CONCURRENCY,
  STUDENT_WORKER_RETRIES,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_HARD_TIMEOUT_MS,
} = await createJiti(import.meta.url).import("./minerva-student-pool.ts");

test("student waves keep a bounded parallel group and retry the failed slot", async () => {
  assert.equal(STUDENT_WORKER_CONCURRENCY, 4);
  assert.equal(STUDENT_WORKER_RETRIES, 5);
  assert.equal(WORKER_IDLE_TIMEOUT_MS, 8 * 60 * 1000);
  assert.equal(WORKER_HARD_TIMEOUT_MS, 25 * 60 * 1000);
  const attempts = [];
  const { failed } = await runStudentWaves({
    items: ["a", "b", "c", "d", "e"],
    groupPrefix: "marker",
    retries: 2,
    retryDelayMs: () => 0,
    worker: async ({ item, groupId, agentIndex, attempt }) => {
      attempts.push({ item, groupId, agentIndex, attempt });
      if (item === "b" && attempt === 1) throw new Error("model dropped");
      if (item === "e") throw new Error("still failing");
    },
  });
  assert.deepEqual(failed, ["e"]);
  assert.equal(attempts.filter((item) => item.item === "b").length, 2);
  assert.equal(attempts.filter((item) => item.groupId === "marker:0").length, 5);
  assert.equal(attempts.filter((item) => item.groupId === "marker:4").length, 2);
});

test("student waves stop immediately when a deterministic error is not retryable", async () => {
  let attempts = 0;
  const { failed, failures } = await runStudentWaves({
    items: ["student-1"],
    groupPrefix: "evaluator",
    retries: 5,
    shouldRetry: () => false,
    retryDelayMs: () => 0,
    worker: async () => {
      attempts += 1;
      throw new Error("invalid operation path");
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(failed, ["student-1"]);
  assert.equal(failures[0].error.message, "invalid operation path");
});

test("a freed slot starts the next student while a slow student is still running", async () => {
  const slow = Promise.withResolvers();
  const started = [];
  let active = 0;
  let peak = 0;
  const run = runStudentWaves({
    items: ["slow", "fast", "next", "last"],
    groupPrefix: "marker",
    concurrency: 2,
    worker: async ({ item }) => {
      started.push(item);
      peak = Math.max(peak, ++active);
      if (item === "slow") await slow.promise;
      active--;
    },
  });
  // One event-loop turn is enough: fast/next have no timers or external IO.
  await new Promise((resolve) => setImmediate(resolve));
  const refilled = started.includes("next");
  slow.resolve();
  const result = await run;
  assert.equal(refilled, true, "an idle slot must not wait for the slow student's wave");
  assert.deepEqual(result.failed, []);
  assert.equal(peak, 2);
  assert.equal(new Set(started).size, 4);
});

test("a retry keeps its identity while other slots continue processing", async () => {
  const retryGate = Promise.withResolvers();
  const seen = [];
  const run = runStudentWaves({
    items: ["retry", "fast", "next"],
    groupPrefix: "evaluator",
    concurrency: 2,
    retries: 2,
    retryDelayMs: () => 0,
    worker: async (slot) => {
      seen.push(slot);
      if (slot.item === "retry" && slot.attempt === 1) throw new Error("temporary");
      if (slot.item === "retry") await retryGate.promise;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const refilled = seen.some(({ item }) => item === "next");
  retryGate.resolve();
  await run;
  assert.equal(refilled, true);
  assert.deepEqual(seen.filter(({ item }) => item === "retry"), [
    { item: "retry", groupId: "evaluator:0", agentIndex: 1, attempt: 1 },
    { item: "retry", groupId: "evaluator:0", agentIndex: 1, attempt: 2 },
  ]);
});

test("an empty queue starts no workers and invalid limits fail instead of dropping work", async () => {
  let calls = 0;
  const options = { items: [], groupPrefix: "test", worker: async () => { calls++; } };
  assert.deepEqual(await runStudentWaves(options), { failed: [], failures: [] });
  assert.equal(calls, 0);
  await assert.rejects(runStudentWaves({ ...options, items: [1], concurrency: NaN }), /finite/);
  await assert.rejects(runStudentWaves({ ...options, items: [1], retries: Infinity }), /finite/);
});
