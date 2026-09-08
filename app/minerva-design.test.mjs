import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Minerva design tokens and semantic surfaces stay wired together", async () => {
  const [globals, settings, layout, shell, chat, input, sidebar, messages] = await Promise.all([
    read("app/globals.css"),
    read("app/settings.css"),
    read("app/layout.tsx"),
    read("components/AppShell.tsx"),
    read("components/ChatWindow.tsx"),
    read("components/ChatInput.tsx"),
    read("components/SessionSidebar.tsx"),
    read("components/MessageView.tsx"),
  ]);

  assert.match(globals, /--bg:\s*#faf9f5/);
  assert.match(globals, /--accent:\s*#cc785c/);
  assert.match(globals, /--text-body:\s*#3d3d3a/);
  assert.match(globals, /--font-ui:\s*var\(--font-source-sans\), var\(--font-noto-sans-sc\)/);
  assert.match(globals, /\.markdown-body\s*\{[\s\S]*font-size:\s*15px/);
  assert.match(layout, /Noto_Sans_SC, Source_Sans_3/);
  assert.match(globals, /html\.dark[\s\S]*--bg:\s*#181715/);
  assert.match(globals, /html\.dark \.minerva-chat[\s\S]*background:\s*var\(--bg\) !important/);
  assert.match(globals, /html\.dark \.minerva-chat::before/);
  assert.match(globals, /\.minerva-welcome-card/);
  assert.match(settings, /Minerva warm-editorial product surfaces/);
  assert.match(shell, /className="minerva-app"/);
  assert.match(shell, /className="minerva-topbar-row"/);
  assert.match(globals, /\.minerva-topbar-row > button,[\s\S]*\.minerva-chat-toolbar-actions > button[\s\S]*border-right:\s*0 !important/);
  assert.match(globals, /\.minerva-topbar\s*\{[\s\S]*border-bottom:\s*0 !important/);
  assert.match(chat, /className="minerva-welcome-card\b/);
  assert.match(input, /className="minerva-composer"/);
  assert.match(sidebar, /className="minerva-session-item"/);
  assert.match(sidebar, /className="minerva-session-copy"/);
  assert.match(globals, /\.minerva-session-copy\s*\{[\s\S]*user-select:\s*none/);
  assert.match(messages, /className="minerva-user-message"/);
  assert.doesNotMatch(messages, /rgba\(59,130,246,0\.2\)/);
});

test("topbar styling does not leak into language and tool-panel buttons", async () => {
  const css = await read("app/globals.css");
  assert.doesNotMatch(css, /\.minerva-topbar-row button \{/);
  assert.doesNotMatch(css, /\.minerva-topbar-row button:hover/);
  assert.match(css, /\.minerva-chat-toolbar-actions > button/);
  assert.match(css, /\.minerva-language-option\.selected/);
});

test("development unregisters stale Pi Web static caches", async () => {
  const [registration, recoveryRoute] = await Promise.all([
    read("components/PwaRegistration.tsx"),
    read("app/dev-reset/route.ts"),
  ]);

  assert.match(registration, /process\.env\.NODE_ENV !== "production"/);
  assert.match(registration, /registration\.unregister\(\)/);
  assert.match(registration, /key\.startsWith\("pi-web-"\)/);
  assert.match(recoveryRoute, /process\.env\.NODE_ENV === "production"/);
  assert.match(recoveryRoute, /registration\.unregister\(\)/);
  assert.match(recoveryRoute, /Cache-Control": "no-store"/);
});
