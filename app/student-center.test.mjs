import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Student Center navigation and portrait card wall stay wired", async () => {
  const [shell, sidebar, center, css] = await Promise.all([
    read("components/AppShell.tsx"),
    read("components/SessionSidebar.tsx"),
    read("components/StudentCenter.tsx"),
    read("app/student-center.css"),
  ]);

  assert.match(shell, /studentCenterOpen[\s\S]*<StudentCenter onInitialReady=/);
  assert.match(shell, /currentView !== "students" && currentView !== "assignments"/);
  assert.match(shell, /!showDataCenter && renderMainFileToggle\(true\)/);
  assert.match(shell, /!isMobile && !showDataCenter && renderMainFileToggle\(false\)/);
  assert.match(sidebar, /className="minerva-student-entry"[\s\S]*学生中心/);
  assert.match(center, /更改记录/);
  assert.match(center, /添加学生/);
  assert.match(center, /CSV 批量导入/);
  assert.match(center, /className="student-card-grid"/);
  assert.match(center, /className="student-center-title"/);
  assert.match(center, /学习观察/);
  assert.match(center, /\/api\/student-observations/);
  assert.match(center, /Knowledge Profile/);
  assert.match(center, /Problem-Solving &amp; Learning Profile/);
  assert.match(center, /Learning Trajectory/);
  assert.match(center, /mastery_level/);
  assert.match(center, /未评估/);
  assert.match(center, /Evidence Buffer/);
  assert.match(css, /\.student-knowledge-grid/);
  assert.match(css, /\.student-center-title\s*\{[\s\S]*user-select:\s*none/);
  assert.match(css, /\.student-card-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*repeat\(4,/);
  assert.doesNotMatch(css, /@media \(max-width: 1320px\)/);
  assert.match(css, /\.student-portrait[\s\S]*aspect-ratio:\s*4 \/ 5/);
});

test("Student records are local, audited, and do not expose a delete route", async () => {
  const [store, route, detailRoute] = await Promise.all([
    read("lib/student-store.ts"),
    read("app/api/students/route.ts"),
    read("app/api/students/[id]/route.ts"),
  ]);

  assert.match(store, /\.pi", "minerva", "students\.json"/);
  assert.match(store, /store\.changes\.unshift/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /syncStudentsToDatabase/);
  assert.doesNotMatch(route, /export async function DELETE/);
  assert.match(detailRoute, /export async function PATCH/);
  assert.match(detailRoute, /syncStudentsToDatabase/);
  assert.doesNotMatch(detailRoute, /export async function DELETE/);
});
