import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  StudentChangeRecord,
  StudentChangeSource,
  StudentInput,
  StudentRecord,
  StudentStoreSnapshot,
} from "./student-types";

const STORE_PATH = join(homedir(), ".pi", "minerva", "students.json");
const EMPTY_STORE: StudentStoreSnapshot = { version: 1, students: [], changes: [] };
const MAX_TEXT_LENGTH = 2_000;
const MAX_PORTRAIT_LENGTH = 1_800_000;
let mutationQueue: Promise<void> = Promise.resolve();

const editableFields: Array<keyof StudentInput> = [
  "name",
  "studentNumber",
  "className",
  "groupName",
  "guardianName",
  "guardianPhone",
  "email",
  "notes",
  "portrait",
];

function cleanText(value: unknown, field: keyof StudentInput): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const limit = field === "portrait" ? MAX_PORTRAIT_LENGTH : MAX_TEXT_LENGTH;
  if (trimmed.length > limit) throw new Error(`${field} is too long`);
  if (field === "portrait" && trimmed && !trimmed.startsWith("data:image/")) {
    throw new Error("portrait must be an image data URL");
  }
  return trimmed;
}

function normalizeInput(input: StudentInput): Required<StudentInput> {
  const normalized = Object.fromEntries(
    editableFields.map((field) => [field, cleanText(input[field], field)]),
  ) as unknown as Required<StudentInput>;
  if (!normalized.name) throw new Error("学生姓名不能为空");
  return normalized;
}

function validateStore(value: unknown): StudentStoreSnapshot {
  if (!value || typeof value !== "object") throw new Error("学生数据文件格式无效");
  const candidate = value as Partial<StudentStoreSnapshot>;
  if (candidate.version !== 1 || !Array.isArray(candidate.students) || !Array.isArray(candidate.changes)) {
    throw new Error("学生数据文件格式无效");
  }
  return candidate as StudentStoreSnapshot;
}

export async function readStudentStore(): Promise<StudentStoreSnapshot> {
  try {
    return validateStore(JSON.parse(await readFile(STORE_PATH, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STORE);
    throw error;
  }
}

async function writeStudentStore(store: StudentStoreSnapshot): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporaryPath, STORE_PATH);
}

async function mutateStudentStore<T>(mutator: (store: StudentStoreSnapshot) => T | Promise<T>): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      const store = await readStudentStore();
      const value = await mutator(store);
      await writeStudentStore(store);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

function displayChangeValue(field: keyof StudentInput, value: string): string {
  if (field !== "portrait") return value || "未填写";
  return value ? "已设置" : "未设置";
}

function makeChange(
  student: StudentRecord,
  field: StudentChangeRecord["field"],
  oldValue: string,
  newValue: string,
  source: StudentChangeSource,
  timestamp: string,
): StudentChangeRecord {
  return {
    id: randomUUID(),
    studentId: student.id,
    studentName: student.name,
    field,
    oldValue,
    newValue,
    source,
    actor: "本机教师",
    timestamp,
  };
}

export async function addStudents(
  inputs: StudentInput[],
  source: StudentChangeSource,
): Promise<StudentRecord[]> {
  if (inputs.length === 0) throw new Error("至少需要一名学生");
  if (inputs.length > 500) throw new Error("单次最多导入 500 名学生");
  const normalizedInputs = inputs.map(normalizeInput);
  return mutateStudentStore((store) => {
    const timestamp = new Date().toISOString();
    const added = normalizedInputs.map<StudentRecord>((input) => ({
      id: randomUUID(),
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    store.students.unshift(...added);
    store.changes.unshift(...added.map((student) => makeChange(
      student,
      "student",
      "未创建",
      "已创建",
      source,
      timestamp,
    )));
    return added;
  });
}

export async function updateStudent(
  id: string,
  patch: StudentInput,
): Promise<StudentRecord> {
  return mutateStudentStore((store) => {
    const student = store.students.find((candidate) => candidate.id === id);
    if (!student) throw new Error("未找到学生");
    const timestamp = new Date().toISOString();
    const changes: StudentChangeRecord[] = [];
    for (const field of editableFields) {
      if (!(field in patch)) continue;
      const nextValue = cleanText(patch[field], field);
      if (field === "name" && !nextValue) throw new Error("学生姓名不能为空");
      const previousValue = student[field];
      if (previousValue === nextValue) continue;
      student[field] = nextValue;
      changes.push(makeChange(
        student,
        field,
        displayChangeValue(field, previousValue),
        displayChangeValue(field, nextValue),
        "manual",
        timestamp,
      ));
    }
    if (changes.length > 0) {
      student.updatedAt = timestamp;
      student.name = cleanText(student.name, "name");
      for (const change of changes) change.studentName = student.name;
      store.changes.unshift(...changes);
    }
    return student;
  });
}
