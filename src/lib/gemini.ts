import { GoogleGenAI } from "@google/genai";
import { buildPartnerStack, fallbackAgentLogs, fallbackPitchPlan } from "@/lib/fallback";
import type {
  AgentLog,
  AgentLogEntry,
  AudioResult,
  PitchPlan,
  PitchRequest,
  PitchScene,
  ProductFunction,
  ProductReport,
  RepoContext,
  VisualMode,
} from "@/lib/types";

let geminiClient: GoogleGenAI | null = null;

interface ProductAnalysis {
  productName: string;
  primaryUser: string;
  userNeed: string;
  productShape: string;
  evidence: string[];
  risks: string[];
}

interface PitchStrategy {
  corePromise: string;
  positioning: string;
  strategy: string;
  insightStack: string[];
  experienceFlow: string[];
  coreFunctions: ProductFunction[];
  supportingFunctions: ProductFunction[];
}

interface PitchDraft {
  productName: string;
  tagline: string;
  primaryUser: string;
  corePromise: string;
  positioning: string;
  strategy: string;
  score: number;
  cta: string;
  insights: string[];
  scenes: PitchScene[];
  productReport: ProductReport;
}

interface QualityReview {
  score: number;
  verdict: string;
  issues: string[];
  fixes: string[];
}

interface AgentRunResult {
  pitch: PitchPlan;
  agentLogs: AgentLog[];
}

const VISUALS: VisualMode[] = ["presenter", "problem", "product", "workflow", "evidence", "close"];
const DEFAULT_AGENT_TIMEOUT_MS = 25000;
const DEFAULT_TTS_TIMEOUT_MS = 45000;

export async function generatePitchWithAgents(request: PitchRequest, repo: RepoContext): Promise<AgentRunResult> {
  const client = getGeminiClient();
  if (!client) {
    return {
      pitch: fallbackPitchPlan(request, repo),
      agentLogs: fallbackAgentLogs(repo),
    };
  }

  const model = process.env.GEMINI_REASONING_MODEL || "gemini-3-flash-preview";
  const logs: AgentLog[] = [];

  try {
    const analysis = await runRepoForensics(client, model, request, repo);
    logs.push({
      agent: "Repo Forensics Agent",
      provider: "gemini",
      model,
      entries: [
        repoLog(repo),
        {
          step: "Extract product evidence",
          status: "done",
          message: `${analysis.productName}: ${analysis.evidence.slice(0, 3).join(" ")}`,
        },
      ],
    });

    const strategy = await runPitchStrategy(client, model, request, repo, analysis);
    logs.push({
      agent: "Pitch Strategy Agent",
      provider: "gemini",
      model,
      entries: [
        {
          step: "Define user need",
          status: "done",
          message: strategy.corePromise,
        },
        {
          step: "Choose experience flow",
          status: "done",
          message: strategy.experienceFlow.slice(0, 4).join(" -> "),
        },
      ],
    });

    const draft = await runCreativeDirector(client, model, request, repo, analysis, strategy);
    logs.push({
      agent: "Creative Director Agent",
      provider: "gemini",
      model,
      entries: [
        {
          step: "Write storyboard",
          status: "done",
          message: `Created ${draft.scenes.length} scenes with short captions, presenter moments, and an exportable narration script.`,
        },
        {
          step: "Write product report",
          status: "done",
          message: draft.productReport.whyThisFlowWorks,
        },
      ],
    });

    const judge = await runQualityJudge(client, model, draft, analysis, strategy).catch((error) =>
      localQualityJudge(error, model, draft),
    );
    logs.push(judge.log);

    const pitch = normalizePitchPlan(draft, request, repo, analysis, judge.review);
    return { pitch, agentLogs: logs };
  } catch (error) {
    const pitch = fallbackPitchPlan(request, repo);
    const message = friendlyProviderError(error, "Agent pipeline failed; used fallback plan.");
    pitch.partnerStack = pitch.partnerStack.map((partner) =>
      partner.name === "Google Gemini" ? { ...partner, status: "skipped", detail: message } : partner,
    );
    const baseLogs = logs.length ? logs : fallbackAgentLogs(repo).filter((log) => log.agent !== "Quality Judge Agent");
    return {
      pitch,
      agentLogs: [
        ...baseLogs,
        {
          agent: "Quality Judge Agent",
          provider: "gemini",
          model,
          entries: [
            {
              step: "Recover from agent failure",
              status: "error",
              message,
            },
          ],
        },
      ],
    };
  }
}

export async function generateNarrationAudio(plan: PitchPlan): Promise<AudioResult> {
  const client = getGeminiClient();
  if (!client) {
    return {
      status: "skipped",
      provider: "gemini",
      message: "GEMINI_API_KEY is not configured for narration.",
    };
  }

  try {
    const voice = process.env.GEMINI_TTS_VOICE || "Kore";
    const response = await withTimeout(
      client.models.generateContent({
        model: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
        contents: [
          {
            parts: [
              {
                text: [
                  "Read this as a premium product pitch narrator.",
                  "Tone: clear, warm, decisive, demo-stage confidence.",
                  "Pacing: measured, energetic, no salesy exaggeration.",
                  "Keep the exact words of the script.",
                  "",
                  plan.narration,
                ].join("\n"),
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
      }),
      Number(process.env.GEMINI_TTS_TIMEOUT_MS || DEFAULT_TTS_TIMEOUT_MS),
      "Gemini narration timed out.",
    );

    const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64) throw new Error("Gemini returned no audio data.");

    const wav = pcmToWav(Buffer.from(base64, "base64"));
    return {
      status: "ready",
      provider: "gemini",
      dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
      mimeType: "audio/wav",
      voice,
      message: "Generated Gemini narration for the final pitch video.",
    };
  } catch (error) {
    return {
      status: "error",
      provider: "gemini",
      message: friendlyProviderError(error, "Gemini narration failed."),
    };
  }
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

async function runRepoForensics(
  client: GoogleGenAI,
  model: string,
  request: PitchRequest,
  repo: RepoContext,
) {
  return generateJson<ProductAnalysis>(
    client,
    model,
    buildAgentPrompt(
      "Repo Forensics Agent",
      request,
      repo,
      [
        "Infer what the product really is from repository evidence.",
        "Prioritize README, package metadata, app routes, API routes, components, and implementation names.",
        "Return evidence-backed claims only. Do not invent integrations.",
        "Do not expose hidden chain-of-thought; return concise conclusions and evidence.",
      ],
    ),
    productAnalysisSchema,
  );
}

async function runPitchStrategy(
  client: GoogleGenAI,
  model: string,
  request: PitchRequest,
  repo: RepoContext,
  analysis: ProductAnalysis,
) {
  return generateJson<PitchStrategy>(
    client,
    model,
    `${buildAgentPrompt(
      "Pitch Strategy Agent",
      request,
      repo,
      [
        "Act as a senior product and experience designer.",
        "Define the user flow before writing the video.",
        "The product must remain repo-only: one input, then autonomous agent work, then narrated video output.",
        "Justify core and supporting functions based on user need and hackathon judging criteria.",
        "Keep it concrete, calm, and enterprise-demo credible.",
      ],
    )}\n\nRepo Forensics output:\n${JSON.stringify(analysis, null, 2)}`,
    pitchStrategySchema,
  );
}

async function runCreativeDirector(
  client: GoogleGenAI,
  model: string,
  request: PitchRequest,
  repo: RepoContext,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
) {
  return generateJson<PitchDraft>(
    client,
    model,
    `${buildAgentPrompt(
      "Creative Director Agent",
      request,
      repo,
      [
        "Write the final narrated pitch video plan.",
        "The video should feel like a strong internet product pitch, but without hype or fake claims.",
        "Open with an aha moment within 15 seconds.",
        "Use short on-screen text and one main claim per scene.",
        "Include a presenter-style scene that can look like a person speaking to camera.",
        "Keep total duration between 45 and 70 seconds.",
        "Also produce a product/UX report explaining why this product and flow make sense.",
      ],
    )}\n\nAnalysis:\n${JSON.stringify(analysis, null, 2)}\n\nStrategy:\n${JSON.stringify(strategy, null, 2)}`,
    pitchDraftSchema,
  );
}

async function runQualityJudge(
  client: GoogleGenAI,
  model: string,
  draft: PitchDraft,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): Promise<{ review: QualityReview; log: AgentLog }> {
  const featherless = await runFeatherlessJudge(draft, analysis, strategy);
  if (featherless.review) {
    return {
      review: featherless.review,
      log: {
        agent: "Quality Judge Agent",
        provider: "featherless",
        model: featherless.model,
        entries: [
          {
            step: "Run second-opinion critic",
            status: "done",
            message: featherless.review.verdict,
          },
          {
            step: "Apply quality bar",
            status: "done",
            message: `Score ${featherless.review.score}. Fixes: ${featherless.review.fixes.slice(0, 3).join(" ")}`,
          },
        ],
      },
    };
  }

  const review = await generateJson<QualityReview>(
    client,
    model,
    [
      "You are the Quality Judge Agent for an AI Agent Olympics demo.",
      "Review this pitch plan as a skeptical judge and product storytelling expert.",
      "Return concise JSON only. Do not include hidden chain-of-thought.",
      "Check: repo grounding, one-input UX, multi-agent credibility, video clarity, specificity, first-15-second aha, and no leftover reference-video or external media-database assumptions.",
      "",
      `Draft:\n${JSON.stringify(draft, null, 2)}`,
      `Analysis:\n${JSON.stringify(analysis, null, 2)}`,
      `Strategy:\n${JSON.stringify(strategy, null, 2)}`,
    ].join("\n"),
    qualityReviewSchema,
  );

  return {
    review,
    log: {
      agent: "Quality Judge Agent",
      provider: "gemini",
      model,
      entries: [
        {
          step: "Critique pitch plan",
          status: "done",
          message: review.verdict,
        },
        {
          step: "Apply quality bar",
          status: "done",
          message: `Score ${review.score}. Fixes: ${review.fixes.slice(0, 3).join(" ")}`,
        },
      ],
    },
  };
}

function localQualityJudge(error: unknown, model: string, draft: PitchDraft): { review: QualityReview; log: AgentLog } {
  const message = friendlyProviderError(error, "Quality judge failed; applied the local product quality bar.");
  const review: QualityReview = {
    score: clamp(Number(draft.score) || 82, 0, 100),
    verdict: "The generated storyboard is specific enough to render; local quality checks were applied because the judge model failed.",
    issues: [message],
    fixes: [
      "Keep the repo-only input flow.",
      "Make demo capture a first-class product capability.",
      "Keep captions short and evidence-backed.",
    ],
  };

  return {
    review,
    log: {
      agent: "Quality Judge Agent",
      provider: "gemini",
      model,
      entries: [
        {
          step: "Recover judge pass",
          status: "skipped",
          message,
        },
        {
          step: "Apply local quality bar",
          status: "done",
          message: review.verdict,
        },
      ],
    },
  };
}

async function runFeatherlessJudge(
  draft: PitchDraft,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): Promise<{ review?: QualityReview; model?: string }> {
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) return {};

  const model = process.env.FEATHERLESS_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507";
  try {
    const response = await fetch("https://api.featherless.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/gogorun1/DemoMaster",
        "X-Title": "DemoMaster",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a concise quality judge. Return strict JSON with keys score, verdict, issues, fixes. No markdown.",
          },
          {
            role: "user",
            content: JSON.stringify({ draft, analysis, strategy }),
          },
        ],
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content || "{}";
    return { review: normalizeReview(parseJson(content)), model };
  } catch {
    return {};
  }
}

async function generateJson<T>(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<T> {
  try {
    const response = await withTimeout(
      client.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.35,
          maxOutputTokens: 8192,
          responseFormat: {
            text: {
              mimeType: "application/json",
              schema,
            },
          },
        } as unknown as Record<string, unknown>,
      }),
      Number(process.env.GEMINI_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      `Gemini agent call timed out on ${model}.`,
    );
    return parseJson(response.text ?? "{}") as T;
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    const response = await withTimeout(
      client.models.generateContent({
        model,
        contents: `${prompt}\n\nReturn strict JSON only. Do not wrap it in Markdown.`,
        config: {
          temperature: 0.35,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: schema,
        } as unknown as Record<string, unknown>,
      }),
      Number(process.env.GEMINI_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      `Gemini agent call timed out on ${model}.`,
    );
    return parseJson(response.text ?? "{}") as T;
  }
}

function buildAgentPrompt(agentName: string, request: PitchRequest, repo: RepoContext, instructions: string[]) {
  const files = repo.files
    .map((file) => `### ${file.path}\n${file.content}`)
    .join("\n\n")
    .slice(0, 42000);

  return [
    `You are ${agentName} inside DemoMaster.`,
    "",
    "Product context:",
    "- DemoMaster converts one demo repository URL into a narrated product pitch video.",
    "- The pitch output must describe the input repository's product, not DemoMaster itself.",
    "- A production-grade pitch should include real footage from the repo running in a sandbox, captured through a browser automation layer.",
    "- The target hackathon is AI Agent Olympics at Milan AI Week.",
    "- The stack should emphasize Google Gemini; Featherless is optional for critique; Speechmatics is optional for future voice input; Vultr is deployment infrastructure.",
    "- Do not use an external video database or reference-video input.",
    "",
    "Instructions:",
    ...instructions.map((item) => `- ${item}`),
    "",
    `Repo URL: ${request.repoUrl}`,
    `Repo: ${repo.owner || "unknown"}/${repo.repo || "unknown"}`,
    `Description: ${repo.description || "unknown"}`,
    `Homepage: ${repo.homepage || "none"}`,
    `Primary language: ${repo.language || "unknown"}`,
    "File tree sample:",
    repo.fileTree.slice(0, 180).join("\n") || "No file tree available.",
    "",
    "Selected file contents:",
    files || "No files were available.",
  ].join("\n");
}

function normalizePitchPlan(
  draft: PitchDraft,
  request: PitchRequest,
  repo: RepoContext,
  analysis: ProductAnalysis,
  review: QualityReview,
): PitchPlan {
  const fallback = fallbackPitchPlan(request, repo);
  const rawScenes = Array.isArray(draft.scenes) && draft.scenes.length ? draft.scenes : fallback.scenes;
  let cursor = 0;
  const scenes = rawScenes.slice(0, 6).map((scene, index) => {
    const duration = clamp(Number(scene.duration) || fallback.scenes[index]?.duration || 10, 7, 16);
    const visual = VISUALS.includes(scene.visual) ? scene.visual : fallback.scenes[index]?.visual || "workflow";
    const normalized = {
      id: cleanString(scene.id) || `scene-${index + 1}`,
      title: cleanString(scene.title) || fallback.scenes[index]?.title || `Scene ${index + 1}`,
      beat: cleanString(scene.beat) || fallback.scenes[index]?.beat || "",
      narration: cleanString(scene.narration) || fallback.scenes[index]?.narration || "",
      onScreenText: cleanString(scene.onScreenText) || fallback.scenes[index]?.onScreenText || "",
      visual,
      duration,
      start: cursor,
    };
    cursor += duration;
    return normalized;
  });

  const productReport = normalizeReport(draft.productReport, fallback.productReport);
  productReport.qualityBar = [...new Set([...productReport.qualityBar, ...review.fixes])].slice(0, 8);
  const draftName = cleanString(draft.productName);

  return {
    mode: "agentic",
    productName:
      draftName && !/^demomaster$/i.test(draftName)
        ? draftName
        : cleanString(analysis.productName) || fallback.productName,
    tagline: cleanString(draft.tagline) || fallback.tagline,
    primaryUser: cleanString(draft.primaryUser) || fallback.primaryUser,
    corePromise: cleanString(draft.corePromise) || fallback.corePromise,
    positioning: cleanString(draft.positioning) || fallback.positioning,
    strategy: cleanString(draft.strategy) || fallback.strategy,
    score: clamp(Number(review.score || draft.score || fallback.score), 0, 100),
    cta: cleanString(draft.cta) || fallback.cta,
    insights: cleanStringArray(draft.insights).length
      ? cleanStringArray(draft.insights).slice(0, 6)
      : fallback.insights,
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    productReport,
    partnerStack: buildPartnerStack(true),
    generatedAt: new Date().toISOString(),
  };
}

function normalizeReport(report: ProductReport | undefined, fallback: ProductReport): ProductReport {
  return {
    userNeed: cleanString(report?.userNeed) || fallback.userNeed,
    productShape: cleanString(report?.productShape) || fallback.productShape,
    experienceFlow: cleanStringArray(report?.experienceFlow).length
      ? cleanStringArray(report?.experienceFlow).slice(0, 6)
      : fallback.experienceFlow,
    coreFunctions: normalizeFunctions(report?.coreFunctions, fallback.coreFunctions),
    supportingFunctions: normalizeFunctions(report?.supportingFunctions, fallback.supportingFunctions),
    whyThisFlowWorks: cleanString(report?.whyThisFlowWorks) || fallback.whyThisFlowWorks,
    qualityBar: cleanStringArray(report?.qualityBar).length
      ? cleanStringArray(report?.qualityBar).slice(0, 8)
      : fallback.qualityBar,
  };
}

function normalizeFunctions(functions: ProductFunction[] | undefined, fallback: ProductFunction[]) {
  if (!Array.isArray(functions) || !functions.length) return fallback;
  return functions
    .map((item) => ({
      name: cleanString(item.name),
      why: cleanString(item.why),
    }))
    .filter((item) => item.name && item.why)
    .slice(0, 5);
}

function normalizeReview(value: unknown): QualityReview {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    score: clamp(Number(record.score) || 82, 0, 100),
    verdict: cleanString(record.verdict) || "The pitch is usable and specific enough to render.",
    issues: cleanStringArray(record.issues),
    fixes: cleanStringArray(record.fixes),
  };
}

function repoLog(repo: RepoContext): AgentLogEntry {
  return {
    step: "Inspect repository",
    status: repo.source === "github" ? "done" : repo.source === "manual" ? "skipped" : "error",
    message:
      repo.source === "github"
        ? `Loaded ${repo.files.length} high-signal file(s) from ${repo.owner}/${repo.repo} on ${repo.branch}.`
        : repo.warnings[0] || "Repository was not inspected from GitHub.",
  };
}

function parseJson(text: string) {
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
      if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
      throw new Error("Model returned text that was not parseable JSON.");
    }
  }
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => cleanString(item)).filter(Boolean)
    : [];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function friendlyProviderError(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (/API key expired/i.test(raw)) return "Gemini API key is expired. Renew GEMINI_API_KEY to run the real agent pipeline.";
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(raw)) {
    return "Gemini API key was rejected. Check GEMINI_API_KEY before running the real agent pipeline.";
  }
  if (/quota|rate limit|429/i.test(raw)) return "Gemini quota or rate limit was hit. Try again later or switch keys.";
  if (/model .*not found|404/i.test(raw)) return "The configured Gemini model was not available. Check GEMINI_REASONING_MODEL.";
  if (/timed out/i.test(raw)) return raw;
  return fallback;
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && /timed out/i.test(error.message);
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

const productAnalysisSchema = {
  type: "object",
  properties: {
    productName: { type: "string" },
    primaryUser: { type: "string" },
    userNeed: { type: "string" },
    productShape: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 },
    risks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
  required: ["productName", "primaryUser", "userNeed", "productShape", "evidence", "risks"],
};

const functionSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    why: { type: "string" },
  },
  required: ["name", "why"],
};

const pitchStrategySchema = {
  type: "object",
  properties: {
    corePromise: { type: "string" },
    positioning: { type: "string" },
    strategy: { type: "string" },
    insightStack: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    experienceFlow: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 6 },
    coreFunctions: { type: "array", items: functionSchema, minItems: 3, maxItems: 5 },
    supportingFunctions: { type: "array", items: functionSchema, minItems: 2, maxItems: 5 },
  },
  required: [
    "corePromise",
    "positioning",
    "strategy",
    "insightStack",
    "experienceFlow",
    "coreFunctions",
    "supportingFunctions",
  ],
};

const pitchDraftSchema = {
  type: "object",
  properties: {
    productName: { type: "string" },
    tagline: { type: "string" },
    primaryUser: { type: "string" },
    corePromise: { type: "string" },
    positioning: { type: "string" },
    strategy: { type: "string" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    cta: { type: "string" },
    insights: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    scenes: {
      type: "array",
      minItems: 5,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          beat: { type: "string" },
          narration: { type: "string" },
          onScreenText: { type: "string" },
          visual: { type: "string", enum: VISUALS },
          duration: { type: "integer", minimum: 7, maximum: 16 },
          start: { type: "integer" },
        },
        required: ["id", "title", "beat", "narration", "onScreenText", "visual", "duration"],
      },
    },
    productReport: {
      type: "object",
      properties: {
        userNeed: { type: "string" },
        productShape: { type: "string" },
        experienceFlow: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 6 },
        coreFunctions: { type: "array", items: functionSchema, minItems: 3, maxItems: 5 },
        supportingFunctions: { type: "array", items: functionSchema, minItems: 2, maxItems: 5 },
        whyThisFlowWorks: { type: "string" },
        qualityBar: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 8 },
      },
      required: [
        "userNeed",
        "productShape",
        "experienceFlow",
        "coreFunctions",
        "supportingFunctions",
        "whyThisFlowWorks",
        "qualityBar",
      ],
    },
  },
  required: [
    "productName",
    "tagline",
    "primaryUser",
    "corePromise",
    "positioning",
    "strategy",
    "score",
    "cta",
    "insights",
    "scenes",
    "productReport",
  ],
};

const qualityReviewSchema = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string" },
    issues: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    fixes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
  required: ["score", "verdict", "issues", "fixes"],
};
