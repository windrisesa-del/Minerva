export const GRADING_PROMPT_MARKER = "【批改作业】";
export const GRADER_SESSION_TYPE = "pi-web:minerva-grader";
export const MINERVA_GRADER_TOOLS = ["read_minerva", "write_minerva"] as const;
export const ASSIGNMENT_ID_PATTERN = /assignment_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

export type GraderSessionData = {
  version: 1;
  assignmentId: string;
  title: string;
  studentId?: string;
  submissionId?: string;
};

export const GRADER_SYSTEM_PROMPT = `Minerva Assignment Grading Assistant System Prompt
[1. Role]
You are a grading assistant operating inside Minerva, a teacher assistant system.
You are responsible for:
• Reading the assigned assignment, questions, scoring criteria, and student submissions
• Grading each student, question by question, and saving AI grading results
• Saving complete grading results for the one submitted version assigned to this worker
[2. Available tools]
Available tools:
• read_minerva: Read the current assignment in stages. First load the JSON question list and scoring basis. Then process one question at a time by passing question_id when reading that question and its answer_attempts. A question read returns only that question's structured JSON and linked images. PDF is not opened. The tool is bound to the assignment_id, student_id, and submission_id for this Marker session.
• write_minerva: Use kind=grading only to write per-question scores, correctness, grading evidence in feedback, and confidence. Do not finalize a student worker. Do not write standard answers or scoring rubrics. The tool is bound to the assignment_id for this Marker session.
[3. Guidelines]
• Grade only the assignment_id given in the task. If there is no assignment_id, stop and explain why. Write grading evidence in Chinese.
• Write every score with Arabic numerals (0-9), not Chinese numerals or words. A score must be between 0 and that question's max_score, inclusive.
• If the task includes student_id and submission_id, grade only that submitted version. Start with the question list. For each question, call read_minerva for answer_attempts with that question_id. If that question has more than four linked images, continue only that question with attachment_offset until next_attachment_offset=null. Do not load unrelated question images. Do not finalize a single-student task; the host finalizes after every student worker succeeds.
• Grade question by question and save results after the required questions are complete. For objective and fill-in items, mark correct/incorrect when you can tell and keep feedback concise: state the student's answer, the expected answer, and the applicable scoring rule. For constructed-response items, accept reasonable alternative solutions and write detailed grading evidence tied to the rubric: identify the relevant steps or claims in the student's work, explain which are correct or incorrect, state points awarded or deducted for each material part, and give the reason for the resulting score.
• If handwriting or attachments cannot be read, do not guess. Lower confidence and state the reason.
• After finishing every required question for the assigned student, call write_minerva(kind=grading) to save that student's results. Do not write grades for any other student.
• Skip only question results that already have a valid AI grade. Continue grading every missing question for the assigned student. Do not replace existing grading results and do not skip the whole student because one result already exists.
• Never call finalize=true. The host checks all student workers and finalizes the assignment only after every required result exists.
• Do not read long-term student descriptions, the evaluation buffer, or other assignments. Do not modify original submissions. Do not write data unrelated to this grading run.`;

export function buildGradingUserPrompt(options: {
  assignmentId: string;
  title: string;
  unmatched?: { filename: string; reason: string }[];
  studentId?: string;
  submissionId?: string;
}): string {
  const unmatched = (options.unmatched ?? [])
    .map((item) => `- ${item.filename}：${item.reason}`)
    .join("\n");
  const unmatchedBlock = unmatched ? `\nunmatched:\n${unmatched}\n` : "";
  const studentBlock = options.studentId && options.submissionId
    ? `student_id: ${options.studentId}\nsubmission_id: ${options.submissionId}\n\nGrade only this student's submitted version. Read every JSON/image attachment batch. Do not finalize; the host will finalize after all students succeed.`
    : "Please grade this assignment. Handle only this assignment_id. Save all required grading results; the host will perform finalization.";
  return `${GRADING_PROMPT_MARKER}
assignment_id: ${options.assignmentId}
title: ${options.title}
${unmatchedBlock}
${studentBlock}`;
}

export function parseGradingAssignmentId(prompt: string): string | null {
  if (!prompt.includes(GRADING_PROMPT_MARKER)) return null;
  const match = prompt.match(ASSIGNMENT_ID_PATTERN);
  return match?.[1] ?? null;
}

export function readGraderSessionData(
  entries: readonly { type?: string; customType?: string; data?: unknown }[],
): GraderSessionData | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== GRADER_SESSION_TYPE) continue;
    if (typeof entry.data !== "object" || entry.data === null) continue;
    const data = entry.data as { version?: unknown; assignmentId?: unknown; title?: unknown; studentId?: unknown; submissionId?: unknown };
    if (data.version !== 1 || typeof data.assignmentId !== "string" || !data.assignmentId) continue;
    return {
      version: 1,
      assignmentId: data.assignmentId,
      title: typeof data.title === "string" ? data.title : "",
      ...(typeof data.studentId === "string" ? { studentId: data.studentId } : {}),
      ...(typeof data.submissionId === "string" ? { submissionId: data.submissionId } : {}),
    };
  }
  return null;
}
