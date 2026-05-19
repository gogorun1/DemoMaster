import type { AgentLog, AudioResult, PitchPlan, VoiceQaResult } from "@/lib/types";

const SPEECHMATICS_API_BASE = "https://asr.api.speechmatics.com/v2";
const DEFAULT_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 2500;

interface CreateJobResponse {
  id?: string;
  job?: { id?: string };
}

interface JobDetailsResponse {
  status?: string;
  job?: {
    status?: string;
    errors?: Array<{ message?: string }>;
  };
}

export async function runSpeechmaticsVoiceQa(audio: AudioResult, pitch: PitchPlan): Promise<{
  voiceQa: VoiceQaResult;
  agentLog: AgentLog;
}> {
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) return skipped("Set SPEECHMATICS_API_KEY to enable narration voice QA.");
  if (audio.status !== "ready" || !audio.dataUrl) return skipped("Narration audio was not ready, so Speechmatics QA was skipped.");

  try {
    const audioBlob = dataUrlToBlob(audio.dataUrl, audio.mimeType || "audio/wav");
    const jobId = await createTranscriptionJob(apiKey, audioBlob);
    const transcript = await waitForTranscript(apiKey, jobId);
    const similarity = transcriptSimilarity(pitch.narration, transcript);
    const wordCount = tokenize(transcript).length;
    const passed = similarity >= 0.72;
    const voiceQa: VoiceQaResult = {
      status: passed ? "ready" : "error",
      provider: "speechmatics",
      transcript,
      similarity,
      wordCount,
      jobId,
      message: passed
        ? `Speechmatics verified the generated narration against the script (${Math.round(similarity * 100)}% lexical match).`
        : `Speechmatics detected narration/script drift (${Math.round(similarity * 100)}% lexical match).`,
    };

    return {
      voiceQa,
      agentLog: {
        agent: "Voice QA Agent",
        provider: "speechmatics",
        entries: [
          {
            step: "Transcribe narration",
            status: "done",
            message: `Speechmatics job ${jobId} returned ${wordCount} word(s).`,
          },
          {
            step: "Compare transcript",
            status: passed ? "done" : "error",
            message: voiceQa.message,
          },
        ],
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Speechmatics voice QA failed.";
    const voiceQa: VoiceQaResult = {
      status: "error",
      provider: "speechmatics",
      message,
    };
    return {
      voiceQa,
      agentLog: {
        agent: "Voice QA Agent",
        provider: "speechmatics",
        entries: [
          {
            step: "Run Speechmatics QA",
            status: "error",
            message,
          },
        ],
      },
    };
  }
}

function skipped(message: string): { voiceQa: VoiceQaResult; agentLog: AgentLog } {
  const voiceQa: VoiceQaResult = {
    status: "skipped",
    provider: "speechmatics",
    message,
  };
  return {
    voiceQa,
    agentLog: {
      agent: "Voice QA Agent",
      provider: "speechmatics",
      entries: [{ step: "Check Speechmatics", status: "skipped", message }],
    },
  };
}

async function createTranscriptionJob(apiKey: string, audioBlob: Blob) {
  const form = new FormData();
  form.append(
    "config",
    JSON.stringify({
      type: "transcription",
      transcription_config: {
        language: process.env.SPEECHMATICS_LANGUAGE || "en",
        operating_point: process.env.SPEECHMATICS_OPERATING_POINT || "enhanced",
      },
    }),
  );
  form.append("data_file", audioBlob, "demomaster-narration.wav");

  const response = await fetch(`${SPEECHMATICS_API_BASE}/jobs/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as CreateJobResponse & { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `Speechmatics job creation failed: ${response.status}`);
  const jobId = payload.id || payload.job?.id;
  if (!jobId) throw new Error("Speechmatics did not return a job id.");
  return jobId;
}

async function waitForTranscript(apiKey: string, jobId: string) {
  const timeoutMs = Number(process.env.SPEECHMATICS_QA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const details = await speechmaticsFetch<JobDetailsResponse>(apiKey, `/jobs/${encodeURIComponent(jobId)}`);
    const status = details.job?.status || details.status || "unknown";
    if (status === "done") {
      return speechmaticsFetchText(apiKey, `/jobs/${encodeURIComponent(jobId)}/transcript?format=txt`);
    }
    if (["rejected", "error", "failed"].includes(status)) {
      const message = details.job?.errors?.map((error) => error.message).filter(Boolean).join(" ") || status;
      throw new Error(`Speechmatics job failed: ${message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Speechmatics voice QA timed out.");
}

async function speechmaticsFetch<T>(apiKey: string, path: string): Promise<T> {
  const response = await fetch(`${SPEECHMATICS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as T & { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `Speechmatics request failed: ${response.status}`);
  return payload;
}

async function speechmaticsFetchText(apiKey: string, path: string) {
  const response = await fetch(`${SPEECHMATICS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Speechmatics transcript request failed: ${response.status}`);
  return text.trim();
}

function dataUrlToBlob(dataUrl: string, fallbackType: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw new Error("Narration audio data URL is invalid.");
  const mimeType = match[1] || fallbackType;
  const payload = match[3] || "";
  const buffer = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return new Blob([buffer], { type: mimeType });
}

function transcriptSimilarity(script: string, transcript: string) {
  const scriptTokens = tokenize(script);
  const transcriptTokens = tokenize(transcript);
  if (!scriptTokens.length || !transcriptTokens.length) return 0;
  const lcs = longestCommonSubsequence(scriptTokens, transcriptTokens);
  return lcs / scriptTokens.length;
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function longestCommonSubsequence(a: string[], b: string[]) {
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }
  return previous[b.length];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
