import type { AgentLogEntry, PitchPlan, VideoDbAsset, VideoDbMedia } from "@/lib/types";

const VIDEODB_BASE_URL = "https://api.videodb.io";

export async function generatePitchMediaAssets(plan: PitchPlan): Promise<VideoDbMedia> {
  const apiKey = process.env.VIDEODB_API_KEY;
  if (!apiKey) {
    return {
      status: "skipped",
      provider: "videodb",
      assets: [],
      logs: [{ step: "Check VideoDB key", status: "skipped", message: "VIDEODB_API_KEY is not configured." }],
      message: "VIDEODB_API_KEY is not configured.",
    };
  }

  const logs: AgentLogEntry[] = [
    { step: "Create media brief", status: "done", message: "Converted pitch scenes into VideoDB video, voice, and music prompts." },
  ];
  const scenePrompts = buildVideoPrompts(plan).slice(0, 3);
  const voicePrompt = `Narrate the following product pitch script in a polished, confident demo presenter voice. Keep it clear, energetic, and natural.\n\n${plan.narration}`;
  const musicPrompt = `Generate modern, premium, optimistic background music for a ${plan.productName} product pitch video. Subtle, cinematic, startup launch energy, no vocals.`;

  const jobs = await Promise.allSettled([
    ...scenePrompts.map((prompt) => createVideoJob(apiKey, prompt)),
    createVoiceJob(apiKey, voicePrompt),
    createMusicJob(apiKey, musicPrompt),
  ]);

  const queuedAssets = jobs.map((job, index): VideoDbAsset => {
    if (job.status === "fulfilled") return job.value;
    const isVideo = index < scenePrompts.length;
    const isVoice = index === scenePrompts.length;
    return {
      kind: isVideo ? "video" : isVoice ? "voice" : "music",
      prompt: isVideo ? scenePrompts[index] : isVoice ? voicePrompt : musicPrompt,
      status: "error",
      message: job.reason instanceof Error ? job.reason.message : "VideoDB generation failed.",
    };
  });

  const assets = await Promise.all(queuedAssets.map((asset) => resolveAsyncAsset(apiKey, asset)));
  const errors = assets.filter((asset) => asset.status === "error").length;
  logs.push({
    step: "Generate VideoDB assets",
    status: errors === assets.length ? "error" : "done",
    message: `Started ${countKind(assets, "video")} video job(s), ${countKind(assets, "voice")} voice job(s), and ${countKind(assets, "music")} music job(s).`,
  });
  logs.push({
    step: "Resolve generated assets",
    status: assets.some((asset) => asset.id?.startsWith("m-") || asset.id?.startsWith("a-")) ? "done" : "running",
    message: `Resolved ${assets.filter((asset) => asset.id?.startsWith("m-") || asset.id?.startsWith("a-")).length} generated asset(s) from VideoDB async jobs.`,
  });

  const streamUrl = await composeTimeline(apiKey, assets, logs);

  return {
    status: errors === assets.length ? "error" : "ready",
    provider: "videodb",
    assets,
    streamUrl,
    logs,
    message:
      streamUrl
        ? "VideoDB generated clips, voice, and music, then compiled them into a timeline stream."
        : errors === assets.length
        ? "VideoDB media generation did not start."
        : "VideoDB started generated video, voice, and music jobs from the repo pitch plan.",
  };
}

export async function finalizeVideoDbMedia(queuedAssets: VideoDbAsset[]): Promise<VideoDbMedia> {
  const apiKey = process.env.VIDEODB_API_KEY;
  if (!apiKey) {
    return {
      status: "skipped",
      provider: "videodb",
      assets: queuedAssets,
      logs: [{ step: "Check VideoDB key", status: "skipped", message: "VIDEODB_API_KEY is not configured." }],
      message: "VIDEODB_API_KEY is not configured.",
    };
  }

  const logs: AgentLogEntry[] = [
    { step: "Resolve generated assets", status: "running", message: "Polling existing VideoDB async jobs." },
  ];
  const assets = await Promise.all(queuedAssets.map((asset) => resolveAsyncAsset(apiKey, asset)));
  logs[0] = {
    step: "Resolve generated assets",
    status: assets.some((asset) => asset.id?.startsWith("m-") || asset.id?.startsWith("a-")) ? "done" : "running",
    message: `Resolved ${assets.filter((asset) => asset.id?.startsWith("m-") || asset.id?.startsWith("a-")).length} generated asset(s) from VideoDB async jobs.`,
  };

  const streamUrl = await composeTimeline(apiKey, assets, logs);
  return {
    status: streamUrl ? "ready" : "skipped",
    provider: "videodb",
    assets,
    streamUrl,
    logs,
    message: streamUrl
      ? "VideoDB compiled the generated clips, voice, and music into a final timeline stream."
      : "VideoDB assets are still processing; finalize again in a moment.",
  };
}

function buildVideoPrompts(plan: PitchPlan) {
  return plan.scenes.map((scene) => {
    if (scene.visual === "talkingHead") {
      return `A polished product founder speaking directly to camera in a modern studio, explaining: ${scene.onScreenText}. Premium tech pitch video, realistic but not a specific real person, 16:9, clean lighting, subtle motion.`;
    }

    return `Premium product demo explainer b-roll for ${plan.productName}: ${scene.onScreenText}. Visual metaphor for ${scene.beat}. Clean SaaS launch style, cinematic motion, readable abstract UI, 16:9.`;
  });
}

async function createVideoJob(apiKey: string, prompt: string): Promise<VideoDbAsset> {
  const response = await videoDbFetch(apiKey, "/collection/default/generate/video/", {
    prompt,
    duration: 5,
  });

  return {
    kind: "video",
    prompt,
    status: response.status ?? "processing",
    id: response.data?.id,
    outputUrl: response.data?.output_url,
  };
}

async function createMusicJob(apiKey: string, prompt: string): Promise<VideoDbAsset> {
  const response = await videoDbFetch(apiKey, "/collection/default/generate/audio/", {
    prompt,
    audio_type: "music",
  });

  return {
    kind: "music",
    prompt,
    status: response.status ?? "processing",
    id: response.data?.id,
    outputUrl: response.data?.output_url,
  };
}

async function createVoiceJob(apiKey: string, prompt: string): Promise<VideoDbAsset> {
  const response = await videoDbFetch(apiKey, "/collection/default/generate/audio/", {
    prompt,
    audio_type: "speech",
  });

  return {
    kind: "voice",
    prompt,
    status: response.status ?? "processing",
    id: response.data?.id,
    outputUrl: response.data?.output_url,
  };
}

async function resolveAsyncAsset(apiKey: string, asset: VideoDbAsset): Promise<VideoDbAsset> {
  if (!asset.outputUrl || asset.status === "error") return asset;

  const attempts = Number(process.env.VIDEODB_POLL_ATTEMPTS || 8);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delay(4000);

    const response = await fetch(asset.outputUrl, {
      headers: { "x-access-token": apiKey },
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as VideoDbAsyncResponse;
    const status = payload.status;
    const data = payload.response?.data;

    if (status === "complete" && data?.id) {
      return {
        ...asset,
        status: "done",
        id: data.id,
        streamUrl: data.stream_url,
        playerUrl: data.player_url,
      };
    }

    if (status === "failed") {
      return {
        ...asset,
        status: "failed",
        message: "VideoDB async generation failed.",
      };
    }
  }

  return asset;
}

async function composeTimeline(apiKey: string, assets: VideoDbAsset[], logs: AgentLogEntry[]) {
  const videoAssets = assets.filter((asset) => asset.kind === "video" && asset.id?.startsWith("m-"));
  const voiceAsset = assets.find((asset) => asset.kind === "voice" && asset.id?.startsWith("a-"));
  const musicAsset = assets.find((asset) => asset.kind === "music" && asset.id?.startsWith("a-"));

  if (!videoAssets.length) {
    logs.push({ step: "Compile VideoDB timeline", status: "skipped", message: "No generated VideoDB video IDs were available yet." });
    return undefined;
  }

  try {
    const { connect, Timeline, VideoAsset, AudioAsset } = (await import("videodb")) as Record<string, any>;
    const conn = connect({ apiKey });
    const timeline = Timeline(conn);

    for (const asset of videoAssets) {
      timeline.addInline(new VideoAsset(asset.id, { start: 0, end: 5, volume: 1 }));
    }

    if (voiceAsset?.id) {
      timeline.addOverlay(0, new AudioAsset(voiceAsset.id, { start: 0, end: videoAssets.length * 5, volume: 1 }));
    }

    if (musicAsset?.id) {
      timeline.addOverlay(0, new AudioAsset(musicAsset.id, { start: 0, end: videoAssets.length * 5, volume: 0.22 }));
    }

    const streamUrl = await timeline.generateStream();
    logs.push({
      step: "Compile VideoDB timeline",
      status: "done",
      message:
        voiceAsset?.id && musicAsset?.id
          ? "Arranged generated clips sequentially, overlaid VideoDB voice narration, and mixed generated music at low volume."
          : voiceAsset?.id
            ? "Arranged generated clips sequentially and overlaid VideoDB voice narration; music was not available."
            : "Arranged generated clips sequentially; VideoDB voice is still processing.",
    });
    return typeof streamUrl === "string" ? streamUrl : undefined;
  } catch (error) {
    logs.push({
      step: "Compile VideoDB timeline",
      status: "error",
      message: error instanceof Error ? error.message : "Timeline compilation failed.",
    });
    return undefined;
  }
}

async function videoDbFetch(apiKey: string, path: string, body: Record<string, unknown>): Promise<VideoDbResponse> {
  const response = await fetch(`${VIDEODB_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-access-token": apiKey,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as VideoDbResponse;
  if (!response.ok) {
    throw new Error(payload.message || `${response.status} ${response.statusText}`);
  }
  return payload;
}

interface VideoDbResponse {
  success?: boolean;
  status?: "processing" | "done" | "failed";
  message?: string;
  data?: {
    id?: string;
    output_url?: string;
  };
}

interface VideoDbAsyncResponse {
  status?: "processing" | "complete" | "failed";
  response?: {
    data?: {
      id?: string;
      stream_url?: string;
      player_url?: string;
    };
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countKind(assets: VideoDbAsset[], kind: VideoDbAsset["kind"]) {
  return assets.filter((asset) => asset.kind === kind && asset.outputUrl).length;
}
