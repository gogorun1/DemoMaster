import { NextResponse } from "next/server";
import { getVultrRunnerStatus } from "@/lib/vultr-runner";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { instanceId?: string; port?: number };
    const result = await getVultrRunnerStatus(payload.instanceId || "", payload.port || 3000);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read Vultr runner status." },
      { status: 400 },
    );
  }
}
