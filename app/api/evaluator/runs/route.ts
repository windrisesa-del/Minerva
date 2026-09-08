import { NextResponse } from "next/server";
import { reconcileInterruptedEvaluatorRuns } from "@/lib/minerva-evaluator-recovery";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await reconcileInterruptedEvaluatorRuns();
    return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
