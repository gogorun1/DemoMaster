import { NextResponse } from "next/server";
import { fallbackAgentLogs, fallbackPitchPlan } from "@/lib/fallback";
import { generateNarrationAudio, generatePitchWithAgents } from "@/lib/gemini";
import { loadRepoContext } from "@/lib/repo-context";
import { runSpeechmaticsVoiceQa } from "@/lib/speechmatics";
import type { AgentLog, AudioResult, PitchPlan, PitchRequest, RepoContext, VoiceQaResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_REPO_CONTEXT_TIMEOUT_MS = 15000;
const DEFAULT_AUDIO_TIMEOUT_MS = 45000;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Partial<PitchRequest>;
    const input = sanitizeRequest(payload);
    const repoResult = await loadRepoWithBudget(input);
    const repo = repoResult.repo;
    const generation = await generatePitchWithBudget(input, repo);
    const { pitch, agentLogs } = generation;
    const audio = await generateAudioWithBudget(pitch);
    const voiceQa = await generateVoiceQaWithBudget(audio, pitch);
    pitch.partnerStack = pitch.partnerStack.map((partner) =>
      partner.name === "Speechmatics"
        ? {
            ...partner,
            status: voiceQa.voiceQa.status === "ready" ? "ready" : voiceQa.voiceQa.status === "skipped" ? partner.status : "skipped",
            detail: voiceQa.voiceQa.message,
          }
        : partner,
    );
    const warnings = Array.from(new Set([
      repoResult.warning || "",
      generation.warning || "",
      ...repo.warnings,
      pitch.mode === "fallback" ? "Agentic generation degraded; returned the deterministic fallback pitch." : "",
      audio.status !== "ready" ? audio.message : "",
      voiceQa.voiceQa.status === "error" ? voiceQa.voiceQa.message : "",
    ].filter(Boolean)));
    const fullLogs: AgentLog[] = [
      ...agentLogs,
      ...(agentLogs.some((log) => log.agent === "Demo Capture Agent")
        ? []
        : [
            {
              agent: "Demo Capture Agent" as const,
              provider: "browser" as const,
              entries: [
                {
                  step: "Prepare browser capture",
                  status: "done" as const,
                  message: pitch.capturePlan.message,
                },
              ],
            },
          ]),
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
      voiceQa.agentLog,
    ];

    return NextResponse.json({ repo, pitch, audio, voiceQa: voiceQa.voiceQa, warnings, agentLogs: fullLogs });
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

async function loadRepoWithBudget(input: PitchRequest): Promise<{ repo: RepoContext; warning?: string }> {
  try {
    const repo = await withTimeout(
      loadRepoContext(input.repoUrl),
      Number(process.env.REPO_CONTEXT_TIMEOUT_MS || DEFAULT_REPO_CONTEXT_TIMEOUT_MS),
      "Repository inspection timed out; continuing with URL-only context.",
    );
    return { repo };
  } catch (error) {
    const warning = friendlyRouteError(error, "Repository inspection failed; continuing with URL-only context.");
    return {
      warning,
      repo: {
        source: "unavailable",
        repoUrl: input.repoUrl,
        fileTree: [],
        files: [],
        warnings: [warning],
      },
    };
  }
}

async function generatePitchWithBudget(
  input: PitchRequest,
  repo: RepoContext,
): Promise<{ pitch: PitchPlan; agentLogs: AgentLog[]; warning?: string }> {
  try {
    return await generatePitchWithAgents(input, repo);
  } catch (error) {
    const warning = friendlyRouteError(error, "Agent pipeline failed; returned deterministic fallback.");
    return {
      warning,
      pitch: fallbackPitchPlan(input, repo),
      agentLogs: fallbackAgentLogs(repo),
    };
  }
}

async function generateAudioWithBudget(pitch: PitchPlan): Promise<AudioResult> {
  try {
    return await withTimeout(
      generateNarrationAudio(pitch),
      Number(process.env.PITCH_AUDIO_TOTAL_TIMEOUT_MS || DEFAULT_AUDIO_TIMEOUT_MS),
      "Narration audio timed out.",
    );
  } catch (error) {
    return {
      status: "skipped",
      provider: "gemini",
      message: friendlyRouteError(error, "Narration audio skipped."),
    };
  }
}

async function generateVoiceQaWithBudget(audio: AudioResult, pitch: PitchPlan): Promise<{
  voiceQa: VoiceQaResult;
  agentLog: AgentLog;
}> {
  try {
    return await withTimeout(
      runSpeechmaticsVoiceQa(audio, pitch),
      Number(process.env.SPEECHMATICS_QA_TOTAL_TIMEOUT_MS || process.env.SPEECHMATICS_QA_TIMEOUT_MS || DEFAULT_AUDIO_TIMEOUT_MS),
      "Speechmatics voice QA timed out.",
    );
  } catch (error) {
    const message = friendlyRouteError(error, "Speechmatics voice QA skipped.");
    return {
      voiceQa: {
        status: "error",
        provider: "speechmatics",
        message,
      },
      agentLog: {
        agent: "Voice QA Agent",
        provider: "speechmatics",
        entries: [{ step: "Run Speechmatics QA", status: "error", message }],
      },
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function friendlyRouteError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
