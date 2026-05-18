import { NextResponse } from "next/server";
import { generatePitchPlan, generatePreviewNarration } from "@/lib/gemini";
import { loadRepoContext } from "@/lib/repo-context";
import { generatePitchMediaAssets } from "@/lib/videodb";
import type { AgentLog, PitchRequest, RepoContext } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Partial<PitchRequest>;
    const input = sanitizeRequest(payload);
    const repo = await loadRepoContext(input.repoUrl);
    const pitch = await generatePitchPlan(input, repo);
    const videoDbMedia = await generatePitchMediaAssets(pitch);
    const pitchWithMedia = { ...pitch, videoDbMedia };
    const audio = await generatePreviewNarration(pitchWithMedia, input.includeVoice);
    const warnings = [
      ...repo.warnings,
      videoDbMedia.status === "error" ? videoDbMedia.message : "",
      audio.status !== "ready" ? audio.message : "",
    ].filter(Boolean);

    const agentLogs: AgentLog[] = [
      {
        agent: "Repo Strategist Agent",
        entries: [
          {
            step: "Inspect repository",
            status: repo.source === "github" ? "done" : repo.source === "manual" ? "skipped" : "error",
            message: repoSummary(repo),
          },
          {
            step: "Generate pitch strategy",
            status: "done",
            message: `Created ${pitch.scenes.length} timed scene(s), transcript, and positioning for ${pitch.productName}.`,
          },
          {
            step: "Generate browser preview narration",
            status: audio.status === "ready" ? "done" : audio.status,
            message: audio.message,
          },
        ],
      },
      {
        agent: "VideoDB Media Director Agent",
        entries: videoDbMedia.logs,
      },
    ];

    return NextResponse.json({ repo, pitch: pitchWithMedia, audio, warnings, agentLogs });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not generate pitch.",
      },
      { status: 400 },
    );
  }
}

function repoSummary(repo: RepoContext) {
  if (repo.source !== "github") return repo.warnings[0] || "Repository was not inspected from GitHub.";
  return `Loaded ${repo.files.length} high-signal file(s) from ${repo.owner}/${repo.repo} on ${repo.branch}.`;
}

function sanitizeRequest(payload: Partial<PitchRequest>): PitchRequest {
  if (!payload.repoUrl?.trim()) {
    throw new Error("A demo repository URL is required.");
  }

  return {
    repoUrl: payload.repoUrl.trim(),
    productHint: payload.productHint?.trim(),
    audience: payload.audience?.trim() || "founders, judges, and product buyers",
    style: payload.style || "launch",
    includeVoice: payload.includeVoice ?? true,
  };
}
