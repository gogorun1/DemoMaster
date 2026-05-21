import { NextResponse } from "next/server";
import { generateNarrationAudio } from "@/lib/gemini";
import { runSpeechmaticsVoiceQa } from "@/lib/speechmatics";
import type { AgentLog, AudioResult, PitchPlan, VoiceQaResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_AUDIO_TIMEOUT_MS = 120000;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { pitch?: PitchPlan };
    if (!payload.pitch) throw new Error("Pitch is required.");

    const audio = await generateAudioWithBudget(payload.pitch);
    const voiceQa = await generateVoiceQaWithBudget(audio, payload.pitch);
    const pitch = {
      ...payload.pitch,
      partnerStack: payload.pitch.partnerStack.map((partner) =>
        partner.name === "Speechmatics"
          ? {
              ...partner,
              status: voiceQa.voiceQa.status === "ready" ? "ready" : voiceQa.voiceQa.status === "skipped" ? partner.status : "skipped",
              detail: voiceQa.voiceQa.message,
            }
          : partner,
      ),
    };

    const mediaLog: AgentLog = {
      agent: "Media Renderer Agent",
      provider: "browser",
      entries: [
        {
          step: "Regenerate narration",
          status: audio.status === "ready" ? "done" : audio.status,
          message: audio.message,
        },
        {
          step: "Prepare browser renderer",
          status: "done",
          message: "Updated the editable project script with fresh narration audio.",
        },
      ],
    };

    return NextResponse.json({
      pitch,
      audio,
      voiceQa: voiceQa.voiceQa,
      agentLogs: [mediaLog, voiceQa.agentLog],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not regenerate narration." },
      { status: 400 },
    );
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
      message: error instanceof Error && error.message ? error.message : "Narration audio skipped.",
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
    const message = error instanceof Error && error.message ? error.message : "Speechmatics voice QA skipped.";
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
