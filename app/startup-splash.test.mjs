import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("startup splash loops its shimmer while gating exit on the first cycle and application readiness", async () => {
  const [splash, shell, sidebar, layout, css] = await Promise.all([
    read("components/StartupSplash.tsx"),
    read("components/AppShell.tsx"),
    read("components/SessionSidebar.tsx"),
    read("app/layout.tsx"),
    read("app/startup-splash.css"),
  ]);

  assert.match(splash, /cycleComplete/);
  assert.match(splash, /!ready && !fallbackReady/);
  assert.match(splash, /addEventListener\("animationiteration", finishFirstCycle\)/);
  assert.match(splash, /FIRST_SHIMMER_CYCLE_MS = 2_700/);
  assert.match(splash, /FAILURE_ESCAPE_MS = 30_000/);
  assert.match(splash, /if \(!leaving\) return;[\s\S]*setDismissed\(true\)/);
  assert.match(css, /minerva-startup-shimmer 2s linear 700ms infinite/);
  assert.doesNotMatch(css, /minerva-startup-shimmer 2s linear 700ms 1 both/);
  assert.match(css, /minerva-startup-curtain-out 480ms/);
  assert.match(css, /\.minerva-startup-mark\s*\{[\s\S]*user-select:\s*none/);
  assert.match(shell, /<StartupSplash ready=\{startupReady\}/);
  assert.match(shell, /startupSessionCount !== null[\s\S]*startupContentReady/);
  assert.match(shell, /startupWorkspaceRestoreSettled[\s\S]*startupContentReady/);
  assert.match(shell, /startupChatReadyKey === sessionKey/);
  assert.match(shell, /setStartupWorkspaceRestoreSettled\(false\)[\s\S]*fetch\("\/api\/sessions"\)[\s\S]*\.finally/);
  assert.match(shell, /setStartupWorkspaceRestoreSettled\(true\)/);
  assert.match(shell, /setStartupChatReadyKey\(sessionKey\)/);
  assert.match(splash, /!ready && !fallbackReady/);
  const chat = await read("components/ChatWindow.tsx");
  assert.match(chat, /document\.fonts\?\.ready/);
  assert.match(chat, /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*onInitialReady\?\.\(\)/);
  assert.match(sidebar, /onInitialLoadComplete\?\.\(loadedSessions \?\? \[\]\)/);
  assert.match(splash, /sessionStorage\.setItem\(STARTUP_SEEN_KEY, "1"\)/);
  assert.match(splash, /sessionStorage\.getItem\(STARTUP_SEEN_KEY\)/);
  assert.match(layout, /sessionStorage\.getItem\("minerva-startup-seen"\)/);
  assert.match(css, /html\.minerva-startup-seen \.minerva-startup-splash/);
});

test("startup splash preserves theme and reduced-motion behavior", async () => {
  const [splash, css] = await Promise.all([
    read("components/StartupSplash.tsx"),
    read("app/startup-splash.css"),
  ]);

  assert.match(splash, /toggleTheme/);
  assert.match(css, /html:not\(\.dark\) \.minerva-startup-icon-moon/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /-webkit-text-fill-color: var\(--text\)/);
});
