import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Student Assignments is directly below Student Center and owns a URL view", async () => {
  const [shell, sidebar] = await Promise.all([
    read("components/AppShell.tsx"),
    read("components/SessionSidebar.tsx"),
  ]);

  assert.match(shell, /get\("view"\) === "assignments"/);
  assert.match(shell, /get\("view"\) !== "students"[\s\S]*get\("view"\) !== "assignments"/);
  assert.match(shell, /router\.replace\("\?view=assignments"/);
  assert.match(shell, /assignmentCenterOpen[\s\S]*<StudentAssignments[\s\S]*onInitialReady=/);
  assert.match(shell, /workspaceCwd=\{activeCwd\}/);
  assert.match(shell, /onOpenWorkbench=\{handleOpenAssignmentWorkbench\}/);
  assert.match(sidebar, /学生中心<\/span>[\s\S]*minerva-assignment-entry[\s\S]*学生作业<\/span>[\s\S]*批改工作台[\s\S]*\{\/\* Session list \*\//);
});

test("Assignment page reads the FastAPI proxy and preserves evidence boundaries", async () => {
  const [component, summary, route, css, adapterStart, adapterPipeline] = await Promise.all([
    read("components/StudentAssignments.tsx"),
    read("components/AssignmentSummary.tsx"),
    read("app/api/student-assignments/route.ts"),
    read("app/student-assignments.css"),
    read("app/api/adapter/start/route.ts"),
    read("lib/minerva-adapter-start.ts"),
  ]);

  assert.match(component, /fetch\("\/api\/student-assignments"/);
  assert.match(component, /导入作业/);
  assert.match(component, /未批改/);
  assert.match(component, /完成批改/);
  assert.match(component, /归档作业/);
  assert.match(component, /已归档/);
  assert.match(component, /批改工作台/);
  assert.match(component, /\/api\/evaluator\/runs/);
  assert.match(component, /\/api\/adapter\/start/);
  assert.match(component, /\/api\/grading\/runs/);
  assert.match(component, /自动处理失败/);
  assert.match(component, /visibleProcessingFailure\.error/);
  assert.match(component, /\.\.\.Object\.values\(evaluatorRuns\)/);
  assert.match(component, /minerva:shown-processing-failures:v1/);
  assert.match(component, /item\.status === "archived"/);
  assert.match(component, /关闭这条失败提醒/);
  assert.match(adapterPipeline, /本次导入数据已清理，请重新导入/);
  assert.match(adapterPipeline, /method: "DELETE"/);
  assert.match(component, /sources: body\.adapter_sources/);
  assert.doesNotMatch(component, /重新批改/);
  assert.doesNotMatch(component, />\s*开始观察\s*</);
  assert.doesNotMatch(component, /\/api\/evaluator\/start/);
  assert.doesNotMatch(component, /regrade/);
  assert.doesNotMatch(component, /\/api\/agent\/new/);
  await assert.rejects(
    access(new URL("./api/grading/start/route.ts", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
  assert.match(adapterStart, /\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/);
  assert.match(adapterStart, /after\(async \(\) =>/);
  assert.match(adapterStart, /maxDuration = 1800/);
  assert.match(adapterStart, /accepted: true/);
  assert.match(adapterStart, /status: 202/);
  assert.doesNotMatch(component, /assignment-metrics/);
  assert.match(component, /归档这份作业？/);
  assert.doesNotMatch(component, /window\.confirm/);
  assert.match(css, /\.assignment-confirm-dialog/);
  assert.match(css, /\.assignment-confirm-primary/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /method: "PATCH"/);
  assert.match(component, /页面显示数据库中的客观记录；教师结论与高风险操作仍需人工确认/);
  assert.match(component, /暂无作业数据/);
  assert.doesNotMatch(component, /assignment-student-table|SUBMISSION_LABELS/);
  assert.doesNotMatch(summary, /<details|borderRadius|background: "var\(--bg-panel\)"/);
  assert.match(summary, /<table className="assignment-report-table assignment-question-statistics">/);
  assert.match(summary, /<table className="assignment-report-table assignment-student-scores">/);
  assert.match(summary, /<MarkdownBody>\{markdown\}<\/MarkdownBody>/);
  assert.match(summary, /### 作业内容/);
  assert.match(summary, /### 整体完成情况/);
  assert.match(summary, /### 完成较好的题目/);
  assert.match(summary, /### 需要重点关注的题目/);
  assert.ok(summary.indexOf("assignment-question-statistics") < summary.indexOf("<MarkdownBody>"));
  assert.match(route, /MINERVA_DATA_API_URL/);
  assert.match(route, /\/api\/assignments\/import/);
  assert.match(route, /request\.arrayBuffer\(\)/);
  assert.match(route, /"Content-Type": contentType/);
  assert.doesNotMatch(route, /request\.formData\(\)/);
  assert.match(route, /method: "PATCH"/);
  assert.match(route, /cache: "no-store"/);
  assert.doesNotMatch(route, /DATABASE_URL/);
  assert.match(css, /\.assignment-workspace/);
  assert.match(css, /@media \(max-width: 720px\)/);
});
