import { NextResponse } from "next/server";
import { runBrowserCapture } from "@/lib/capture-runner";
import type { DemoCapturePlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { repoUrl?: string; capturePlan?: DemoCapturePlan };
    if (!payload.repoUrl?.trim()) throw new Error("Repository URL or live app URL is required.");
    if (!payload.capturePlan) throw new Error("Capture plan is required.");
    return NextResponse.json(await runBrowserCapture(payload.repoUrl.trim(), payload.capturePlan));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not capture demo." },
      { status: 400 },
    );
  }
}
