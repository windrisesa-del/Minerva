import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const systemSource = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps System and Tools as adjacent settings sections", async () => {
  const settingsPanelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settingsPanelSource, /id: "system"[\s\S]*?id: "tools"/);
  assert.match(settingsPanelSource, /<SystemPromptPanel /);
  assert.match(settingsPanelSource, /<ToolDefinitionsPanel /);
  assert.doesNotMatch(appShellSource, /handleSystemInfoToggle/);
  assert.doesNotMatch(appShellSource, /<SystemPromptPanel/);
  assert.doesNotMatch(appShellSource, /<ToolDefinitionsPanel/);
  assert.doesNotMatch(systemSource, /ToolEntry|tools/);
  assert.doesNotMatch(systemSource, /system-prompt-heading/);
  assert.doesNotMatch(panelSource, /tool-definitions-heading/);
});

test("renders active tool definitions in a selectable master-detail layout", () => {
  assert.match(panelSource, /tools\?\.filter\(\(tool\) => tool\.active\)/);
  assert.match(panelSource, /setSelectedToolName\(tool\.name\)/);
  assert.match(panelSource, /activeTools\?\.some\(\(tool\) => tool\.name === current\)/);
  assert.match(panelSource, /className="tool-definitions-sidebar"/);
  assert.match(panelSource, /className="tool-definition-detail"/);
  assert.match(panelSource, /grid-template-columns: clamp\(112px, 26%, 220px\) minmax\(0, 1fr\)/);
});

test("shows schema fields and metadata in the detail form", () => {
  assert.match(panelSource, /parameters\.properties/);
  assert.match(panelSource, /parameters\.required/);
  assert.match(panelSource, /field\.allowedValues/);
  assert.match(panelSource, /field\.defaultValue/);
  assert.match(panelSource, /selectedTool\.promptGuidelines/);
});

test("preserves the two-column layout on narrow screens", () => {
  assert.match(
    panelSource,
    /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?grid-template-columns: 112px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(panelSource, /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?display: block/);
});

test("keeps the selected tool state isolated from remaining topbar controls", () => {
  assert.match(panelSource, /height: 100%/);
  assert.match(panelSource, /\.tool-definitions-item\.selected \{[\s\S]*?background: var\(--bg-selected\)[\s\S]*?inset 2px 0 0 var\(--accent\)/);
  assert.match(appShellSource, /className="minerva-chat-toolbar-actions"/);
  assert.match(appShellSource, /className="minerva-topbar-panel"/);
  assert.match(globalCss, /\.minerva-topbar \{[\s\S]*?position: relative;[\s\S]*?z-index: 230;[\s\S]*?backdrop-filter: none;/);
  assert.match(appShellSource, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(appShellSource, /event\.composedPath\(\)\.includes\(topBar\)/);
  assert.match(appShellSource, /event\.key !== "Escape"[\s\S]*?setActiveTopPanel\(null\)/);
});
