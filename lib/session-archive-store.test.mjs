import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSessionFamilyIds, readSessionArchiveIndex, setSessionsArchived } from "./session-archive-store.ts";

test("archives and restores session ids without deleting session files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "minerva-session-archive-"));
  const file = join(dir, "archive.json");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await setSessionsArchived(["root", "child"], true, file);
  assert.deepEqual(Object.keys((await readSessionArchiveIndex(file)).sessions).sort(), ["child", "root"]);
  await setSessionsArchived(["root", "child"], false, file);
  assert.deepEqual((await readSessionArchiveIndex(file)).sessions, {});
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("collects only the root session and its subagent descendants", () => {
  const session = (id, relation) => ({ id, relation });
  const ids = collectSessionFamilyIds([
    session("root"),
    session("child", { kind: "subagent", parentSessionId: "root" }),
    session("grandchild", { kind: "subagent", parentSessionId: "child" }),
    session("fork", { kind: "fork", originSessionId: "root" }),
  ], "root");
  assert.deepEqual(ids.sort(), ["child", "grandchild", "root"]);
});
