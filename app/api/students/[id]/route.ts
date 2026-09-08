import { NextRequest, NextResponse } from "next/server";
import { syncStudentsToDatabase } from "@/lib/student-database-sync";
import { updateStudent } from "@/lib/student-store";
import type { StudentInput } from "@/lib/student-types";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    const { id } = await params;
    const patch = await request.json() as StudentInput;
    const student = await updateStudent(id, patch);
    await syncStudentsToDatabase([student]);
    return NextResponse.json({ student });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "未找到学生" ? 404 : 400 });
  }
}
