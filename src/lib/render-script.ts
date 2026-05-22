import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { normalizePitchSettings } from "@/lib/project-settings";
import { normalizePitchTimeline } from "@/lib/project-edits";
import type { DemoCaptureResult, PitchPlan } from "@/lib/types";

export interface RenderScene {
  id: string;
  kind: "deck" | "demo";
  from: number;
  duration: number;
  narration: string;
  sourceSegmentId?: string;
  mediaAssetId?: string;
  trimStart?: number;
  trimEnd?: number;
}

export interface RenderScript {
  version: 1;
  renderer: "canvas-v1";
  width: 1280;
  height: 720;
  fps: 30;
  duration: number;
  deckStyle: NonNullable<PitchPlan["deckStyle"]>;
  voiceSettings: NonNullable<PitchPlan["voiceSettings"]>;
  mediaAssetId?: string;
  captureManifest?: NonNullable<DemoCaptureResult["manifest"]>;
  scenes: RenderScene[];
}

export function buildRenderScript(plan: PitchPlan, capture?: DemoCaptureResult): RenderScript {
  const normalized = normalizePitchSettings(normalizePitchTimeline(plan));
  const manifest = ensureCaptureManifest(capture)?.manifest;
  return {
    version: 1,
    renderer: "canvas-v1",
    width: 1280,
    height: 720,
    fps: 30,
    duration: normalized.scenes.reduce((total, scene) => total + scene.duration, 0),
    deckStyle: normalized.deckStyle!,
    voiceSettings: normalized.voiceSettings!,
    mediaAssetId: normalized.activeMediaAssetId,
    captureManifest: manifest,
    scenes: normalized.scenes.map((scene) => ({
      id: scene.id,
      kind: ["product", "workflow", "evidence"].includes(scene.visual) ? "demo" : "deck",
      from: scene.start,
      duration: scene.duration,
      narration: scene.narration,
      sourceSegmentId: scene.sourceSegmentId,
      mediaAssetId: scene.mediaAssetId,
      trimStart: scene.trimStart,
      trimEnd: scene.trimEnd,
    })),
  };
}
