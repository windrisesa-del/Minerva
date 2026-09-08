import { NextRequest, NextResponse } from "next/server";
import { syncStudentsToDatabase } from "@/lib/student-database-sync";
import { addStudents, readStudentStore } from "@/lib/student-store";
import type { StudentChangeSource, StudentInput } from "@/lib/student-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readStudentStore(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    const body = await request.json() as { students?: StudentInput[]; source?: StudentChangeSource };
    if (!Array.isArray(body.students)) {
      return NextResponse.json({ error: "students must be an array" }, { status: 400 });
    }
    const source = body.source === "csv_import" ? "csv_import" : "manual";
    const students = await addStudents(body.students, source);
    await syncStudentsToDatabase(students);
    return NextResponse.json({ students }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
