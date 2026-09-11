import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("one assignment is presented as one dated merged processing session", async () => {
  const [component, chatWindow, assignmentPage, route, sessionsRoute, sidebar, shell, adapter, marker, evaluator, summarizer, finalizer] = await Promise.all([
    read("components/AssignmentWorkbench.tsx"),
    read("components/ChatWindow.tsx"),
    read("components/StudentAssignments.tsx"),
    read("app/api/assignment-workbench/route.ts"),
    read("app/api/sessions/route.ts"),
    read("components/SessionSidebar.tsx"),
    read("components/AppShell.tsx"),
    read("lib/minerva-adapter-start.ts"),
    read("lib/minerva-grading-start.ts"),
    read("lib/minerva-evaluator-start.ts"),
    read("lib/minerva-summarizer-start.ts"),
    read("lib/assignment-session-finalizer.ts"),
  ]);
  assert.match(component, /Promise\.all\(targets\.slice/);
  assert.match(component, /\/api\/sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}/);
  assert.match(component, /调用 \$\{count\} 个并行执行的/);
  assert.match(component, /Agent \$\{number\}/);
  assert.match(component, /assignment-workbench-parallel-summary/);
  assert.match(component, /<MessageView/);
  assert.match(component, /<ChatWindow/);
  assert.match(component, /session=\{currentSessionInfo\}/);
  assert.match(component, /newSessionCwd=\{null\}/);
  assert.match(component, /newSessionDraftKey=\{null\}/);
  assert.match(component, /hideHistoryThroughAssistantText=\{ASSIGNMENT_SESSION_HISTORY_BOUNDARY\}/);
  assert.match(component, /normalizeToolCalls/);
  assert.match(component, /minerva-chat/);
  assert.match(component, /assignment-workbench-scroll/);
  assert.match(component, /currentSession/);
  assert.doesNotMatch(component, /assignment-workbench-process-toggle/);
  assert.match(component, /legacySessionRequested/);
  assert.doesNotMatch(component, /scrollbar-width:none/);
  assert.doesNotMatch(component, /PROCESS ARCHIVE/);
  assert.doesNotMatch(component, /ASSIGNMENT SESSION/);
  assert.doesNotMatch(component, /返回学生作业/);
  assert.doesNotMatch(component, /assignment-workbench-message/);
  assert.doesNotMatch(component, /selectedSessionId/);
  assert.doesNotMatch(component, /打开完整会话/);
  assert.doesNotMatch(assignmentPage, /<AssignmentWorkbench/);
  assert.match(assignmentPage, /<AssignmentSummary/);
  assert.match(route, /readAssignmentWorkbenches/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /export async function POST/);
  assert.match(route, /compact: false/);
  assert.match(route, /archivedWorkbenches/);
  assert.match(route, /displayTitle/);
  assert.match(route, /workbenchProcessingFailed/);
  assert.match(route, /session\.role === "summarizer" && session\.status === "completed"/);
  assert.match(route, /running: running\.has\(workbench\.currentSession\.sessionId\)/);
  assert.match(route, /year: "numeric", month: "2-digit", day: "2-digit"/);
  assert.match(sessionsRoute, /minervaInternal: true/);
  assert.match(sessionsRoute, /workbench\.currentSession\.sessionId/);
  assert.match(sidebar, /!session\.minervaInternal/);
  assert.match(sidebar, /批改工作台/);
  assert.match(sidebar, /\/api\/assignment-workbench/);
  assert.match(sidebar, /workbench\.displayTitle/);
  assert.match(sidebar, /AssignmentWorkbenchItem/);
  assert.match(sidebar, /重命名批改工作台/);
  assert.doesNotMatch(sidebar, /archivedAssignmentWorkbenches|workbenchArchiveOpen/);
  assert.match(sidebar, /body: JSON\.stringify\(body\)/);
  assert.doesNotMatch(sidebar, /workbench\.running \? "处理中" : workbench\.failed \? "已中断"/);
  assert.match(shell, /view=assignments&workbench=/);
  assert.match(shell, /onOpenAssignmentWorkbench=\{handleOpenAssignmentWorkbench\}/);
  assert.match(shell, /workbenchAssignmentId \? \([\s\S]*<AssignmentWorkbench/);
  assert.match(shell, /onOpenWorkbench=\{handleOpenAssignmentWorkbench\}/);
  assert.match(shell, /\(showChat \|\| Boolean\(workbenchAssignmentId\)\) && <ShortcutOrb/);
  assert.match(shell, /showSessionActions=\{showChat\}/);
  assert.match(shell, /workbench\.viewRawProcess/);
  assert.match(shell, /workbench\.returnCurrent/);
  for (const source of [adapter, marker, evaluator, summarizer]) {
    assert.match(source, /registerWorkbenchSession/);
    assert.match(source, /updateWorkbenchSession/);
  }
  assert.match(summarizer, /finalizeAssignmentSession\(options\)/);
  assert.match(finalizer, /SessionManager\.open\(path\)\.getBranch\(\)/);
  assert.match(finalizer, /resolveSessionPath\(workbench\.currentSession\.sessionId\)/);
  assert.match(finalizer, /existingPath && existsSync\(existingPath\)/);
  assert.match(finalizer, /currentModel\?\.provider === "minerva-local"/);
  assert.match(finalizer, /existingManager\.appendModelChange\(preferredModel\.provider, preferredModel\.modelId\)/);
  assert.match(finalizer, /invalidateSessionPathCache\(workbench\.currentSession\.sessionId\)/);
  assert.match(finalizer, /cacheSessionPath\(realSessionId, sessionFile\)/);
  assert.match(finalizer, /合并后的当前会话未能写入磁盘/);
  assert.match(finalizer, /provider: "minerva-local"/);
  assert.match(finalizer, /manager\.appendModelChange\(activeModel\.provider, activeModel\.id\)/);
  assert.match(finalizer, /ASSIGNMENT_SESSION_HISTORY_BOUNDARY/);
  assert.match(finalizer, /type: "compact"/);
  assert.match(finalizer, /COMPACTION_INSTRUCTIONS/);
  assert.match(chatWindow, /const renderMessages = useMemo\(\(\) => messages\.slice\(hiddenHistoryEnd\)/);
  assert.match(chatWindow, /const renderEntryIds = useMemo\(\(\) => entryIds\.slice\(hiddenHistoryEnd\)/);
  assert.match(chatWindow, /messages=\{renderMessages\}/);
});
