import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("one assignment is presented as one dated merged processing session", async () => {
  const [component, assignmentPage, route, sessionsRoute, sidebar, shell, adapter, marker, evaluator, summarizer] = await Promise.all([
    read("components/AssignmentWorkbench.tsx"),
    read("components/StudentAssignments.tsx"),
    read("app/api/assignment-workbench/route.ts"),
    read("app/api/sessions/route.ts"),
    read("components/SessionSidebar.tsx"),
    read("components/AppShell.tsx"),
    read("lib/minerva-adapter-start.ts"),
    read("lib/minerva-grading-start.ts"),
    read("lib/minerva-evaluator-start.ts"),
    read("lib/minerva-summarizer-start.ts"),
  ]);
  assert.match(component, /Adapter[\s\S]*Marker[\s\S]*Evaluator[\s\S]*Summarizer/);
  assert.match(component, /Promise\.all\(targets\.slice/);
  assert.match(component, /\/api\/sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}/);
  assert.match(component, /ASSIGNMENT SESSION/);
  assert.doesNotMatch(component, /selectedSessionId/);
  assert.doesNotMatch(component, /打开完整会话/);
  assert.doesNotMatch(assignmentPage, /<AssignmentWorkbench/);
  assert.match(assignmentPage, /<AssignmentSummary/);
  assert.match(route, /readAssignmentWorkbenches/);
  assert.match(route, /displayTitle/);
  assert.match(route, /year: "numeric", month: "2-digit", day: "2-digit"/);
  assert.match(sessionsRoute, /minervaInternal: true/);
  assert.match(sidebar, /!session\.minervaInternal/);
  assert.match(sidebar, /批改工作台/);
  assert.match(sidebar, /\/api\/assignment-workbench/);
  assert.match(sidebar, /workbench\.displayTitle/);
  assert.match(shell, /view=assignments&workbench=/);
  assert.match(shell, /onOpenAssignmentWorkbench=\{handleOpenAssignmentWorkbench\}/);
  assert.match(shell, /workbenchAssignmentId \? \([\s\S]*<AssignmentWorkbench/);
  assert.match(shell, /onOpenWorkbench=\{handleOpenAssignmentWorkbench\}/);
  for (const source of [adapter, marker, evaluator, summarizer]) {
    assert.match(source, /registerWorkbenchSession/);
    assert.match(source, /updateWorkbenchSession/);
  }
});
