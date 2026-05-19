import { NextResponse } from "next/server";
import { attachManualVultrRunner } from "@/lib/vultr-runner";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { statusUrl?: string };
    if (!payload.statusUrl?.trim()) throw new Error("Manual runner status URL is required.");
    return NextResponse.json(await attachManualVultrRunner(payload.statusUrl.trim()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not attach manual Vultr runner." },
      { status: 400 },
    );
  }
}
