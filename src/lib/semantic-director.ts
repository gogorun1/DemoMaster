import type { CameraCrop, CameraMode, CameraPlan, PitchScene, VisualIntent } from "@/lib/types";

const fullFrame: CameraCrop = { x: 0, y: 0, width: 1, height: 1 };

const focusRules: Array<{ label: string; keywords: string[]; crop: CameraCrop; confidence: number }> = [
  {
    label: "input composer",
    keywords: ["input", "prompt", "message", "composer", "ask", "type", "search", "query", "block"],
    crop: { x: 0.1, y: 0.52, width: 0.8, height: 0.45 },
    confidence: 0.88,
  },
  {
    label: "model selector",
    keywords: ["model", "provider", "llm", "gpt", "claude", "selector", "switch"],
    crop: { x: 0.48, y: 0.02, width: 0.52, height: 0.29 },
    confidence: 0.84,
  },
  {
    label: "primary action",
    keywords: ["button", "cta", "submit", "run", "generate", "create", "start", "continue", "launch"],
    crop: { x: 0.22, y: 0.38, width: 0.62, height: 0.35 },
    confidence: 0.78,
  },
  {
    label: "navigation",
    keywords: ["sidebar", "nav", "menu", "workspace", "project list", "left panel"],
    crop: { x: 0, y: 0.08, width: 0.58, height: 0.33 },
    confidence: 0.74,
  },
  {
    label: "settings panel",
    keywords: ["setting", "config", "preference", "toggle", "permission", "control"],
    crop: { x: 0.42, y: 0.1, width: 0.58, height: 0.33 },
    confidence: 0.76,
  },
  {
    label: "generated result",
    keywords: ["answer", "response", "output", "result", "generated", "preview", "artifact", "final", "canvas"],
    crop: { x: 0.16, y: 0.16, width: 0.72, height: 0.41 },
    confidence: 0.78,
  },
  {
    label: "editor surface",
    keywords: ["editor", "document", "slide", "deck", "canvas", "timeline", "scene"],
    crop: { x: 0.08, y: 0.12, width: 0.74, height: 0.42 },
    confidence: 0.72,
  },
  {
    label: "dashboard evidence",
    keywords: ["dashboard", "chart", "metric", "analytics", "table", "score", "report", "data"],
    crop: { x: 0.08, y: 0.12, width: 0.84, height: 0.47 },
    confidence: 0.74,
  },
  {
    label: "auth boundary",
    keywords: ["login", "sign in", "sign up", "auth", "pricing", "checkout", "permission", "guard"],
    crop: { x: 0.18, y: 0.18, width: 0.64, height: 0.36 },
    confidence: 0.72,
  },
];

export const cameraModes: CameraMode[] = ["wide", "focus", "follow", "manual"];

export function inferVisualIntent(scene: PitchScene, context = ""): VisualIntent {
  const rule = matchFocusRule(scene, context);
  if (!rule) {
    return {
      summary: "Keep the product in a readable, centered composition.",
      targetHint: "main product surface",
      confidence: 0.52,
    };
  }

  return {
    summary: `Focus the camera on the ${rule.label} while this beat is narrated.`,
    targetHint: rule.label,
    confidence: rule.confidence,
  };
}

export function inferCameraPlan(scene: PitchScene, context = ""): CameraPlan {
  const rule = matchFocusRule(scene, context);
  if (!rule) {
    return {
      mode: "wide",
      focusLabel: "full product view",
      crop: fullFrame,
      zoom: 1,
      padding: 64,
      easing: "smooth",
    };
  }

  return {
    mode: "focus",
    focusLabel: rule.label,
    crop: rule.crop,
    zoom: Number((1 / Math.max(rule.crop.width, rule.crop.height)).toFixed(2)),
    padding: 72,
    easing: "smooth",
  };
}

export function normalizeCameraPlan(plan: Partial<CameraPlan> | undefined, scene: PitchScene): CameraPlan {
  const fallback = inferCameraPlan(scene, plan?.focusLabel || "");
  const mode = plan?.mode && cameraModes.includes(plan.mode) ? plan.mode : fallback.mode;
  const crop = normalizeCrop(plan?.crop || fallback.crop || fullFrame);
  return {
    mode,
    focusLabel: plan?.focusLabel || fallback.focusLabel,
    crop: mode === "wide" ? fullFrame : crop,
    zoom: clampNumber(plan?.zoom, 1, 5, fallback.zoom || 1),
    padding: clampNumber(plan?.padding, 0, 240, fallback.padding || 64),
    easing: plan?.easing === "linear" ? "linear" : "smooth",
  };
}

function matchFocusRule(scene: PitchScene, context = "") {
  const text = `${context} ${scene.title} ${scene.beat} ${scene.narration} ${scene.onScreenText}`.toLowerCase();
  return focusRules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
}

function normalizeCrop(crop: CameraCrop): CameraCrop {
  const width = clampNumber(crop.width, 0.18, 1, 1);
  const height = clampNumber(crop.height, 0.18, 1, 1);
  return {
    x: clampNumber(crop.x, 0, 1 - width, 0),
    y: clampNumber(crop.y, 0, 1 - height, 0),
    width,
    height,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Number(numeric.toFixed(3))));
}
