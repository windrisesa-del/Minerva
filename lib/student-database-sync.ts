import type { StudentRecord } from "./student-types";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

export async function syncStudentsToDatabase(students: StudentRecord[]): Promise<void> {
  if (students.length === 0) return;
  const response = await fetch(`${dataApiUrl()}/api/students/sync`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(students),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: `HTTP ${response.status}` })) as { detail?: string; error?: string };
    throw new Error(payload.detail || payload.error || "学习数据库写入失败");
  }
}
