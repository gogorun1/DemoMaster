import type { DeckDensity, DeckStyle, DeckTheme, DemoCaptionStyle, PitchPlan, VoiceSettings } from "@/lib/types";

export const voicePresets = ["Kore", "Puck", "Charon", "Zephyr"] as const;
export const deckThemes: DeckTheme[] = ["graphite", "studio", "paper", "midnight"];
export const deckDensities: DeckDensity[] = ["compact", "balanced", "bold"];
export const captionStyles: DemoCaptionStyle[] = ["bar", "pill", "none"];

export function defaultVoiceSettings(): VoiceSettings {
  return {
    voiceName: "Kore",
    tone: "warm",
    pacing: "measured",
  };
}

export function defaultDeckStyle(): DeckStyle {
  return {
    theme: "graphite",
    density: "balanced",
    captionStyle: "bar",
    primaryColor: "#2563eb",
    showGrid: true,
  };
}

export function normalizePitchSettings(plan: PitchPlan): PitchPlan {
  return {
    ...plan,
    targetDuration: plan.targetDuration || plan.scenes.reduce((total, scene) => total + scene.duration, 0),
    voiceSettings: normalizeVoiceSettings(plan.voiceSettings),
    deckStyle: normalizeDeckStyle(plan.deckStyle),
    mediaAssets: Array.isArray(plan.mediaAssets) ? plan.mediaAssets : [],
    activeMediaAssetId: plan.activeMediaAssetId,
  };
}

export function normalizeVoiceSettings(settings?: Partial<VoiceSettings>): VoiceSettings {
  const fallback = defaultVoiceSettings();
  return {
    voiceName: settings?.voiceName || fallback.voiceName,
    tone: settings?.tone || fallback.tone,
    pacing: settings?.pacing || fallback.pacing,
  };
}

export function normalizeDeckStyle(style?: Partial<DeckStyle>): DeckStyle {
  const fallback = defaultDeckStyle();
  return {
    theme: style?.theme && deckThemes.includes(style.theme) ? style.theme : fallback.theme,
    density: style?.density && deckDensities.includes(style.density) ? style.density : fallback.density,
    captionStyle: style?.captionStyle && captionStyles.includes(style.captionStyle) ? style.captionStyle : fallback.captionStyle,
    primaryColor: /^#[0-9a-f]{6}$/i.test(style?.primaryColor || "") ? style?.primaryColor || fallback.primaryColor : fallback.primaryColor,
    showGrid: typeof style?.showGrid === "boolean" ? style.showGrid : fallback.showGrid,
  };
}
