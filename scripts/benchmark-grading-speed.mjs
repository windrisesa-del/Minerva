// No model calls or student writes. Compare identical controlled workloads.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runStudentWaves } = await jiti.import("../lib/minerva-student-pool.ts");
const { createMinervaDataExtension } = await jiti.import("../lib/minerva-data-extension.ts");

async function legacyWaves({ items, concurrency, worker }) {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    await Promise.all(items.slice(offset, offset + concurrency).map((item) => worker({ item })));
  }
}

async function measure(task) {
  const start = performance.now();
  await task();
  return Math.round(performance.now() - start);
}

function comparison(name, baselineMs, optimizedMs, extra = {}) {
  return { name, baselineMs, optimizedMs, reductionPercent: +(100 * (1 - optimizedMs / baselineMs)).toFixed(1), ...extra };
}

async function poolComparison(name, durations, concurrency, scale = 1) {
  const options = { items: durations, concurrency, groupPrefix: "benchmark", worker: async ({ item }) => delay(item * scale) };
  const baselineMs = await measure(() => legacyWaves(options));
  const optimizedMs = await measure(() => runStudentWaves(options));
  return comparison(name, baselineMs, optimizedMs, { concurrency, durationsMs: durations, timerScale: scale });
}

const results = [];
// Anonymized transcript spans from 2026-09-21. This is a timing replay,
// not a repeat grading run or a claim of end-to-end inference speedup.
results.push(await poolComparison("historical-evaluator-timing-replay", [148404, 363251, 346159], 2, 0.01));
results.push(await poolComparison("uneven-eight-student-synthetic", [240, 40, 40, 40, 240, 40, 40, 40], 4));
results.push(await poolComparison("equal-duration-control", [80, 80, 80, 80, 80, 80, 80, 80], 4));

const tools = new Map();
await createMinervaDataExtension({ graderAssignmentId: "benchmark" }).factory({
  registerTool(tool) { tools.set(tool.name, tool); }, on() {}, setActiveTools() {},
});
const originalFetch = globalThis.fetch;
const attachments = Array.from({ length: 4 }, (_, i) => ({
  storage_key: `/uploads/assignments/benchmark/student/${i}.png`, mime_type: "image/png",
}));
try {
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/minerva/read?")) return Response.json({ records: [{ attachments }] });
    await delay(40);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const baselineMs = await measure(async () => {
    for (const attachment of attachments) await (await fetch(attachment.storage_key)).arrayBuffer();
  });
  const optimizedMs = await measure(async () => {
    const result = await tools.get("read_minerva").execute("benchmark", { resource: "answer_attempts", question_id: "q" });
    assert.equal(result.content.filter((item) => item.type === "image").length, 4);
    assert.equal(result.isError, undefined);
  });
  results.push(comparison("four-images-synthetic-40ms-per-request", baselineMs, optimizedMs));
} finally {
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ kind: "controlled-benchmark-not-live-model-evaluation", results }, null, 2));
