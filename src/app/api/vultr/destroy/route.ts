import { NextResponse } from "next/server";
import { destroyVultrRunner } from "@/lib/vultr-runner";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { instanceId?: string };
    const result = await destroyVultrRunner(payload.instanceId || "");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not destroy Vultr runner." },
      { status: 400 },
    );
  }
}
