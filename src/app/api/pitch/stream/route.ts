import { fallbackAgentLogs, fallbackPitchPlan } from "@/lib/fallback";
import { generateNarrationAudio, generatePitchWithAgents } from "@/lib/gemini";
import { loadRepoContext } from "@/lib/repo-context";
import { runSpeechmaticsVoiceQa } from "@/lib/speechmatics";
import type { AgentLog, AudioResult, PitchPlan, PitchRequest, RepoContext, VoiceQaResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_REPO_CONTEXT_TIMEOUT_MS = 15000;
const DEFAULT_AUDIO_TIMEOUT_MS = 45000;

type PitchStreamEvent =
  | { type: "status"; message: string }
  | { type: "agentLog"; log: AgentLog }
  | { type: "complete"; response: unknown }
  | { type: "error"; message: string };

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: PitchStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may have navigated away after receiving the final chunk.
        }
      };

      runPitchStream(request, send)
        .catch((error) => {
          send({ type: "error", message: error instanceof Error ? error.message : "Could not generate pitch video." });
        })
        .finally(close);
    },
    cancel() {
      // Client-side reloads or tab navigation are expected during local demos.
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

async function runPitchStream(request: Request, send: (event: PitchStreamEvent) => void) {
  const payload = (await request.json()) as Partial<PitchRequest>;
  const input = sanitizeRequest(payload);

  send({ type: "status", message: "Reading repository metadata and high-signal files." });
  const repoResult = await loadRepoWithBudget(input);
  const repo = repoResult.repo;

  send({ type: "status", message: "Running Gemini and Featherless agents on the repository evidence." });
  const generation = await generatePitchWithBudget(input, repo, (log) => send({ type: "agentLog", log }));
  const { pitch, agentLogs } = generation;

  send({ type: "status", message: "Generating narration audio with Gemini." });
  const audio = await generateAudioWithBudget(pitch);

  const mediaLog: AgentLog = {
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
  };
  send({ type: "agentLog", log: mediaLog });

  send({ type: "status", message: "Verifying generated narration against the script with Speechmatics." });
  const voiceQa = await generateVoiceQaWithBudget(audio, pitch);
  send({ type: "agentLog", log: voiceQa.agentLog });

  pitch.partnerStack = pitch.partnerStack.map((partner) =>
    partner.name === "Speechmatics"
      ? {
          ...partner,
          status: voiceQa.voiceQa.status === "ready" ? "ready" : voiceQa.voiceQa.status === "skipped" ? partner.status : "skipped",
          detail: voiceQa.voiceQa.message,
        }
      : partner,
  );

  const warnings = Array.from(
    new Set(
      [
        repoResult.warning || "",
        generation.warning || "",
        ...repo.warnings,
        pitch.mode === "fallback" ? "Agentic generation degraded; returned the deterministic fallback pitch." : "",
        audio.status !== "ready" ? audio.message : "",
        voiceQa.voiceQa.status === "error" ? voiceQa.voiceQa.message : "",
      ].filter(Boolean),
    ),
  );

  const fullLogs = mergeAgentLogs([
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
    mediaLog,
    voiceQa.agentLog,
  ]);

  send({ type: "complete", response: { repo, pitch, audio, voiceQa: voiceQa.voiceQa, warnings, agentLogs: fullLogs } });
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
  onAgentLog: (log: AgentLog) => void,
): Promise<{ pitch: PitchPlan; agentLogs: AgentLog[]; warning?: string }> {
  try {
    return await generatePitchWithAgents(input, repo, onAgentLog);
  } catch (error) {
    const warning = friendlyRouteError(error, "Agent pipeline failed; returned deterministic fallback.");
    const pitch = fallbackPitchPlan(input, repo);
    const agentLogs = fallbackAgentLogs(repo);
    for (const log of agentLogs) onAgentLog(log);
    return { warning, pitch, agentLogs };
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

function mergeAgentLogs(logs: AgentLog[]) {
  return logs.reduce<AgentLog[]>((merged, log) => {
    const index = merged.findIndex((item) => item.agent === log.agent);
    if (index === -1) return [...merged, log];
    return merged.map((item, itemIndex) => (itemIndex === index ? log : item));
  }, []);
}

function friendlyRouteError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
