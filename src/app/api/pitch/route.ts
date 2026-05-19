import { NextResponse } from "next/server";
import { generateNarrationAudio, generatePitchWithAgents } from "@/lib/gemini";
import { loadRepoContext } from "@/lib/repo-context";
import type { AgentLog, PitchRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Partial<PitchRequest>;
    const input = sanitizeRequest(payload);
    const repo = await loadRepoContext(input.repoUrl);
    const { pitch, agentLogs } = await generatePitchWithAgents(input, repo);
    const audio = await generateNarrationAudio(pitch);
    const warnings = Array.from(new Set([
      ...repo.warnings,
      pitch.mode === "fallback" ? "Agentic generation degraded; returned the deterministic fallback pitch." : "",
      audio.status !== "ready" ? audio.message : "",
    ].filter(Boolean)));
    const fullLogs: AgentLog[] = [
      ...agentLogs,
      {
        agent: "Media Renderer Agent",
        provider: "browser",
        entries: [
          {
            step: "Generate narration",
            status: audio.status === "ready" ? "done" : audio.status,
            message: audio.message,
          },
          {
            step: "Prepare browser renderer",
            status: "done",
            message: "Prepared a timed canvas video that can be played and exported as WebM in the browser.",
          },
        ],
      },
    ];

    return NextResponse.json({ repo, pitch, audio, warnings, agentLogs: fullLogs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not generate pitch video." },
      { status: 400 },
    );
  }
}

function sanitizeRequest(payload: Partial<PitchRequest>): PitchRequest {
  if (!payload.repoUrl?.trim()) throw new Error("A GitHub repository URL is required.");
  return { repoUrl: payload.repoUrl.trim() };
}
