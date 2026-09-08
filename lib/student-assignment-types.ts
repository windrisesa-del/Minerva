export type AssignmentStatus = "draft" | "ungraded" | "graded" | "archived";
export type SubmissionStatus = "not_started" | "draft" | "submitted" | "graded";

export interface AssignmentSummary {
  id: string;
  title: string;
  status: AssignmentStatus;
  published_at: string | null;
  due_at: string | null;
  created_at: string;
  class_id: string;
  class_name: string;
  item_count: number;
  max_score: number;
  student_count: number;
  submission_count: number;
  completed_count: number;
  completion_rate: number;
  average_score: number | null;
}

export interface AssignmentStudent {
  id: string;
  name: string;
  student_number: string | null;
  group_name: string;
  submission_status: SubmissionStatus;
  attempt_number: number | null;
  started_at: string | null;
  submitted_at: string | null;
  answered_questions: number;
  total_questions: number;
  correct_answers: number;
  accuracy: number | null;
  score: number | null;
  max_score: number;
}

export interface AssignmentListResponse {
  summary: {
    assignment_count: number;
    archived_count: number;
    published_count: number;
    ungraded_count: number;
    graded_count: number;
    completed_submissions: number;
    expected_submissions: number;
    overall_completion_rate: number;
    average_score: number | null;
  };
  assignments: AssignmentSummary[];
}

export interface AssignmentDetailResponse {
  assignment: AssignmentSummary;
  students: AssignmentStudent[];
}

export interface AssignmentClassOption {
  id: string;
  name: string;
  status: string;
  student_count: number;
}

export interface AssignmentImportResponse {
  assignment_id: string;
  title: string;
  class_id: string;
  class_name: string;
  imported_students: number;
  unmatched: { filename: string; reason: string }[];
  adapter_sources: {
    role: "assessment_material" | "student_submission";
    student_id?: string;
    storage_key: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
  }[];
}

export interface GradingRun {
  assignmentId: string;
  sessionId: string;
  title: string;
  startedAt: string;
  running: boolean;
  status?: "running" | "completed" | "failed";
  completedStudents?: number;
  totalStudents?: number;
  error?: string;
  failedAt?: string;
  cleanupPending?: boolean;
}
