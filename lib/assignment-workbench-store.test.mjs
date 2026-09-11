import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const directory = await mkdtemp(join(tmpdir(), "minerva-workbench-"));
process.env.MINERVA_WORKBENCH_STORE_PATH = join(directory, "workbenches.json");
const { readAssignmentWorkbench, readAssignmentWorkbenches, registerWorkbenchSession, setWorkbenchCurrentSession, updateAssignmentWorkbench, updateWorkbenchSession } = await createJiti(import.meta.url)
  .import("./assignment-workbench-store.ts");

test.after(async () => {
  delete process.env.MINERVA_WORKBENCH_STORE_PATH;
  await rm(directory, { recursive: true, force: true });
});

test("one assignment workbench keeps every role session in order", async () => {
  await registerWorkbenchSession({
    assignmentId: "assignment-1",
    title: "函数训练",
    session: { sessionId: "adapter-1", role: "adapter", label: "结构化" },
  });
  await registerWorkbenchSession({
    assignmentId: "assignment-1",
    title: "函数训练",
    session: { sessionId: "marker-1", role: "marker", label: "批改 · 学生甲", studentId: "student-1" },
  });
  await updateWorkbenchSession("assignment-1", "adapter-1", { status: "completed" });

  const workbench = await readAssignmentWorkbench("assignment-1");
  assert.equal(workbench?.title, "函数训练");
  assert.deepEqual(workbench?.sessions.map((entry) => [entry.role, entry.sessionId, entry.status]), [
    ["adapter", "adapter-1", "completed"],
    ["marker", "marker-1", "running"],
  ]);
  assert.equal(JSON.parse(await readFile(process.env.MINERVA_WORKBENCH_STORE_PATH, "utf8")).version, 1);
});

test("another assignment receives an independent workbench", async () => {
  await registerWorkbenchSession({
    assignmentId: "assignment-2",
    title: "几何训练",
    session: { sessionId: "summary-2", role: "summarizer", label: "生成报告" },
  });
  assert.deepEqual((await readAssignmentWorkbench("assignment-2"))?.sessions.map((entry) => entry.sessionId), ["summary-2"]);
  assert.equal((await readAssignmentWorkbench("assignment-1"))?.sessions.length, 2);
});

test("a workbench can be renamed, archived, and restored without losing its sessions", async () => {
  await updateAssignmentWorkbench("assignment-1", { title: "函数训练（订正）", archived: true });
  let workbench = await readAssignmentWorkbench("assignment-1");
  assert.equal(workbench?.title, "函数训练（订正）");
  assert.equal(workbench?.customTitle, true);
  assert.ok(workbench?.archivedAt);
  assert.deepEqual(workbench?.sessions.map((entry) => entry.sessionId), ["adapter-1", "marker-1"]);

  await updateAssignmentWorkbench("assignment-1", { archived: false });
  workbench = await readAssignmentWorkbench("assignment-1");
  assert.equal(workbench?.archivedAt, undefined);
  assert.equal((await readAssignmentWorkbenches()).length, 2);
});

test("a custom title survives later pipeline sessions and new work resumes an archive", async () => {
  await updateAssignmentWorkbench("assignment-2", { title: "几何专项", archived: true });
  await registerWorkbenchSession({
    assignmentId: "assignment-2",
    title: "几何训练",
    session: { sessionId: "marker-2", role: "marker", label: "批改" },
  });
  const workbench = await readAssignmentWorkbench("assignment-2");
  assert.equal(workbench?.title, "几何专项");
  assert.equal(workbench?.archivedAt, undefined);
});

test("a workbench stores its compacted current Pi session separately from source sessions", async () => {
  await setWorkbenchCurrentSession("assignment-1", {
    sessionId: "current-1",
    status: "ready",
    compacted: true,
    createdAt: "2026-09-08T08:00:00.000Z",
  });
  const workbench = await readAssignmentWorkbench("assignment-1");
  assert.deepEqual(workbench?.currentSession, {
    sessionId: "current-1",
    status: "ready",
    compacted: true,
    createdAt: "2026-09-08T08:00:00.000Z",
    error: undefined,
  });
  assert.deepEqual(workbench?.sessions.map((entry) => entry.sessionId), ["adapter-1", "marker-1"]);
});
