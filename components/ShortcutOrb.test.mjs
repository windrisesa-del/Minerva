import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const orbSource = await readFile(new URL("./ShortcutOrb.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("shortcut orb stacks appearance, language, title, and history from top to bottom", () => {
  const themeIndex = orbSource.indexOf("themeLabel");
  const languageIndex = orbSource.indexOf("languageLabel");
  const titleIndex = orbSource.indexOf("titleLabel");
  const historyIndex = orbSource.indexOf("historyLabel");
  assert.ok(themeIndex > 0 && languageIndex > themeIndex && titleIndex > languageIndex && historyIndex > titleIndex);
  assert.match(shellSource, /<ShortcutOrb/);
  assert.match(shellSource, /translate\("shortcut.theme"\)/);
  assert.match(shellSource, /translate\("shortcut.language"\)/);
  assert.match(shellSource, /onSetTheme=\{setThemePreference\}/);
  assert.match(shellSource, /onGenerateTitle=\{\(\) => \{ void handleAutoName\(\); \}\}/);
  assert.match(shellSource, /onViewHistory=\{handleViewFullHistory\}/);
  assert.doesNotMatch(shellSource, /renderThemeButton|renderLanguageButton/);
  assert.doesNotMatch(shellSource, /data-mobile-toolbar-action=\{mobile \? "theme"/);
  assert.doesNotMatch(shellSource, /data-mobile-toolbar-action=\{mobile \? "history"/);
});

test("shortcut orb expands a vertical menu from a floating control", () => {
  assert.match(orbSource, /className="minerva-shortcut-orb"/);
  assert.match(orbSource, /className="minerva-shortcut-menu"/);
  assert.match(orbSource, /role="menu"/);
  assert.match(cssSource, /\.minerva-shortcut \{[\s\S]*?position: absolute/);
  assert.match(cssSource, /\.minerva-shortcut-orb \{[\s\S]*?border-radius: 50%/);
  assert.match(cssSource, /@keyframes minerva-shortcut-open/);
});

test("shortcut orb is draggable and keeps theme and language as vertical option lists", () => {
  assert.match(orbSource, /onPointerDown=\{handleOrbPointerDown\}/);
  assert.match(orbSource, /window\.addEventListener\("pointermove", handleMove\)/);
  assert.match(orbSource, /window\.addEventListener\("mouseup", handleUp\)/);
  assert.match(orbSource, /const orbEl = event\.currentTarget/);
  assert.match(orbSource, /DRAG_THRESHOLD/);
  assert.match(orbSource, /writeStoredPosition/);
  assert.match(cssSource, /touch-action: none/);
  assert.match(orbSource, /toggleSubmenu\("theme"\)/);
  assert.match(orbSource, /toggleSubmenu\("language"\)/);
  assert.match(orbSource, /className="minerva-shortcut-options minerva-shortcut-flyout"/);
  assert.match(orbSource, /minerva-shortcut-panels/);
  assert.match(orbSource, /function shouldOpenEnd\(/);
  assert.match(orbSource, /spaceLeft >= need/);
  assert.match(orbSource, /spaceRight >= need/);
  assert.match(cssSource, /\.minerva-shortcut-flyout \{[\s\S]*?right: calc\(100% \+ 8px\)/);
  assert.match(cssSource, /\.minerva-shortcut-panels\.is-end \{[\s\S]*?left: 0/);
  assert.match(cssSource, /\.minerva-shortcut-panels\.is-end \.minerva-shortcut-flyout/);
  assert.match(orbSource, /role="menuitemradio"/);
  assert.doesNotMatch(orbSource, /onToggleTheme|onToggleLanguage/);
  assert.match(shellSource, /onSetTheme=\{setThemePreference\}/);
  assert.match(shellSource, /onSetLocale=/);
  assert.doesNotMatch(shellSource, /cycleLocale|onToggleTheme|onToggleLanguage/);
});
