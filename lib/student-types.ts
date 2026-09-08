export type StudentChangeSource = "manual" | "csv_import";

export interface StudentRecord {
  id: string;
  name: string;
  studentNumber: string;
  className: string;
  groupName: string;
  guardianName: string;
  guardianPhone: string;
  email: string;
  notes: string;
  portrait: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudentInput {
  name: string;
  studentNumber?: string;
  className?: string;
  groupName?: string;
  guardianName?: string;
  guardianPhone?: string;
  email?: string;
  notes?: string;
  portrait?: string;
}

export interface StudentChangeRecord {
  id: string;
  studentId: string;
  studentName: string;
  field: keyof StudentInput | "student";
  oldValue: string;
  newValue: string;
  source: StudentChangeSource;
  actor: string;
  timestamp: string;
}

export interface StudentStoreSnapshot {
  version: 1;
  students: StudentRecord[];
  changes: StudentChangeRecord[];
}

export const STUDENT_FIELD_LABELS: Record<StudentChangeRecord["field"], string> = {
  student: "学生档案",
  name: "姓名",
  studentNumber: "学号",
  className: "班级",
  groupName: "分组",
  guardianName: "监护人",
  guardianPhone: "联系电话",
  email: "邮箱",
  notes: "备注",
  portrait: "头像",
};
