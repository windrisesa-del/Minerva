import { NextResponse } from "next/server";
import { readGradingRuns } from "@/lib/grading-run-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = (await readGradingRuns()).map((run) => ({
      ...run,
      running: run.status === "running",
    }));
    return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
