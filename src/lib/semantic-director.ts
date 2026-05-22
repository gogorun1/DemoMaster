import type { CameraCrop, CameraMode, CameraPlan, PitchScene, VisualIntent } from "@/lib/types";

const fullFrame: CameraCrop = { x: 0, y: 0, width: 1, height: 1 };

const focusRules: Array<{ label: string; keywords: string[]; crop: CameraCrop; confidence: number }> = [
  {
    label: "prompt input",
    keywords: ["input", "prompt", "message", "composer", "ask", "type", "search", "query"],
    crop: { x: 0.16, y: 0.52, width: 0.68, height: 0.38 },
    confidence: 0.82,
  },
  {
    label: "model selector",
    keywords: ["model", "provider", "llm", "gpt", "claude", "selector", "switch"],
    crop: { x: 0.48, y: 0.02, width: 0.48, height: 0.34 },
    confidence: 0.78,
  },
  {
    label: "navigation",
    keywords: ["sidebar", "nav", "menu", "workspace", "project list", "left panel"],
    crop: { x: 0, y: 0.08, width: 0.34, height: 0.84 },
    confidence: 0.74,
  },
  {
    label: "settings panel",
    keywords: ["setting", "config", "preference", "toggle", "permission", "control"],
    crop: { x: 0.52, y: 0.1, width: 0.44, height: 0.72 },
    confidence: 0.72,
  },
  {
    label: "generated result",
    keywords: ["answer", "response", "output", "result", "generated", "preview", "artifact"],
    crop: { x: 0.2, y: 0.14, width: 0.64, height: 0.68 },
    confidence: 0.72,
  },
  {
    label: "dashboard evidence",
    keywords: ["dashboard", "chart", "metric", "analytics", "table", "score", "report"],
    crop: { x: 0.1, y: 0.12, width: 0.8, height: 0.72 },
    confidence: 0.7,
  },
];

export const cameraModes: CameraMode[] = ["wide", "focus", "follow", "manual"];

export function inferVisualIntent(scene: PitchScene): VisualIntent {
  const rule = matchFocusRule(scene);
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

export function inferCameraPlan(scene: PitchScene): CameraPlan {
  const rule = matchFocusRule(scene);
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
  const fallback = inferCameraPlan(scene);
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

function matchFocusRule(scene: PitchScene) {
  const text = `${scene.title} ${scene.beat} ${scene.narration} ${scene.onScreenText}`.toLowerCase();
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
