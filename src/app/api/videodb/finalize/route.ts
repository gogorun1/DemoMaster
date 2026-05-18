import { NextResponse } from "next/server";
import { finalizeVideoDbMedia } from "@/lib/videodb";
import type { VideoDbAsset } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { assets?: VideoDbAsset[] };
    const videoDbMedia = await finalizeVideoDbMedia(payload.assets || []);
    return NextResponse.json({ videoDbMedia });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not finalize VideoDB stream." },
      { status: 400 },
    );
  }
}
