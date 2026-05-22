import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { normalizePitchTimeline } from "@/lib/project-edits";
import { defaultDeckStyle, normalizePitchSettings, normalizeVoiceSettings } from "@/lib/project-settings";
import { inferCameraPlan, inferVisualIntent } from "@/lib/semantic-director";
import type {
  DemoAnnotation,
  DemoCapturePlan,
  DemoCaptureResult,
  DemoCaptureSegment,
  PitchPlan,
  PitchScene,
  RepoContext,
  VoiceSettings,
  VisualMode,
} from "@/lib/types";

const defaultTargetDuration = 60;

export interface DemoDirectorOptions {
  appUrl: string;
  capture?: DemoCaptureResult;
  targetDuration?: number;
  voiceSettings?: Partial<VoiceSettings>;
}

export function buildDirectCapturePlan(appUrl: string): DemoCapturePlan {
  return {
    source: "public-url",
    targetUrl: appUrl,
    installCommand: "n/a",
    runCommand: "n/a",
    port: 3000,
    message: "Capture the live app URL directly with Playwright, then map the footage into a timed demo video.",
    steps: [
      {
        label: "Scout product surface",
        action: "Open the live URL, wait for the first meaningful screen, and inspect visible controls.",
        expected: "Identify the primary UI surface and interaction affordances.",
      },
      {
        label: "Record guided flow",
        action: "Interact with the primary controls and stable product states without submitting sensitive data.",
        expected: "Create footage and segment summaries for the product walkthrough.",
      },
      {
        label: "Bind narration to footage",
        action: "Allocate more time to the most important feature beats and assign camera focus targets.",
        expected: "Produce a target-length script, zoom plan, highlights, and export-ready timing.",
      },
    ],
  };
}

export function buildUrlOnlyRepoContext(appUrl: string, warnings: string[] = []): RepoContext {
  return {
    source: "manual",
    repoUrl: appUrl,
    homepage: appUrl,
    fileTree: [],
    files: [],
    warnings,
  };
}

export function buildDemoDirectorPitch(options: DemoDirectorOptions): PitchPlan {
  const targetDuration = clampDuration(options.targetDuration);
  const productName = productNameFromUrl(options.appUrl);
  const capture = ensureCaptureManifest(options.capture);
  const segments = selectSegments(capture?.manifest?.segments || [], capture);
  const durations = allocateSceneDurations(targetDuration, segments);
  const scenes = buildScenes({
    appUrl: options.appUrl,
    productName,
    segments,
    durations,
  });
  const plan: PitchPlan = {
    mode: "agentic",
    productName,
    tagline: "A focused product demo generated from a live app URL.",
    primaryUser: "Founders and builders who need a clear product video fast.",
    corePromise: "Turn a live app into a concise, narrated demo video with camera focus and highlights.",
    positioning: "DemoMaster acts like a demo director: it scouts the product, records the flow, times the script, and edits the footage into a shareable walkthrough.",
    strategy: "Lead with the real interface, spend the most time on meaningful interactions, and let narration, zoom, and annotations explain why each screen matters.",
    score: 91,
    cta: "Export the demo video and share the product flow.",
    insights: [
      "The demo is driven by recorded UI evidence instead of a separate slide deck.",
      "Narration duration and footage duration are planned together before preview/export.",
      "Feature-heavy beats receive more screen time and tighter camera focus.",
    ],
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    productReport: {
      userNeed: "A clear product walkthrough that feels like a human demo without manually editing footage, script, and voice as separate assets.",
      productShape: "A URL-to-video workflow: scout the app, record a safe flow, write a timed script, generate voice, then render zooms and annotations over the footage.",
      experienceFlow: scenes.map((scene) => scene.beat),
      coreFunctions: [
        { name: "Live URL capture", why: "The product starts from the actual app screen instead of repo metadata or static slides." },
        { name: "Demo flow planning", why: "Important feature moments get more time and a clearer narrative role." },
        { name: "Script-timed video", why: "Scene durations are allocated around the target video length before narration and export." },
        { name: "Auto camera direction", why: "The renderer zooms toward inputs, model selectors, results, and other feature targets when the script calls for them." },
      ],
      supportingFunctions: [
        { name: "Voice presets", why: "High-quality preset narration is available immediately while custom voice profile support can attach later." },
        { name: "Browser export", why: "The same timed canvas preview can be exported as a final WebM." },
      ],
      whyThisFlowWorks: "It matches how strong pitch videos are produced: understand the app, decide the user flow, record the flow, write voiceover to the evidence, and edit the camera so each sentence points at the right UI.",
      qualityBar: [
        "The preview should prioritize the video itself, with only the flow and export controls around it.",
        "No deck, repo report, or agent-log panels should compete with the final demo.",
        "Every demo scene should have a visible focus label and annotation.",
      ],
    },
    partnerStack: [
      {
        name: "Playwright",
        role: "Browser capture",
        status: capture?.status === "ready" ? "ready" : "optional",
        detail: capture?.message || "Records the live app URL and provides screenshot/video evidence.",
      },
      {
        name: "Google Gemini",
        role: "Narration voice",
        status: "ready",
        detail: "Generates preset voice narration from the timed script when an API key is configured.",
      },
      {
        name: "Speechmatics",
        role: "Voice QA",
        status: "skipped",
        detail: "Voice QA is hidden from the MVP surface and can remain a production background check.",
      },
      {
        name: "Featherless",
        role: "Model critique",
        status: "skipped",
        detail: "Open-model critique is removed from the visible MVP workflow.",
      },
    ],
    capturePlan: buildDirectCapturePlan(options.appUrl),
    targetDuration,
    voiceSettings: normalizeVoiceSettings(options.voiceSettings),
    deckStyle: {
      ...defaultDeckStyle(),
      captionStyle: "pill",
      primaryColor: "#2563eb",
    },
    mediaAssets: [],
    generatedAt: new Date().toISOString(),
  };

  return normalizePitchSettings(normalizePitchTimeline(plan));
}

function buildScenes({
  appUrl,
  productName,
  segments,
  durations,
}: {
  appUrl: string;
  productName: string;
  segments: DemoCaptureSegment[];
  durations: { intro: number; demo: number[]; close: number };
}) {
  let start = 0;
  const scenes: PitchScene[] = [];

  scenes.push(
    scene({
      id: "scene-intro",
      title: `${productName} in action`,
      beat: "Open on the first captured product screen and set up the user flow.",
      narration: `Here is ${productName}. In the next minute, watch the real app flow from the first screen to a clear product outcome.`,
      onScreenText: "Live app demo",
      visual: "problem",
      duration: durations.intro,
      start,
      context: `${productName} ${appUrl}`,
    }),
  );
  start += durations.intro;

  segments.forEach((segment, index) => {
    const duration = durations.demo[index] || 8;
    const visual = demoVisual(index);
    const context = `${segment.label} ${segment.actionSummary} ${segment.narrationHint || ""}`;
    const base: PitchScene = {
      id: `scene-demo-${index + 1}`,
      title: titleForSegment(segment, index),
      beat: beatForSegment(segment),
      narration: narrationForSegment(productName, segment, index),
      onScreenText: segment.label,
      visual,
      duration,
      start,
      sourceSegmentId: segment.id,
      trimStart: Number((segment.startMs / 1000).toFixed(2)),
      trimEnd: Number((segment.endMs / 1000).toFixed(2)),
    };
    const cameraPlan = inferCameraPlan(base, context);
    scenes.push({
      ...base,
      visualIntent: inferVisualIntent(base, context),
      cameraPlan,
      annotations: annotationsForScene(cameraPlan.focusLabel, duration, segment),
    });
    start += duration;
  });

  scenes.push(
    scene({
      id: "scene-close",
      title: "Ready to share",
      beat: "Hold on the final captured product state and summarize the value.",
      narration: `${productName} turns the core workflow into visible proof: the interface, the action, and the result are all easy to follow in one short video.`,
      onScreenText: "Export-ready demo",
      visual: "close",
      duration: durations.close,
      start,
      context: "final result proof export video",
    }),
  );

  return scenes;
}

function scene(input: PitchScene & { context?: string }) {
  const { context, ...base } = input;
  return {
    ...base,
    visualIntent: inferVisualIntent(base, context),
    cameraPlan: inferCameraPlan(base, context),
  };
}

function annotationsForScene(focusLabel: string | undefined, duration: number, segment: DemoCaptureSegment): DemoAnnotation[] {
  const label = focusLabel || segment.label || "key product moment";
  const action = `${segment.label} ${segment.actionSummary}`.toLowerCase();
  return [
    {
      type: action.includes("click") || action.includes("hover") ? "click" : "highlight",
      label,
      targetLabel: focusLabel,
      start: Math.min(0.7, duration * 0.16),
      end: Math.max(1, duration - 0.8),
    },
  ];
}

function selectSegments(segments: DemoCaptureSegment[], capture?: DemoCaptureResult) {
  const fallback = capture?.interactionSummary?.length
    ? capture.interactionSummary.map((summary, index) => ({
        id: `interaction-${index + 1}`,
        label: summary,
        actionSummary: summary,
        startMs: index * 3500,
        endMs: (index + 1) * 3500,
        source: "interaction" as const,
        videoUrl: capture.videoUrl,
        screenshotUrl: capture.screenshotUrl,
        narrationHint: summary,
      }))
    : [];
  const candidates = segments.length ? segments : fallback;
  const usable = candidates.length
    ? candidates
    : [
        {
          id: "capture-segment-1",
          label: "Product surface",
          actionSummary: capture?.message || "Opened the live app and captured the visible product surface.",
          startMs: 0,
          endMs: 4500,
          source: "fallback" as const,
          videoUrl: capture?.videoUrl,
          screenshotUrl: capture?.screenshotUrl,
          narrationHint: "Explain the visible product surface.",
        },
      ];

  if (usable.length <= 5) return usable;
  const selected = usable
    .map((segment, index) => ({ segment, index, score: segmentScore(segment) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.segment);
  return selected;
}

function allocateSceneDurations(targetDuration: number, segments: DemoCaptureSegment[]) {
  const intro = round1(clamp(targetDuration * 0.13, 5, 8));
  const close = round1(clamp(targetDuration * 0.12, 5, 8));
  const demoBudget = Math.max(8, targetDuration - intro - close);
  const weights = segments.map(segmentScore);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || segments.length || 1;
  const demo = segments.map((_, index) => round1(clamp((demoBudget * weights[index]) / totalWeight, 4, 15)));
  return fitDurationBudget({ intro, demo, close }, targetDuration);
}

function fitDurationBudget(
  durations: { intro: number; demo: number[]; close: number },
  targetDuration: number,
) {
  const next = { intro: durations.intro, demo: [...durations.demo], close: durations.close };
  let delta = round1(targetDuration - durationTotal(next));

  if (delta < 0) {
    for (const index of demoIndexesByDuration(next.demo)) {
      if (delta >= 0) break;
      const reduction = Math.min(next.demo[index] - 4, Math.abs(delta));
      if (reduction <= 0) continue;
      next.demo[index] = round1(next.demo[index] - reduction);
      delta = round1(targetDuration - durationTotal(next));
    }
    for (const key of ["intro", "close"] as const) {
      if (delta >= 0) break;
      const reduction = Math.min(next[key] - 4, Math.abs(delta));
      if (reduction <= 0) continue;
      next[key] = round1(next[key] - reduction);
      delta = round1(targetDuration - durationTotal(next));
    }
  }

  if (delta > 0) {
    const targetIndex = next.demo.length ? next.demo.length - 1 : -1;
    if (targetIndex >= 0) next.demo[targetIndex] = round1(next.demo[targetIndex] + delta);
    else next.close = round1(next.close + delta);
  }

  return next;
}

function durationTotal(durations: { intro: number; demo: number[]; close: number }) {
  return round1(durations.intro + durations.close + durations.demo.reduce((sum, duration) => sum + duration, 0));
}

function demoIndexesByDuration(durations: number[]) {
  return durations.map((duration, index) => ({ duration, index })).sort((a, b) => b.duration - a.duration).map((item) => item.index);
}

function segmentScore(segment: DemoCaptureSegment) {
  const text = `${segment.label} ${segment.actionSummary} ${segment.narrationHint || ""}`.toLowerCase();
  let score = 1;
  if (/\b(input|prompt|composer|query|search|block|type)\b/.test(text)) score += 2.5;
  if (/\b(model|provider|selector|switch|llm|gpt|claude)\b/.test(text)) score += 2.2;
  if (/\b(result|output|answer|generated|preview|artifact|dashboard|report)\b/.test(text)) score += 2;
  if (/\b(click|start|generate|create|continue|submit|run)\b/.test(text)) score += 1.4;
  if (/\b(opened|scrolled|hovered|visible product)\b/.test(text)) score -= 0.2;
  return Math.max(0.6, score);
}

function titleForSegment(segment: DemoCaptureSegment, index: number) {
  const label = cleanSentence(segment.label || segment.actionSummary);
  if (!label) return `Demo beat ${index + 1}`;
  return label.length > 48 ? `${label.slice(0, 45)}...` : label;
}

function beatForSegment(segment: DemoCaptureSegment) {
  const summary = cleanSentence(segment.actionSummary || segment.label);
  return summary ? `Show how the product handles: ${summary}` : "Show the next meaningful product interaction.";
}

function narrationForSegment(productName: string, segment: DemoCaptureSegment, index: number) {
  const summary = cleanSentence(segment.actionSummary || segment.label).replace(/\.$/, "");
  const focus = focusPhrase(segment);
  if (index === 0) {
    return `First, ${productName} shows the starting point: ${summary}. The camera stays on the ${focus} so the viewer understands where the flow begins.`;
  }
  if (/\b(result|output|answer|generated|preview|artifact|dashboard|report)\b/i.test(summary)) {
    return `Now the important proof appears: ${summary}. This is where the demo should slow down, because the viewer needs time to inspect the result.`;
  }
  return `Next, the flow moves through ${summary}. This beat matters because the ${focus} connects the user's action to the product response.`;
}

function focusPhrase(segment: DemoCaptureSegment) {
  const text = `${segment.label} ${segment.actionSummary}`.toLowerCase();
  if (/\b(input|prompt|composer|query|search|block|type)\b/.test(text)) return "input area";
  if (/\b(model|provider|selector|switch|llm|gpt|claude)\b/.test(text)) return "model selector";
  if (/\b(result|output|answer|generated|preview|artifact)\b/.test(text)) return "generated result";
  if (/\b(button|click|cta|start|generate|create|continue|submit|run)\b/.test(text)) return "primary action";
  if (/\b(nav|menu|sidebar|workspace)\b/.test(text)) return "navigation";
  return "main product surface";
}

function demoVisual(index: number): VisualMode {
  if (index === 0) return "product";
  if (index % 3 === 1) return "workflow";
  return "evidence";
}

function productNameFromUrl(appUrl: string) {
  try {
    const url = new URL(appUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "localhost" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return "Local App";
    const root = host.split(".")[0] || host;
    return titleCase(root.replace(/[-_]+/g, " "));
  } catch {
    return "Your app";
  }
}

function cleanSentence(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function clampDuration(value: unknown) {
  const numeric = Number(value);
  return Math.max(30, Math.min(120, Number.isFinite(numeric) ? numeric : defaultTargetDuration));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number) {
  return Number(value.toFixed(1));
}
