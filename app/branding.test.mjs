import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const brandedFiles = [
  "app/layout.tsx",
  "app/manifest.ts",
  "components/AppShell.tsx",
  "components/ChatWindow.tsx",
  "components/SessionSidebar.tsx",
  "public/offline.html",
];

test("user-facing application surfaces use the Minerva brand", async () => {
  const sources = await Promise.all(brandedFiles.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");

  assert.match(combined, /Minerva/);
  assert.doesNotMatch(combined, /Pi Web/);
});
