import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { runBrowserCapture } from "@/lib/capture-runner";
import { buildDemoDirectorPitch, buildDirectCapturePlan, buildUrlOnlyRepoContext } from "@/lib/demo-director";
import { generateNarrationAudio } from "@/lib/gemini";
import type { AgentLog, AudioResult, DemoCaptureResult, VoiceSettings } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const defaultAudioTimeoutMs = 120000;

type DemoDirectorStage = "scouting" | "planning" | "recording" | "narrating" | "rendering" | "ready";

type DemoDirectorEvent =
  | { type: "status"; stage: DemoDirectorStage; message: string }
  | { type: "complete"; response: unknown }
  | { type: "error"; message: string };

interface DemoDirectorRequest {
  appUrl?: string;
  targetDuration?: number;
  voiceName?: string;
  voiceTone?: VoiceSettings["tone"];
  voicePacing?: VoiceSettings["pacing"];
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: DemoDirectorEvent) => {
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
          // Client-side navigation can close the stream first.
        }
      };

      runDemoDirectorStream(request, send)
        .catch((error) => {
          send({ type: "error", message: error instanceof Error ? error.message : "Could not generate demo video." });
        })
        .finally(close);
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

async function runDemoDirectorStream(request: Request, send: (event: DemoDirectorEvent) => void) {
  const payload = (await request.json()) as DemoDirectorRequest;
  const input = sanitizeRequest(payload);
  const capturePlan = buildDirectCapturePlan(input.appUrl);

  send({ type: "status", stage: "scouting", message: "Opening the live app and identifying the first meaningful product surface." });
  send({ type: "status", stage: "recording", message: "Recording a safe Playwright walkthrough from the live URL." });
  const captureRun = await captureWithBudget(input.appUrl, capturePlan);
  const capture = ensureCaptureManifest(captureRun.capture);

  send({ type: "status", stage: "planning", message: "Turning recorded UI moments into a timed demo flow." });
  const pitch = buildDemoDirectorPitch({
    appUrl: input.appUrl,
    capture,
    targetDuration: input.targetDuration,
    voiceSettings: input.voiceSettings,
  });

  send({ type: "status", stage: "narrating", message: "Generating narration from the timed script and selected voice." });
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
        step: "Prepare timed renderer",
        status: "done",
        message: "Prepared the preview/export renderer with demo footage, zooms, labels, and target-duration timing.",
      },
    ],
  };

  send({ type: "status", stage: "rendering", message: "Preparing the preview renderer with auto zoom, labels, and export timing." });
  const warnings = Array.from(
    new Set(
      [
        ...(capture?.manifest?.warnings || []),
        capture?.status !== "ready" ? capture?.message : "",
        audio.status !== "ready" ? audio.message : "",
      ].filter((warning): warning is string => Boolean(warning)),
    ),
  );
  const repo = buildUrlOnlyRepoContext(input.appUrl, warnings);

  send({
    type: "complete",
    response: {
      repo,
      pitch,
      audio,
      capture,
      warnings,
      agentLogs: [
        {
          agent: "Demo Capture Agent" as const,
          provider: "browser" as const,
          entries: [
            {
              step: "Use live app URL",
              status: "done" as const,
              message: `Using ${input.appUrl} as the source of truth for the demo.`,
            },
            {
              step: "Plan browser capture",
              status: "done" as const,
              message: capturePlan.message,
            },
          ],
        },
        captureRun.agentLog,
        mediaLog,
      ],
    },
  });
}

function sanitizeRequest(payload: DemoDirectorRequest) {
  const appUrl = normalizeLiveUrl(payload.appUrl || "");
  const targetDuration = Math.max(30, Math.min(120, Number(payload.targetDuration) || 60));
  return {
    appUrl,
    targetDuration,
    voiceSettings: {
      voiceName: payload.voiceName || "Kore",
      tone: payload.voiceTone || "warm",
      pacing: payload.voicePacing || "measured",
    },
  };
}

function normalizeLiveUrl(raw: string) {
  const value = raw.trim();
  if (!value) throw new Error("Live app URL is required.");
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use http or https.");
    if (url.hostname.toLowerCase() === "github.com" || url.hostname.toLowerCase().endsWith(".github.com")) {
      throw new Error("Use a deployed app URL for this MVP flow, not a GitHub repository URL.");
    }
    url.hash = "";
    return url.toString();
  } catch (error) {
    if (error instanceof Error && error.message.includes("GitHub")) throw error;
    throw new Error("Enter a valid live app URL, for example https://app.example.com.");
  }
}

async function captureWithBudget(appUrl: string, capturePlan: ReturnType<typeof buildDirectCapturePlan>) {
  try {
    return await runBrowserCapture(appUrl, capturePlan);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Playwright capture failed.";
    const capture: DemoCaptureResult = {
      status: "error",
      provider: "public-url",
      targetUrl: appUrl,
      message,
      interactionSummary: ["Opened the live app URL, but capture could not complete."],
      logs: [{ step: "Record live URL", status: "error", message }],
    };
    const agentLog: AgentLog = {
      agent: "Browser Capture Agent",
      provider: "browser",
      entries: capture.logs,
    };
    return { capture, agentLog };
  }
}

async function generateAudioWithBudget(pitch: Parameters<typeof generateNarrationAudio>[0]): Promise<AudioResult> {
  try {
    return await withTimeout(
      generateNarrationAudio(pitch),
      Number(process.env.PITCH_AUDIO_TOTAL_TIMEOUT_MS || defaultAudioTimeoutMs),
      "Narration audio timed out.",
    );
  } catch (error) {
    return {
      status: "skipped",
      provider: "gemini",
      message: error instanceof Error && error.message ? error.message : "Narration audio skipped.",
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
