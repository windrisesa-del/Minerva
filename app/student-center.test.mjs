import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Student Center navigation and portrait card wall stay wired", async () => {
  const [shell, sidebar, center, graph, graphRoute, css] = await Promise.all([
    read("components/AppShell.tsx"),
    read("components/SessionSidebar.tsx"),
    read("components/StudentCenter.tsx"),
    read("components/StudentKnowledgeGraph.tsx"),
    read("app/api/wiki/knowledge-graph/route.ts"),
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
  assert.doesNotMatch(center, /LEARNING OBSERVATION/);
  assert.match(center, /\/api\/student-observations/);
  assert.doesNotMatch(center, /1\. Knowledge Profile · 知识掌握情况/);
  assert.match(center, /Problem-Solving & Learning Profile/);
  assert.match(center, /Learning Trajectory/);
  assert.match(center, /studentObservationMarkdown/);
  assert.match(center, /<MarkdownBody>/);
  assert.doesNotMatch(center, /保存观察|observationSaving|<textarea value=\{profileDraft/);
  assert.doesNotMatch(center, /className="student-knowledge/);
  assert.doesNotMatch(center, /Evidence Buffer|待验证判断|student-observation-buffer/);
  assert.match(center, /<StudentKnowledgeGraph studentId=\{selected\.id\}/);
  assert.ok(
    center.indexOf('aria-label="学习观察内容"') < center.indexOf("<StudentKnowledgeGraph studentId={selected.id}"),
    "学习观察应显示在知识掌握图谱之前",
  );
  assert.match(graph, /知识掌握图谱/);
  assert.doesNotMatch(graph, /KNOWLEDGE WIKI/);
  assert.match(graph, /import\("cytoscape"\)/);
  assert.match(graph, /mastery_level/);
  assert.match(graph, /node\.labels-hidden/);
  assert.match(graph, /core\.zoom\(\) < 0\.78/);
  assert.match(graph, /if \(core\.zoom\(\) > 1\.5\)/);
  assert.match(graph, /pixelRatio: Math\.max\(2, window\.devicePixelRatio\)/);
  assert.match(graph, /nodeRepulsion: \(\) => 80000/);
  assert.match(graph, /repelNodesAlongDrag/);
  assert.match(graph, /pullConnectedNodesAlongDrag/);
  assert.match(graph, /connectedEdges\(\)\.connectedNodes\(\)/);
  assert.match(graph, /const strength = 0\.36 \*\* depth/);
  assert.match(graph, /core\.on\("grab", "node"/);
  assert.match(graph, /core\.on\("drag", "node"/);
  assert.match(graph, /core\.on\("free", "node"/);
  assert.match(graph, /const startInertia/);
  assert.match(graph, /requestAnimationFrame\(step\)/);
  assert.match(graph, /const friction = 0\.9 \*\*/);
  assert.match(graph, /maximumSpeed = 1\.35/);
  assert.match(graph, /current\.depth >= 3/);
  assert.match(graph, /min-zoomed-font-size/);
  assert.match(graph, /node\.mastery-1[\s\S]*#c95f5f/);
  assert.match(graph, /node\.mastery-5[\s\S]*#5f9f72/);
  assert.match(graph, /尚未评估/);
  assert.match(graph, /打开 Wiki 知识页/);
  assert.match(graphRoute, /api\/wiki\/knowledge-graph/);
  assert.doesNotMatch(css, /\.student-knowledge-grid/);
  assert.match(css, /\.student-wiki-graph/);
  assert.match(css, /\.student-wiki-graph\s*\{[^}]*margin-top:\s*34px;[^}]*border-top:/);
  assert.match(css, /\.student-wiki-legend \.level-2/);
  assert.match(css, /\.student-wiki-legend \.level-4/);
  assert.match(css, /\.student-wiki-canvas:active\s*\{\s*cursor:\s*grabbing/);
  assert.match(css, /\.student-observation-markdown \.markdown-body/);
  assert.match(css, /\.student-center-title\s*\{[\s\S]*user-select:\s*none/);
  assert.match(css, /\.student-card-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*repeat\(4,/);
  assert.doesNotMatch(css, /@media \(max-width: 1320px\)/);
  assert.match(css, /\.student-portrait[\s\S]*aspect-ratio:\s*4 \/ 5/);
  assert.match(css, /\.student-profile\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none/);
  assert.match(css, /\.student-observation\s*\{[^}]*border:\s*0;/);
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
