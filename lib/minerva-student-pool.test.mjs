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
