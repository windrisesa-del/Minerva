const DEFAULT_DATA_API = "http://127.0.0.1:8000";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

export type ProcessingStatus = "submitted" | "grading" | "graded";

export type ProcessingStudent = {
  student_id: string;
  student_name?: string;
  submission_id: string;
  status: ProcessingStatus;
  grading_complete: boolean;
  evaluation_complete: boolean;
};

export type ProcessingState = {
  assignment_id: string;
  assignment_status: string;
  students: ProcessingStudent[];
};

export async function readProcessingState(assignmentId: string): Promise<ProcessingState> {
  const response = await fetch(`${dataApiUrl()}/api/assignments/${encodeURIComponent(assignmentId)}/processing`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({ detail: "批改进度返回了无效响应" })) as ProcessingState & { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `读取批改进度失败 HTTP ${response.status}`);
  return payload;
}

export async function setStudentProcessing(options: {
  assignmentId: string;
  studentId: string;
  status: ProcessingStatus;
}): Promise<void> {
  const response = await fetch(`${dataApiUrl()}/api/minerva/write`, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "processing",
      assignment_id: options.assignmentId,
      student_id: options.studentId,
      status: options.status,
    }),
  });
  const payload = await response.json().catch(() => ({ detail: "更新批改进度返回了无效响应" })) as { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `更新批改进度失败 HTTP ${response.status}`);
}

export async function resetStuckGradingStudents(assignmentId: string): Promise<void> {
  const state = await readProcessingState(assignmentId);
  for (const student of state.students) {
    if (student.status === "grading" && !student.grading_complete) {
      await setStudentProcessing({
        assignmentId,
        studentId: student.student_id,
        status: "submitted",
      });
    }
  }
}
