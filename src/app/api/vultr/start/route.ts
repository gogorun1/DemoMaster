import { NextResponse } from "next/server";
import { startVultrRunner } from "@/lib/vultr-runner";
import type { DemoCapturePlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { repoUrl?: string; capturePlan?: DemoCapturePlan };
    if (!payload.repoUrl?.trim()) throw new Error("Repository URL is required.");
    if (!payload.capturePlan) throw new Error("Capture plan is required.");
    const result = await startVultrRunner(payload.repoUrl.trim(), payload.capturePlan);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start Vultr runner." },
      { status: 400 },
    );
  }
}
