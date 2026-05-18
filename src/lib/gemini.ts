import { GoogleGenAI } from "@google/genai";
import { fallbackPitchPlan } from "@/lib/fallback";
import type { AudioResult, PitchPlan, PitchRequest, RepoContext } from "@/lib/types";

let geminiClient: GoogleGenAI | null = null;

export async function generatePitchPlan(
  request: PitchRequest,
  repo: RepoContext,
): Promise<PitchPlan> {
  const client = getGeminiClient();
  if (!client) return fallbackPitchPlan(request, repo);

  try {
    const prompt = buildPitchPrompt(request, repo);
    const response = await generateStructuredJson(client, prompt);
    const parsed = parseGeminiJson(response.text ?? "{}") as Partial<PitchPlan>;
    return normalizePitchPlan(parsed, request, repo);
  } catch (error) {
    console.warn("Gemini pitch generation failed:", error instanceof Error ? error.message : error);
    return fallbackPitchPlan(request, repo);
  }
}

function parseGeminiJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const unfenced = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(unfenced);
    } catch {
      const start = unfenced.indexOf("{");
      const end = unfenced.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(unfenced.slice(start, end + 1));
      }
      throw new Error("Gemini returned text that was not parseable JSON.");
    }
  }
}

async function generateStructuredJson(client: GoogleGenAI, prompt: string) {
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-3-flash-preview";

  try {
    return await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseFormat: {
          text: {
            mimeType: "application/json",
            schema: pitchSchema,
          },
        },
      } as unknown as Record<string, unknown>,
    });
  } catch {
    return client.models.generateContent({
      model,
      contents: `${prompt}\n\nReturn strict JSON only. Do not wrap it in Markdown.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: pitchSchema,
      } as unknown as Record<string, unknown>,
    });
  }
}

export async function generateVoiceover(plan: PitchPlan, includeVoice: boolean): Promise<AudioResult> {
  if (!includeVoice) {
    return {
      status: "skipped",
      provider: "gemini",
      message: "Voiceover generation was disabled.",
    };
  }

  const client = getGeminiClient();
  if (!client) {
    return {
      status: "skipped",
      provider: "gemini",
      message: "GEMINI_API_KEY is not configured.",
    };
  }

  try {
    const voice = process.env.GEMINI_TTS_VOICE || "Kore";
    const response = await client.models.generateContent({
      model: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
      contents: [
        {
          parts: [
            {
              text: `Read as a polished product demo narrator: confident, warm, concise, and energetic without sounding like an ad.\n\n${plan.narration}`,
            },
          ],
        },
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64) throw new Error("Gemini returned no audio data.");

    const wav = pcmToWav(Buffer.from(base64, "base64"));
    return {
      status: "ready",
      provider: "gemini",
      dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
      mimeType: "audio/wav",
      voice,
      message: "Gemini TTS generated the voiceover.",
    };
  } catch (error) {
    return {
      status: "error",
      provider: "gemini",
      message: error instanceof Error ? error.message : "Gemini TTS failed.",
    };
  }
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

function buildPitchPrompt(request: PitchRequest, repo: RepoContext) {
  const files = repo.files
    .map((file) => `### ${file.path}\n${file.content}`)
    .join("\n\n")
    .slice(0, 90000);

  return `
You are DemoMaster, a world-class product demo director and technical product marketer.

Create the strongest possible narrated product pitch video plan for this demo repository.

Follow these quality rules:
- Open with a clear pain or transformation, not setup.
- Reach an "aha" moment within 15 seconds.
- Use one claim per scene and short on-screen text.
- Make the story concrete, demo-led, and credible for ${request.audience}.
- Use a premium product-launch rhythm: cold open, promise, workflow, proof, close.
- Avoid generic AI hype. Tie claims to repo evidence from filenames, README content, API routes, UI components, and implementation details.
- Include at least one scene that feels like a person speaking directly to camera; set its visual to "talkingHead".
- Keep total duration between 50 and 80 seconds.

User inputs:
Product hint: ${request.productHint || "none"}
Audience: ${request.audience}
Style: ${request.style}
Repo URL: ${request.repoUrl}

Repository metadata:
Name: ${repo.repo || "unknown"}
Description: ${repo.description || "unknown"}
Homepage: ${repo.homepage || "none"}
Primary language: ${repo.language || "unknown"}
File tree sample:
${repo.fileTree.slice(0, 180).join("\n")}

Selected file contents:
${files || "No files were available."}

Return only JSON matching the schema.
`;
}

function normalizePitchPlan(
  parsed: Partial<PitchPlan>,
  request: PitchRequest,
  repo: RepoContext,
): PitchPlan {
  const fallback = fallbackPitchPlan(request, repo);
  const parsedRecord = parsed as Record<string, unknown>;
  const rawScenes = Array.isArray(parsed.scenes) && parsed.scenes.length ? parsed.scenes : fallback.scenes;
  let cursor = 0;
  const scenes = rawScenes.slice(0, 7).map((scene, index) => {
    const sceneRecord = scene as unknown as Record<string, unknown>;
    const duration = clamp(
      pickNumber(sceneRecord, ["duration"]) || fallback.scenes[index]?.duration || 10,
      7,
      18,
    );
    const normalized = {
      id: pickString(sceneRecord, ["id"]) || `scene-${index + 1}`,
      title: pickString(sceneRecord, ["title"]) || fallback.scenes[index]?.title || `Scene ${index + 1}`,
      beat: pickString(sceneRecord, ["beat"]) || fallback.scenes[index]?.beat || "",
      narration: pickString(sceneRecord, ["narration"]) || fallback.scenes[index]?.narration || "",
      onScreenText:
        pickString(sceneRecord, ["onScreenText", "on_screen_text", "onscreen_text"]) ||
        fallback.scenes[index]?.onScreenText ||
        "",
      visual:
        pickVisual(sceneRecord, ["visual"]) ||
        fallback.scenes[index]?.visual ||
        "workflow",
      duration,
      start: cursor,
    };
    cursor += duration;
    return normalized;
  });

  const narration = scenes.map((scene) => scene.narration).join(" ");
  const generatedSceneSignal = scenes.some((scene, index) => scene.narration !== fallback.scenes[index]?.narration);
  const derivedInsights = scenes
    .map((scene) => scene.beat)
    .filter(Boolean)
    .slice(0, 5);
  const derivedStrategy = scenes
    .map((scene) => scene.title)
    .filter(Boolean)
    .join(" -> ");

  return {
    productName: pickString(parsedRecord, ["productName", "product_name"]) || fallback.productName,
    tagline: pickString(parsedRecord, ["tagline"]) || scenes[0]?.onScreenText || fallback.tagline,
    audience: pickString(parsedRecord, ["audience"]) || request.audience || fallback.audience,
    corePromise:
      pickString(parsedRecord, ["corePromise", "core_promise"]) ||
      scenes[1]?.onScreenText ||
      scenes[1]?.beat ||
      fallback.corePromise,
    positioning:
      pickString(parsedRecord, ["positioning"]) ||
      `A ${request.style} pitch for ${request.audience}, anchored in ${scenes[1]?.title || "the product promise"}.`,
    strategy:
      pickString(parsedRecord, ["strategy"]) ||
      (derivedStrategy ? `Structure the story as: ${derivedStrategy}.` : fallback.strategy),
    score: clamp(pickNumber(parsedRecord, ["score"]) || (generatedSceneSignal ? 88 : fallback.score), 0, 100),
    cta: pickString(parsedRecord, ["cta"]) || fallback.cta,
    insights: pickStringArray(parsedRecord, ["insights"]).length
      ? pickStringArray(parsedRecord, ["insights"]).slice(0, 6)
      : derivedInsights.length
        ? derivedInsights
        : fallback.insights,
    scenes,
    narration,
    generatedAt: new Date().toISOString(),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function pickStringArray(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    }
  }
  return [];
}

function pickVisual(record: Record<string, unknown>, keys: string[]) {
  const visual = pickString(record, keys);
  if (visual === "talking_head" || visual === "talking-head") return "talkingHead";
  if (["talkingHead", "problem", "solution", "workflow", "proof", "cta"].includes(visual)) {
    return visual as PitchPlan["scenes"][number]["visual"];
  }
  return "";
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

const pitchSchema = {
  type: "object",
  properties: {
    productName: { type: "string" },
    tagline: { type: "string" },
    audience: { type: "string" },
    corePromise: { type: "string" },
    positioning: { type: "string" },
    strategy: { type: "string" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    cta: { type: "string" },
    insights: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    scenes: {
      type: "array",
      minItems: 5,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          beat: { type: "string" },
          narration: { type: "string" },
          onScreenText: { type: "string" },
          visual: { type: "string", enum: ["talkingHead", "problem", "solution", "workflow", "proof", "cta"] },
          duration: { type: "integer", minimum: 7, maximum: 18 },
          start: { type: "integer" },
        },
        required: ["id", "title", "beat", "narration", "onScreenText", "visual", "duration"],
      },
    },
  },
  required: [
    "productName",
    "tagline",
    "audience",
    "corePromise",
    "positioning",
    "strategy",
    "score",
    "cta",
    "insights",
    "scenes",
  ],
};
