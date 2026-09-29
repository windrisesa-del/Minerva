import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { readProcessingState } = await createJiti(import.meta.url).import("./minerva-processing.ts");

test("completion checks can scope one student without narrowing full startup/recovery reads", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(new URL(url));
    return Response.json({ assignment_id: "assignment", assignment_status: "grading", students: [] });
  });
  await readProcessingState("assignment", "student");
  await readProcessingState("assignment");
  assert.equal(requests[0].searchParams.get("student_id"), "student");
  assert.equal(requests[1].search, "");
});

test("a failed scoped completion read remains an error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "unavailable" }, { status: 503 }));
  await assert.rejects(readProcessingState("assignment", "student"), /unavailable/);
});
