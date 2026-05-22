import { GoogleGenAI } from "@google/genai";
import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { buildPartnerStack, fallbackAgentLogs, fallbackPitchPlan } from "@/lib/fallback";
import { normalizeVoiceSettings } from "@/lib/project-settings";
import { inferCameraPlan, inferVisualIntent, normalizeCameraPlan } from "@/lib/semantic-director";
import type {
  AgentLog,
  AgentLogEntry,
  AudioResult,
  DemoCapturePlan,
  DemoCaptureSegment,
  DemoCaptureResult,
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
  capturePlan: DemoCapturePlan;
}

interface QualityReview {
  score: number;
  verdict: string;
  issues: string[];
  fixes: string[];
}

interface CaptureAlignedPitch {
  corePromise?: string;
  positioning?: string;
  cta?: string;
  insights?: string[];
  scenes: Array<Partial<PitchScene>>;
}

interface AgentRunResult {
  pitch: PitchPlan;
  agentLogs: AgentLog[];
}

type AgentLogSink = (log: AgentLog) => void | Promise<void>;

const VISUALS: VisualMode[] = ["presenter", "problem", "product", "workflow", "evidence", "close"];
const DEFAULT_AGENT_TIMEOUT_MS = 25000;
const DEFAULT_TTS_TIMEOUT_MS = 45000;

export async function generatePitchWithAgents(request: PitchRequest, repo: RepoContext, onAgentLog?: AgentLogSink): Promise<AgentRunResult> {
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
    const repoForensicsLog: AgentLog = {
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
    };
    logs.push(repoForensicsLog);
    await emitAgentLog(onAgentLog, repoForensicsLog);

    const strategy = await runPitchStrategy(client, model, request, repo, analysis);
    const pitchStrategyLog: AgentLog = {
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
    };
    logs.push(pitchStrategyLog);
    await emitAgentLog(onAgentLog, pitchStrategyLog);

    const creative = await runCreativeDirectorWithRecovery(client, model, request, repo, analysis, strategy);
    const draft = creative.draft;
    const creativeDirectorLog = creative.log;
    logs.push(creativeDirectorLog);
    await emitAgentLog(onAgentLog, creativeDirectorLog);

    const demoCaptureLog: AgentLog = {
      agent: "Demo Capture Agent",
      provider: "gemini",
      model,
      entries: [
        {
          step: "Plan repo run",
          status: "done",
          message: draft.capturePlan?.message || "Prepared a browser capture plan for hosted URL or local runner recording.",
        },
        {
          step: "Prepare browser capture",
          status: "done",
          message: `${draft.capturePlan?.installCommand || "auto install"} -> ${draft.capturePlan?.runCommand || "auto run"}`,
        },
      ],
    };
    logs.push(demoCaptureLog);
    await emitAgentLog(onAgentLog, demoCaptureLog);

    const openModelCritic = await runFeatherlessCriticAgent(draft, analysis, strategy);
    logs.push(openModelCritic.log);
    await emitAgentLog(onAgentLog, openModelCritic.log);

    const judge = await runQualityJudge(client, model, draft, analysis, strategy).catch((error) =>
      localQualityJudge(error, model, draft),
    );
    logs.push(judge.log);
    await emitAgentLog(onAgentLog, judge.log);

    const pitch = normalizePitchPlan(draft, request, repo, analysis, mergeQualityReviews(judge.review, openModelCritic.review));
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

async function emitAgentLog(onAgentLog: AgentLogSink | undefined, log: AgentLog) {
  if (!onAgentLog) return;
  await onAgentLog(log);
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
    const voiceSettings = normalizeVoiceSettings(plan.voiceSettings);
    const voice = voiceSettings.voiceName || process.env.GEMINI_AUDIO_VOICE || process.env.GEMINI_TTS_VOICE || "Kore";
    const response = await withTimeout(
      client.models.generateContent({
        model: process.env.GEMINI_AUDIO_MODEL || process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
        contents: [
          {
            parts: [
              {
                text: [
                  "Read this as a premium product pitch narrator.",
                  `Tone: ${voiceToneInstruction(voiceSettings.tone)}`,
                  `Pacing: ${voicePacingInstruction(voiceSettings.pacing)}`,
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
      Number(process.env.GEMINI_AUDIO_TIMEOUT_MS || process.env.GEMINI_TTS_TIMEOUT_MS || DEFAULT_TTS_TIMEOUT_MS),
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

function voiceToneInstruction(tone: string) {
  if (tone === "energetic") return "energetic, crisp, demo-stage confidence without hype.";
  if (tone === "executive") return "executive, concise, authoritative, and boardroom-ready.";
  if (tone === "clear") return "clear, neutral, precise, and easy to follow.";
  return "warm, decisive, polished, and product-led.";
}

function voicePacingInstruction(pacing: string) {
  if (pacing === "brisk") return "brisk and compact while staying intelligible.";
  if (pacing === "calm") return "calm, unhurried, and deliberate.";
  return "measured, energetic, no salesy exaggeration.";
}

export async function alignPitchWithCapture(
  plan: PitchPlan,
  capture: DemoCaptureResult,
  requestUrl: string,
): Promise<{ pitch: PitchPlan; agentLog: AgentLog }> {
  const client = getGeminiClient();
  if (!client || capture.status !== "ready" || !capture.screenshotUrl) {
    const pitch = localCaptureAlignedPitch(plan, capture);
    return {
      pitch,
      agentLog: {
        agent: "Capture Alignment Agent",
        provider: "gemini",
        entries: [
          {
            step: "Check capture material",
            status: "skipped",
            message: capture.screenshotUrl
              ? "Capture alignment used the recorded interaction summary because Gemini is not configured."
              : "Capture alignment skipped because no completed capture screenshot was available.",
          },
        ],
      },
    };
  }

  try {
    const model = process.env.GEMINI_REASONING_MODEL || "gemini-3-flash-preview";
    const imagePart = await screenshotPart(capture.screenshotUrl, requestUrl);
    const prompt = [
      "You are the Capture Alignment Agent inside DemoMaster.",
      "Rewrite the final pitch script after the browser recording has been captured.",
      "The attached image is a representative frame from the browser recording, and the interaction summary is the source of truth for the demo walkthrough.",
      "The final video renderer is demo-footage first: the opener freezes the first captured frame, middle scenes play fullscreen browser footage with camera focus and captions, and the close freezes the final captured frame.",
      "Rules:",
      "- Keep the same number of scenes, but redesign the structure.",
      "- Scene 1 is a concise opener over the first captured frame; define the user problem and why the product matters.",
      "- Middle scenes are the main body and must be fullscreen demo walkthrough scenes. They should describe the actual recorded operations in order.",
      "- The final scene is a concise close over the final captured frame; summarize the value and end cleanly.",
      "- At least 65% of the total runtime should be demo walkthrough scenes.",
      "- Use visual='problem' for the opening, visual='close' for the ending, and visual='product', 'workflow', or 'evidence' for every middle demo scene. These visual values control footage behavior and camera intent, not slide templates.",
      "- Do not invent UI features that are not visible in the capture or grounded by the existing script.",
      "- Every middle scene should explicitly match the captured app surface, layout, interaction, or output state.",
      "- Every middle scene must map to one capture segment when possible and name exactly one camera focus target such as input composer, model selector, primary action, navigation, settings panel, generated result, editor surface, or dashboard evidence.",
      "- Prefer smooth focus changes over hard cuts: each demo scene should have a single readable target, not a tour of many controls.",
      "- Scene narration must follow the recorded interaction order when an interaction summary is provided.",
      "- If the recording stops at a login, signup, pricing, or setup step, say that clearly instead of claiming the final generation completed.",
      "- Write the demo section after the capture: describe what is happening on screen, why that operation matters, and what it proves.",
      "- Keep the opening and ending concise because they are frozen footage moments; put most words and time into the demo walkthrough.",
      "- Keep the script high-quality; this is still a product pitch, not a literal screen reader.",
      "- Return strict JSON only with keys corePromise, positioning, cta, insights, scenes. Demo scenes may include sourceSegmentId and cameraPlan.focusLabel.",
      "",
      `Capture target URL: ${capture.targetUrl || "unknown"}`,
      `Capture status message: ${capture.message}`,
      `Capture segments:\n${(capture.manifest?.segments || []).map((segment) => `- ${segment.id}: ${segment.label} (${Math.round(segment.startMs / 1000)}s-${Math.round(segment.endMs / 1000)}s) — ${segment.narrationHint || segment.actionSummary}`).join("\n") || "No capture segments were provided."}`,
      `Recorded interaction summary:\n${(capture.interactionSummary || []).map((step, index) => `${index + 1}. ${step}`).join("\n") || "No interaction summary was provided."}`,
      `Browser capture agent logs:\n${(capture.logs || []).map((entry) => `- ${entry.status}: ${entry.step} — ${entry.message}`).join("\n") || "No capture logs were provided."}`,
      `Existing pitch:\n${JSON.stringify(plan, null, 2)}`,
    ].join("\n");

    const response = await withTimeout(
      client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, imagePart],
          },
        ],
        config: {
          temperature: 0.28,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: captureAlignedPitchSchema,
        } as unknown as Record<string, unknown>,
      }),
      Number(process.env.GEMINI_CAPTURE_ALIGN_TIMEOUT_MS || 45000),
      `Gemini capture alignment timed out on ${model}.`,
    );
    const aligned = parseJson(response.text ?? "{}") as CaptureAlignedPitch;
    const pitch = normalizeCaptureAlignedPitch(plan, aligned, capture);
    return {
      pitch,
      agentLog: {
        agent: "Capture Alignment Agent",
        provider: "gemini",
        model,
        entries: [
          {
            step: "Inspect captured footage",
            status: "done",
            message: "Read the capture screenshot and recording metadata before finalizing the script.",
          },
          {
            step: "Rewrite final script",
            status: "done",
            message: "Rebuilt the script as a problem opener, fullscreen demo walkthrough, and concise summary close.",
          },
        ],
      },
    };
  } catch (error) {
    const pitch = localCaptureAlignedPitch(plan, capture);
    return {
      pitch,
      agentLog: {
        agent: "Capture Alignment Agent",
        provider: "gemini",
        entries: [
          {
            step: "Align script with capture",
            status: "error",
            message: friendlyProviderError(error, "Capture alignment failed; used the recorded interaction summary to keep the script demo-led."),
          },
        ],
      },
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
        "Use this story shape: brief problem opener, demo-heavy middle, concise summary close.",
        "The demo-heavy middle will be rewritten after browser capture, so leave room for operation-specific narration.",
        "Open with the problem within 10 seconds.",
        "Use concise narration and one main claim per scene; the renderer will place captions over demo footage instead of drawing slides.",
        "Opening and closing scenes should work as narration over frozen demo frames: first captured frame for the intro, final captured frame for the close.",
        "Demo scenes should be workflow/outcome driven, not feature tours.",
        "Do not rely on picture-in-picture or slide layouts; every scene should work as fullscreen product footage.",
        "Keep total duration between 45 and 70 seconds.",
        "Also produce a product/UX report explaining why this product and flow make sense.",
        "Also produce a demo capture plan that tries a public hosted demo URL first, then a temporary local runner if needed.",
        "If the repository has a homepage or hosted demo link, use it as the fastest capture target.",
      ],
    )}\n\nAnalysis:\n${JSON.stringify(analysis, null, 2)}\n\nStrategy:\n${JSON.stringify(strategy, null, 2)}`,
    pitchDraftSchema,
    Number(process.env.GEMINI_CREATIVE_TIMEOUT_MS || 45000),
  );
}

async function runCreativeDirectorWithRecovery(
  client: GoogleGenAI,
  model: string,
  request: PitchRequest,
  repo: RepoContext,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): Promise<{ draft: PitchDraft; log: AgentLog }> {
  try {
    const draft = await runCreativeDirector(client, model, request, repo, analysis, strategy);
    return {
      draft,
      log: {
        agent: "Creative Director Agent",
        provider: "gemini",
        model,
        entries: [
          {
            step: "Write storyboard",
            status: "done",
            message: `Created ${draft.scenes.length} scenes with short captions, demo-led moments, and an exportable narration script.`,
          },
          {
            step: "Write product report",
            status: "done",
            message: draft.productReport.whyThisFlowWorks,
          },
        ],
      },
    };
  } catch (error) {
    const draft = localCreativeDraft(request, repo, analysis, strategy);
    return {
      draft,
      log: {
        agent: "Creative Director Agent",
        provider: "gemini",
        model,
        entries: [
          {
            step: "Recover creative pass",
            status: "error",
            message: friendlyProviderError(error, "Creative Director model failed; rebuilt the storyboard from repo forensics and product strategy."),
          },
          {
            step: "Write deterministic storyboard",
            status: "done",
            message: `Created ${draft.scenes.length} grounded scenes from the successful forensics and strategy agents.`,
          },
        ],
      },
    };
  }
}

async function runQualityJudge(
  client: GoogleGenAI,
  model: string,
  draft: PitchDraft,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): Promise<{ review: QualityReview; log: AgentLog }> {
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

async function runFeatherlessCriticAgent(
  draft: PitchDraft,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): Promise<{ review?: QualityReview; log: AgentLog }> {
  const featherless = await runFeatherlessJudge(draft, analysis, strategy);
  if (featherless.review) {
    return {
      review: featherless.review,
      log: {
        agent: "Open Model Critic Agent",
        provider: "featherless",
        model: featherless.model,
        entries: [
          {
            step: "Run open-model critique",
            status: "done",
            message: featherless.review.verdict,
          },
          {
            step: "Return fix list",
            status: "done",
            message: `Score ${featherless.review.score}. Fixes: ${featherless.review.fixes.slice(0, 3).join(" ")}`,
          },
        ],
      },
    };
  }

  return {
    log: {
      agent: "Open Model Critic Agent",
      provider: "featherless",
      model: process.env.FEATHERLESS_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507",
      entries: [
        {
          step: "Check Featherless",
          status: "skipped",
          message: process.env.FEATHERLESS_API_KEY
            ? "Featherless critique was unavailable for this run."
            : "Set FEATHERLESS_API_KEY to enable the independent open-model critic.",
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
      signal: AbortSignal.timeout(Number(process.env.FEATHERLESS_TIMEOUT_MS || 20000)),
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

function mergeQualityReviews(primary: QualityReview, secondary?: QualityReview): QualityReview {
  if (!secondary) return primary;
  return {
    score: Math.round((primary.score * 2 + secondary.score) / 3),
    verdict: `${primary.verdict} Open-model critique: ${secondary.verdict}`,
    issues: [...new Set([...primary.issues, ...secondary.issues])].slice(0, 6),
    fixes: [...new Set([...primary.fixes, ...secondary.fixes])].slice(0, 8),
  };
}

function localCreativeDraft(
  request: PitchRequest,
  repo: RepoContext,
  analysis: ProductAnalysis,
  strategy: PitchStrategy,
): PitchDraft {
  const directAppMode = repo.source !== "github" && Boolean(repo.homepage);
  const productName = cleanString(analysis.productName) || repo.repo || "Demo";
  const corePromise = cleanString(strategy.corePromise) || cleanString(analysis.userNeed) || "Turn a repository into a clear product demo.";
  const positioning = cleanString(strategy.positioning) || `${productName} turns code evidence into a judge-ready product story.`;
  const flow = cleanStringArray(strategy.experienceFlow);
  const evidence = cleanStringArray(analysis.evidence);
  const coreFunctions = strategy.coreFunctions?.length ? strategy.coreFunctions : [
    { name: "Repository inspection", why: "The product starts from the real codebase instead of a hand-written brief." },
    { name: "Agentic pitch planning", why: "Separate agents turn evidence into positioning, storyboard, and quality checks." },
    { name: "Browser capture", why: "The final video can show the product running, not only a static script." },
  ];
  const supportingFunctions = strategy.supportingFunctions?.length ? strategy.supportingFunctions : [
    { name: "Narration generation", why: "A pitch video needs a clear spoken track over the recorded demo." },
    { name: "Transcript and QA", why: "The user can inspect what was said and whether the voice matches the script." },
  ];
  const scenes: PitchScene[] = [
    {
      id: "scene-1",
      title: directAppMode ? "One App, One Pitch" : "One Repo, One Pitch",
      beat: "Presenter opens with the user problem and the single-input promise.",
      narration: `${productName} starts with a simple idea: one product URL should be enough to explain what the product does, why it matters, and how it works.`,
      onScreenText: "One input. Real product story.",
      visual: "presenter",
      duration: 8,
      start: 0,
    },
    {
      id: "scene-2",
      title: "The Gap",
      beat: "Name the workflow pain this product removes.",
      narration: `Teams already have the truth in their code, but turning that truth into a polished demo still takes reading, scripting, recording, and editing by hand.`,
      onScreenText: "Demo work is still too manual.",
      visual: "problem",
      duration: 9,
      start: 8,
    },
    {
      id: "scene-3",
      title: "Agent Workflow",
      beat: "Show the multi-agent pipeline as the product experience.",
      narration: flow.length
        ? `The workflow is agentic: ${flow.slice(0, 3).join(", ").toLowerCase()}, then a final pitch is assembled with narration and footage.`
        : `The workflow is agentic: inspect the repo, define the product story, capture the running app, then assemble the final narrated pitch.`,
      onScreenText: "Agents turn proof into story.",
      visual: "workflow",
      duration: 11,
      start: 17,
    },
    {
      id: "scene-4",
      title: "Product Evidence",
      beat: "Ground the pitch in what the repository actually contains.",
      narration: evidence.length
        ? `The pitch is grounded in repository evidence: ${evidence.slice(0, 2).join(" ")}`
        : `The pitch is grounded in the repository structure, README, app routes, and implementation details rather than a generic prompt.`,
      onScreenText: "Claims stay grounded.",
      visual: "evidence",
      duration: 11,
      start: 28,
    },
    {
      id: "scene-5",
      title: "Real Demo Footage",
      beat: "Explain why browser capture is a core capability.",
      narration: `Instead of asking for a reference video, ${productName} records the product itself: first from a public demo URL, then from a temporary local runner when needed.`,
      onScreenText: "Show the product working.",
      visual: "product",
      duration: 10,
      start: 39,
    },
    {
      id: "scene-6",
      title: "Ready To Judge",
      beat: "Close with the outcome and call to action.",
      narration: `The result is a concise pitch video with a synchronized script, captured UI, and narration that can be edited before export.`,
      onScreenText: "Ready to share and refine.",
      visual: "close",
      duration: 9,
      start: 49,
    },
  ];

  return {
    productName,
    tagline: "A repo-to-pitch studio for agentic product demos.",
    primaryUser: cleanString(analysis.primaryUser) || "Hackathon builders and product teams",
    corePromise,
    positioning,
    strategy: cleanString(strategy.strategy) || "Use repo evidence and browser capture to turn a working product into a credible narrated pitch.",
    score: 86,
    cta: `Paste ${request.repoUrl.includes("github.com") ? "a GitHub repo" : directAppMode ? "a live app URL" : "a repository URL"} and let the agents build the pitch from the real product.`,
    insights: cleanStringArray(strategy.insightStack).length
      ? cleanStringArray(strategy.insightStack).slice(0, 6)
      : [
          "The repository is the source of truth.",
          "Capture must happen after product understanding.",
          "A good pitch needs script, voice, evidence, and visible process.",
        ],
    scenes,
    productReport: {
      userNeed: cleanString(analysis.userNeed) || corePromise,
      productShape: cleanString(analysis.productShape) || `${productName} is a web app that turns a repository into a narrated demo pitch.`,
      experienceFlow: flow.length ? flow.slice(0, 6) : [
        directAppMode ? "Paste a live app URL." : "Paste a repository URL.",
        "Agents inspect product evidence.",
        "The browser records the running demo.",
        "The script is aligned to the capture.",
        "The user exports the final narrated video.",
      ],
      coreFunctions,
      supportingFunctions,
      whyThisFlowWorks: "The flow matches how a strong demo is actually made: understand the product first, capture real behavior second, then script the pitch around evidence.",
      qualityBar: [
        "Ground claims in repository evidence.",
        "Prefer real captured UI over invented visuals.",
        "Keep each scene to one clear idea.",
        "Show agent progress while long work is running.",
        "Make transcript, voice, and export inspectable.",
      ],
    },
    capturePlan: {
      source: repo.homepage ? "public-url" : "local-runner",
      targetUrl: repo.homepage || undefined,
      installCommand: "auto-detect package manager and install dependencies",
      runCommand: "auto-detect dev/start/preview script and bind to a temporary local port",
      port: 3000,
      steps: [
        {
          label: "Resolve demo target",
          action: "Check GitHub metadata and sampled repo files for hosted demo links.",
          expected: "Use the fastest public URL when it exists.",
        },
        {
          label: "Run locally",
          action: "Clone the repo into /tmp, install dependencies, and start the app.",
          expected: "The app responds on a temporary localhost port.",
        },
        {
          label: "Record browser",
          action: "Open the running app with Playwright and record a short interaction.",
          expected: "Persist screenshot and WebM footage for the pitch renderer.",
        },
      ],
      message: repo.homepage
        ? "Capture the public hosted demo first, then use the temporary local runner if the public URL fails."
        : "Clone the repo into a temporary local runner, install dependencies, start the app, and capture browser footage.",
    },
  };
}

async function generateJson<T>(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  timeoutMs = Number(process.env.GEMINI_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
): Promise<T> {
  try {
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
      timeoutMs,
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
        } as unknown as Record<string, unknown>,
      }),
      timeoutMs,
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
    "- DemoMaster converts one GitHub repository URL or live app URL into a narrated product pitch video.",
    "- The pitch output must describe the input product, not DemoMaster itself.",
    "- A production-grade pitch should include real footage from the provided hosted demo URL, a discovered hosted demo URL, or the repo running in a temporary local runner.",
    "- The target hackathon is AI Agent Olympics at Milan AI Week.",
    "- The stack should emphasize Google Gemini; Featherless is optional for critique; Speechmatics verifies generated narration; Playwright records browser footage.",
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
  const capturePlan = normalizeCapturePlan(draft.capturePlan, fallback.capturePlan, repo);

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
    capturePlan,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeCaptureAlignedPitch(plan: PitchPlan, aligned: CaptureAlignedPitch, capture: DemoCaptureResult): PitchPlan {
  const captureWithManifest = ensureCaptureManifest(capture);
  const segments = captureWithManifest?.manifest?.segments || [];
  let cursor = 0;
  const lastIndex = plan.scenes.length - 1;
  const scenes = plan.scenes.map((scene, index) => {
    const next = aligned.scenes?.[index];
    const isDemoScene = index > 0 && index < lastIndex;
    const segment = isDemoScene ? pickSegmentForScene(segments, next, index - 1) : undefined;
    const requestedVisual = next?.visual && VISUALS.includes(next.visual) ? next.visual : scene.visual;
    const visual =
      index === 0
        ? "problem"
        : index === lastIndex
          ? "close"
          : ["product", "workflow", "evidence"].includes(requestedVisual)
            ? requestedVisual
            : index % 3 === 1
              ? "product"
              : index % 3 === 2
                ? "workflow"
                : "evidence";
    const duration = clamp(Number(next?.duration) || scene.duration, isDemoScene ? 11 : 7, isDemoScene ? 20 : 12);
    const focusLabel = cleanString(next?.cameraPlan?.focusLabel) || segmentFocusText(segment) || cleanString(scene.cameraPlan?.focusLabel);
    const segmentContext = segment ? `${segment.label} ${segment.actionSummary} ${segment.narrationHint || ""}` : "";
    const normalized: PitchScene = {
      ...scene,
      title: cleanString(next?.title) || scene.title,
      beat: cleanString(next?.beat) || scene.beat,
      narration: cleanString(next?.narration) || scene.narration,
      onScreenText: cleanString(next?.onScreenText) || scene.onScreenText,
      visual,
      duration,
      sourceSegmentId: segment?.id || cleanString(next?.sourceSegmentId) || scene.sourceSegmentId,
      trimStart: segment ? Number((segment.startMs / 1000).toFixed(2)) : scene.trimStart,
      trimEnd: segment ? Number((segment.endMs / 1000).toFixed(2)) : scene.trimEnd,
      start: cursor,
    };
    normalized.visualIntent = isDemoScene ? inferVisualIntent(normalized, segmentContext || focusLabel) : normalized.visualIntent;
    normalized.cameraPlan = isDemoScene
      ? normalizeCameraPlan(
          {
            ...next?.cameraPlan,
            mode: next?.cameraPlan?.mode || scene.cameraPlan?.mode || "focus",
            focusLabel,
          },
          normalized,
        )
      : normalized.cameraPlan;
    cursor += duration;
    return normalized;
  });

  return {
    ...plan,
    corePromise: cleanString(aligned.corePromise) || plan.corePromise,
    positioning: cleanString(aligned.positioning) || plan.positioning,
    cta: cleanString(aligned.cta) || plan.cta,
    insights: cleanStringArray(aligned.insights).length ? cleanStringArray(aligned.insights).slice(0, 6) : plan.insights,
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    generatedAt: new Date().toISOString(),
  };
}

function localCaptureAlignedPitch(plan: PitchPlan, capture: DemoCaptureResult): PitchPlan {
  if (capture.status !== "ready") return plan;

  const captureWithManifest = ensureCaptureManifest(capture);
  const segments = captureWithManifest?.manifest?.segments || [];
  const steps = cleanStringArray(capture.interactionSummary || []);
  const lastIndex = plan.scenes.length - 1;
  let cursor = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const isOpening = index === 0;
    const isClosing = index === lastIndex;
    const demoIndex = Math.max(0, index - 1);
    const segment = !isOpening && !isClosing ? segments[Math.min(demoIndex, Math.max(0, segments.length - 1))] : undefined;
    const step = steps[demoIndex] || steps[steps.length - 1] || capture.message;
    const visual: VisualMode = isOpening
      ? "problem"
      : isClosing
        ? "close"
        : index % 3 === 1
          ? "product"
          : index % 3 === 2
            ? "workflow"
            : "evidence";
    const duration = isOpening || isClosing ? 8 : 15;
    const narration = isOpening
      ? `${plan.productName} starts with the problem every demo team knows: the product may work, but the story only becomes convincing when the viewer sees the real flow.`
      : isClosing
        ? `That is the value of ${plan.productName}: a pitch that starts with the problem, spends most of its time on real product behavior, and ends with a clear reason to believe.`
        : demoNarration(step, demoIndex, plan.productName);
    const normalized: PitchScene = {
      ...scene,
      title: isOpening ? "The Problem" : isClosing ? "What It Proves" : demoTitle(step, demoIndex),
      beat: isOpening
        ? "Define the need before showing the product."
        : isClosing
          ? "Summarize the outcome after the walkthrough."
          : step,
      narration,
      onScreenText: isOpening ? "A demo needs proof, not just claims." : isClosing ? "Problem, proof, outcome." : demoOnScreenText(step, demoIndex),
      visual,
      duration,
      sourceSegmentId: segment?.id,
      trimStart: segment ? Number((segment.startMs / 1000).toFixed(2)) : scene.trimStart,
      trimEnd: segment ? Number((segment.endMs / 1000).toFixed(2)) : scene.trimEnd,
      start: cursor,
    };
    if (!isOpening && !isClosing) {
      const segmentContext = segment ? `${segment.label} ${segment.actionSummary} ${segment.narrationHint || ""}` : step;
      normalized.visualIntent = inferVisualIntent(normalized, segmentContext);
      normalized.cameraPlan = inferCameraPlan(normalized, segmentContext);
    }
    cursor += duration;
    return normalized;
  });

  return {
    ...plan,
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    generatedAt: new Date().toISOString(),
  };
}

function demoNarration(step: string, index: number, productName: string) {
  const lead = ["First", "Next", "Then", "Finally"][Math.min(index, 3)];
  const cleanStep = step.replace(/\.$/, "");
  if (/login|sign in|sign up|pricing|setup/i.test(step)) {
    return `${lead}, the recording shows that ${cleanStep.toLowerCase()}. ${productName} does not pretend the workflow is complete here; it uses this guarded step as proof of the real user path and boundary.`;
  }
  return `${lead}, the recording shows that ${cleanStep.toLowerCase()}. This is the useful part of the pitch: the narration follows the actual operation on screen instead of describing an abstract feature list.`;
}

function pickSegmentForScene(segments: DemoCaptureSegment[], scene: Partial<PitchScene> | undefined, fallbackIndex: number) {
  const requested = cleanString(scene?.sourceSegmentId);
  if (requested) {
    const match = segments.find((segment) => segment.id === requested);
    if (match) return match;
  }
  if (!segments.length) return undefined;
  return segments[Math.min(Math.max(0, fallbackIndex), segments.length - 1)];
}

function segmentFocusText(segment: DemoCaptureSegment | undefined) {
  if (!segment) return "";
  return cleanString(segment.narrationHint) || cleanString(segment.actionSummary) || cleanString(segment.label);
}

function demoTitle(step: string, index: number) {
  if (/open|load|live product/i.test(step)) return "Open The Product";
  if (/click|primary action|create|get started|start/i.test(step)) return "Follow The Main Action";
  if (/field|form|input|focus/i.test(step)) return "Enter The Workflow";
  if (/guard|empty|validation|sign in|sign up/i.test(step)) return "Show The Boundary";
  return `Demo Step ${index + 1}`;
}

function demoOnScreenText(step: string, index: number) {
  if (/open|load|live product/i.test(step)) return "Start from the real product.";
  if (/click|primary action|create|get started|start/i.test(step)) return "The main action moves the story.";
  if (/field|form|input|focus/i.test(step)) return "The flow asks for the next user input.";
  if (/guard|empty|validation|sign in|sign up/i.test(step)) return "A real demo shows its boundaries.";
  return `Recorded operation ${index + 1}.`;
}

function normalizeCapturePlan(
  plan: DemoCapturePlan | undefined,
  fallback: DemoCapturePlan,
  repo: RepoContext,
): DemoCapturePlan {
  const steps = Array.isArray(plan?.steps) && plan.steps.length
    ? plan.steps
        .map((step) => ({
          label: cleanString(step.label),
          action: cleanString(step.action),
          expected: cleanString(step.expected),
        }))
        .filter((step) => step.label && step.action && step.expected)
        .slice(0, 5)
    : fallback.steps;

  return {
    source: publicCaptureTarget(plan, repo, fallback) ? "public-url" : "local-runner",
    targetUrl: publicCaptureTarget(plan, repo, fallback),
    installCommand: cleanString(plan?.installCommand) || fallback.installCommand,
    runCommand: cleanString(plan?.runCommand) || fallback.runCommand,
    port: clamp(Number(plan?.port) || fallback.port || 3000, 1024, 65535),
    steps,
    message:
      cleanString(plan?.message) ||
      "DemoMaster will capture a hosted demo URL first, then clone and run the repo locally if needed.",
  };
}

function publicCaptureTarget(plan: DemoCapturePlan | undefined, repo: RepoContext, fallback: DemoCapturePlan) {
  const target = cleanString(plan?.targetUrl) || repo.homepage || fallback.targetUrl;
  if (!target) return undefined;
  if (plan?.source === "public-url") return target;
  if (repo.source !== "github" && repo.homepage) return target;
  if (fallback.source === "public-url") return target;
  return undefined;
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

async function screenshotPart(url: string, requestUrl: string) {
  const absoluteUrl = new URL(url, requestUrl).toString();
  const response = await fetch(absoluteUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read capture screenshot: ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return {
    inlineData: {
      mimeType: contentType,
      data,
    },
  };
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

const captureStepSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    action: { type: "string" },
    expected: { type: "string" },
  },
  required: ["label", "action", "expected"],
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
    capturePlan: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["public-url", "local-runner"] },
        targetUrl: { type: "string" },
        installCommand: { type: "string" },
        runCommand: { type: "string" },
        port: { type: "integer", minimum: 1024, maximum: 65535 },
        steps: { type: "array", items: captureStepSchema, minItems: 3, maxItems: 5 },
        message: { type: "string" },
      },
      required: ["source", "installCommand", "runCommand", "port", "steps", "message"],
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
    "capturePlan",
  ],
};

const captureAlignedPitchSchema = {
  type: "object",
  properties: {
    corePromise: { type: "string" },
    positioning: { type: "string" },
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
          sourceSegmentId: { type: "string" },
          cameraPlan: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["wide", "focus", "follow", "manual"] },
              focusLabel: { type: "string" },
            },
          },
        },
        required: ["title", "beat", "narration", "onScreenText", "visual", "duration"],
      },
    },
  },
  required: ["corePromise", "positioning", "cta", "insights", "scenes"],
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
