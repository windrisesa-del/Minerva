import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { classifyMinervaAttachment, createMinervaDataExtension, shouldLoadAttachment } = await createJiti(import.meta.url).import("./minerva-data-extension.ts");

test("minerva extension registers the two data tools without swapping the host prompt", async () => {
  const tools = new Map();
  const hooks = [];
  const extension = createMinervaDataExtension();
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { hooks.push({ name, handler }); },
    setActiveTools() {},
  });
  assert.deepEqual([...tools.keys()], ["read_minerva", "write_minerva"]);
  assert.equal(hooks.some((hook) => hook.name === "before_agent_start"), false);
});

test("read_minerva loads JSON question files, not only images", () => {
  assert.equal(
    classifyMinervaAttachment({
      storage_key: "/uploads/assignments/a/spec/questions.json",
      mime_type: "application/json",
      original_name: "questions.json",
    }),
    "json",
  );
  assert.equal(
    classifyMinervaAttachment({
      storage_key: "/uploads/assignments/a/1/page.png",
      mime_type: "image/png",
      original_name: "page.png",
    }),
    "image",
  );
  assert.equal(
    classifyMinervaAttachment({
      storage_key: "/uploads/assignments/a/1/答卷.pdf",
      mime_type: "application/pdf",
      original_name: "答卷.pdf",
    }),
    "skip",
  );
  const questionJson = {
    storage_key: "/uploads/assignments/a/spec/questions.json",
    mime_type: "application/json",
    original_name: "questions.json",
  };
  const page = {
    storage_key: "/uploads/assignments/a/1/page.png",
    mime_type: "image/png",
    original_name: "page.png",
  };
  const paper = {
    storage_key: "/uploads/assignments/a/1/答卷.pdf",
    mime_type: "application/pdf",
    original_name: "答卷.pdf",
  };
  assert.equal(shouldLoadAttachment("questions", questionJson), true);
  assert.equal(shouldLoadAttachment("questions", page), false);
  assert.equal(shouldLoadAttachment("questions", page, { allAssignmentFiles: true }), true);
  assert.equal(shouldLoadAttachment("assignment_items", page, { allAssignmentFiles: true }), true);
  assert.equal(shouldLoadAttachment("questions", paper), false);
  assert.equal(shouldLoadAttachment("answer_attempts", page), true);
  assert.equal(shouldLoadAttachment("answer_attempts", questionJson), true);
  assert.equal(shouldLoadAttachment("answer_attempts", paper), false);
  assert.equal(shouldLoadAttachment("grading_results", questionJson), false);
  assert.equal(shouldLoadAttachment("answer_attempts", page, { jsonOnly: true }), false);
  assert.equal(shouldLoadAttachment("answer_attempts", questionJson, { jsonOnly: true }), true);
  assert.equal(shouldLoadAttachment("questions", page, { jsonOnly: true }), false);
  assert.equal(shouldLoadAttachment("grading_results", questionJson, { jsonOnly: true }), true);
});

test("Marker tools are hard-bound to the current assignment", async (t) => {
  const assignmentId = "11111111-2222-4333-a444-555555555555";
  const otherAssignmentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const tools = new Map();
  const extension = createMinervaDataExtension({ graderAssignmentId: assignmentId });
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    setActiveTools() {},
  });

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const readTool = tools.get("read_minerva");
  const writeTool = tools.get("write_minerva");
  const outsideResource = await readTool.execute("read-1", { resource: "student_description", student_id: "student" });
  assert.equal(outsideResource.isError, true);
  const outsideAssignment = await readTool.execute("read-2", { resource: "questions", assignment_id: otherAssignmentId });
  assert.equal(outsideAssignment.isError, true);
  assert.equal(requests.length, 0);

  await readTool.execute("read-3", { resource: "questions", assignment_id: assignmentId });
  assert.match(requests[0].input, new RegExp(`assignment_id=${assignmentId}`));

  const outsideKind = await writeTool.execute("write-1", {
    kind: "student_description",
    assignment_id: assignmentId,
  });
  assert.equal(outsideKind.isError, true);
  const outsideWrite = await writeTool.execute("write-2", {
    kind: "grading",
    assignment_id: otherAssignmentId,
  });
  assert.equal(outsideWrite.isError, true);

  const forbiddenFinalize = await writeTool.execute("write-3", {
    kind: "grading",
    assignment_id: assignmentId,
    finalize: true,
  });
  assert.equal(forbiddenFinalize.isError, true);
  assert.match(forbiddenFinalize.content[0].text, /不能 finalize/);
  assert.equal(requests.length, 1);
});

test("Evaluator tools enforce assignment, student, and submission scoped observation access", async (t) => {
  const assignmentId = "11111111-2222-4333-a444-555555555555";
  const otherAssignmentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const studentId = "99999999-8888-4777-a666-555555555555";
  const otherStudentId = "22222222-8888-4777-a666-555555555555";
  const submissionId = "77777777-8888-4999-a666-555555555555";
  const tools = new Map();
  const extension = createMinervaDataExtension({
    evaluatorAssignmentId: assignmentId,
    evaluatorStudentId: studentId,
    evaluatorSubmissionId: submissionId,
  });
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    setActiveTools() {},
  });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ input: url, init });
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const readTool = tools.get("read_minerva");
  const writeTool = tools.get("write_minerva");
  assert.equal((await readTool.execute("read-1", { resource: "submissions", assignment_id: assignmentId })).isError, true);
  assert.equal((await readTool.execute("read-2", { resource: "grading_results", assignment_id: otherAssignmentId })).isError, true);
  assert.equal((await readTool.execute("read-3", { resource: "student_description", student_id: otherStudentId })).isError, true);
  assert.equal(requests.length, 0);

  await readTool.execute("read-4", { resource: "grading_results" });
  assert.match(requests[0].input, new RegExp(`assignment_id=${assignmentId}`));
  assert.match(requests[0].input, new RegExp(`student_id=${studentId}`));
  assert.match(requests[0].input, new RegExp(`submission_id=${submissionId}`));
  assert.match(requests[0].input, /grader_type=ai/);

  await readTool.execute("read-5", { resource: "student_description" });
  assert.match(requests[1].input, new RegExp(`student_id=${studentId}`));

  assert.equal((await writeTool.execute("write-1", {
    kind: "grading",
    assignment_id: assignmentId,
    student_id: studentId,
  })).isError, true);
  assert.equal((await writeTool.execute("write-2", {
    kind: "student_observation",
    assignment_id: otherAssignmentId,
    student_id: studentId,
    profile_fields: { learning_trajectory: {} },
  })).isError, true);
  assert.equal((await writeTool.execute("write-other-student", {
    kind: "student_observation",
    assignment_id: assignmentId,
    student_id: otherStudentId,
    buffer_items: [],
  })).isError, true);
  assert.equal(requests.length, 2);

  await writeTool.execute("write-3", {
    kind: "student_observation",
    assignment_id: assignmentId,
    student_id: studentId,
    profile_fields: {
      learning_trajectory: {
        recent_progress: [],
        recent_regressions: [],
        emerging_problems: [],
        developing_abilities: ["开始在多步题中写出中间依据"],
        evidence_refs: [],
      },
    },
    buffer_items: [],
  });
  const writeRequest = requests.find((request) => request.init?.method === "POST");
  assert.ok(writeRequest);
  const body = JSON.parse(writeRequest.init.body);
  assert.equal(body.assignment_id, assignmentId);
  assert.equal(body.authored_by, "agent");
  assert.equal(body.student_id, studentId);
  assert.equal(body.kind, "student_observation");
});

test("Marker answer reads require one question and bind the current submission", async (t) => {
  const assignmentId = "11111111-2222-4333-a444-555555555555";
  const studentId = "student-1";
  const submissionId = "submission-2";
  const tools = new Map();
  const extension = createMinervaDataExtension({
    graderAssignmentId: assignmentId,
    graderStudentId: studentId,
    graderSubmissionId: submissionId,
  });
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    setActiveTools() {},
  });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const missingQuestion = await tools.get("read_minerva").execute("missing-question", {
    resource: "answer_attempts",
    assignment_id: assignmentId,
    student_id: studentId,
  });
  assert.equal(missingQuestion.isError, true);
  assert.equal(requests.length, 0);

  await tools.get("read_minerva").execute("one-question", {
    resource: "answer_attempts",
    assignment_id: assignmentId,
    student_id: studentId,
    question_id: "question-3",
  });
  assert.match(requests[0], /student_id=student-1/);
  assert.match(requests[0], /submission_id=submission-2/);
  assert.match(requests[0], /question_id=question-3/);
});

test("Marker exposes every unique image through visible four-image batches", async (t) => {
  const assignmentId = "11111111-2222-4333-a444-555555555555";
  const tools = new Map();
  const extension = createMinervaDataExtension({ graderAssignmentId: assignmentId });
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    setActiveTools() {},
  });

  const attachments = Array.from({ length: 9 }, (_, index) => ({
    storage_key: `/uploads/assignments/${assignmentId}/submission/page-${index + 1}.png`,
    mime_type: "image/png",
    original_name: `page-${index + 1}.png`,
  }));
  attachments.push(attachments[0]);
  attachments.push({
    storage_key: `/uploads/assignments/${assignmentId}/submission/answers.json`,
    mime_type: "application/json",
    original_name: "answers.json",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/minerva/read?")) {
      return new Response(JSON.stringify({ records: [{ attachments }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("answers.json")) {
      return new Response(JSON.stringify({
        answer: "A",
        assets: {
          diagram: {
            source_path: `/uploads/assignments/${assignmentId}/spec/diagram.png`,
            mime_type: "image/png",
          },
          outside: {
            source_path: "/uploads/assignments/other/spec/outside.png",
            mime_type: "image/png",
          },
        },
      }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const pages = [];
  for (const attachmentOffset of [0, 4, 8]) {
    pages.push(await tools.get("read_minerva").execute(`read-${attachmentOffset}`, {
      resource: "answer_attempts",
      assignment_id: assignmentId,
      student_id: "student",
      question_id: "question-1",
      attachment_offset: attachmentOffset,
    }));
  }
  assert.deepEqual(pages.map((result) => result.content.filter((item) => item.type === "image").length), [4, 4, 2]);
  assert.deepEqual(pages.map((result) => JSON.parse(result.content[0].text).attachment_page), [
    { total_images: 10, next_attachment_offset: 4 },
    { total_images: 10, next_attachment_offset: 8 },
    { total_images: 10, next_attachment_offset: null },
  ]);
  const payload = JSON.parse(pages[0].content[0].text);
  assert.equal(payload.records[0].attachments.at(-1).content.answer, "A");
});
