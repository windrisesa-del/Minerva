// Read-only comparison: no model requests, no POSTs, no stored data changes.
// node scripts/replay-grading-context.mjs <assignment-id>
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const assignmentId = process.argv[2];
if (!/^[a-f0-9-]{36}$/i.test(assignmentId ?? "")) throw new Error("Provide an assignment UUID");
const web = "http://127.0.0.1:30141";
const data = (process.env.MINERVA_DATA_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if ((init?.method || "GET") !== "GET" || ![web, data].includes(url.origin)) throw new Error("Replay only allows local GET requests");
  return originalFetch(input, init);
};
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET failed: ${response.status}`);
  return response.json();
}
async function messages(id) {
  const info = await get(`${web}/api/sessions/${id}?tail=1000&deferThinking=1&deferMedia=1`);
  return (await readFile(info.filePath, "utf8")).trim().split("\n").map(JSON.parse).filter(e => e.type === "message").map(e => e.message);
}
const jiti = createJiti(import.meta.url);
const { createMinervaDataExtension } = await jiti.import("../lib/minerva-data-extension.ts");
const { compactEvidenceContext, compactReportContext } = await jiti.import("../lib/minerva-model-context.ts");
const { workbench } = await get(`${web}/api/assignment-workbench?assignment_id=${assignmentId}`);
const before = await get(`${data}/api/assignments/${assignmentId}/processing`);
const reportBefore = await get(`${data}/api/assignments/${assignmentId}/summary`);
const marker = workbench.sessions.find(s => s.role === "marker");
if (!marker) throw new Error("No recorded Marker session");
const tools = new Map();
await createMinervaDataExtension({ graderAssignmentId: assignmentId, graderStudentId: marker.studentId, graderSubmissionId: marker.submissionId })
  .factory({ registerTool(t) { tools.set(t.name, t); }, on() {}, setActiveTools() {} });
const oldMessages = await messages(marker.sessionId);
const results = [];
for (const resource of ["questions", "assignment_items"]) {
  const old = oldMessages.filter(m => m.role === "toolResult" && m.toolName === "read_minerva")
    .flatMap(m => m.content).filter(c => c.type === "text").find(c => { try { return JSON.parse(c.text).resource === resource; } catch { return false; } });
  const output = await tools.get("read_minerva").execute("replay", { resource });
  const text = output.content[0].text;
  assert.ok(!text.includes('"student_submissions"'));
  results.push({ phase: "Marker", resource, beforeChars: old?.text.length, afterChars: text.length });
}
for (const session of workbench.sessions.filter(s => s.role === "evaluator")) {
  const text = (await messages(session.sessionId)).find(m => m.role === "user").content.find(c => c.type === "text").text;
  const context = JSON.parse(text.split("evaluator_context:\n")[1].split("\n")[0]);
  results.push({ phase: "Evaluator", sessionId: session.sessionId, beforeChars: JSON.stringify(context).length, afterChars: JSON.stringify(compactEvidenceContext(context)).length });
}
const summary = workbench.sessions.find(s => s.role === "summarizer" && s.status === "completed");
if (summary) {
  const text = (await messages(summary.sessionId)).find(m => m.role === "user").content.find(c => c.type === "text").text;
  const context = JSON.parse(text.split("<report_context>")[1].split("</report_context>")[0]);
  results.push({ phase: "Summarizer", beforeChars: JSON.stringify(context).length, afterChars: JSON.stringify(compactReportContext(context)).length });
}
assert.deepEqual(await get(`${data}/api/assignments/${assignmentId}/processing`), before);
assert.deepEqual(await get(`${data}/api/assignments/${assignmentId}/summary`), reportBefore);
console.log(JSON.stringify({ assignmentId, noModelCalls: true, results: results.map(r => ({ ...r, reductionPercent: r.beforeChars ? Number((100 * (1 - r.afterChars / r.beforeChars)).toFixed(2)) : null })), persistedResultsUnchanged: true }, null, 2));
