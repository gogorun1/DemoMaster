import { inferVisualIntent, normalizeCameraPlan } from "@/lib/semantic-director";
import type { PitchPlan, PitchScene, VisualMode } from "@/lib/types";

export type EditableScenePatch = Partial<
  Pick<
    PitchScene,
    | "title"
    | "beat"
    | "narration"
    | "onScreenText"
    | "visual"
    | "duration"
    | "sourceSegmentId"
    | "mediaAssetId"
    | "trimStart"
    | "trimEnd"
    | "visualIntent"
    | "cameraPlan"
  >
>;

export type ProjectEditOperation =
  | {
      type: "update-scene";
      sceneId: string;
      patch: EditableScenePatch;
    }
  | {
      type: "move-scene";
      sceneId: string;
      toIndex: number;
    }
  | {
      type: "scale-duration";
      targetDuration: number;
    };

const visualModes: VisualMode[] = ["presenter", "problem", "product", "workflow", "evidence", "close"];

export function applyProjectEditOperation(plan: PitchPlan, operation: ProjectEditOperation): PitchPlan {
  if (operation.type === "update-scene") {
    return normalizePitchTimeline({
      ...plan,
      scenes: plan.scenes.map((scene) => (scene.id === operation.sceneId ? normalizeScenePatch(scene, operation.patch) : scene)),
    });
  }

  if (operation.type === "move-scene") {
    const fromIndex = plan.scenes.findIndex((scene) => scene.id === operation.sceneId);
    if (fromIndex === -1) return plan;
    const scenes = [...plan.scenes];
    const [scene] = scenes.splice(fromIndex, 1);
    scenes.splice(Math.max(0, Math.min(operation.toIndex, scenes.length)), 0, scene);
    return normalizePitchTimeline({ ...plan, scenes });
  }

  if (operation.type === "scale-duration") {
    return normalizePitchTimeline(scalePitchDuration(plan, operation.targetDuration));
  }

  return plan;
}

export function normalizePitchTimeline(plan: PitchPlan): PitchPlan {
  let start = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const duration = Number.isFinite(Number(scene.duration)) ? Math.max(1, Number(scene.duration)) : 1;
    const visual = visualModes.includes(scene.visual) ? scene.visual : "workflow";
    const normalized: PitchScene = {
      ...scene,
      id: scene.id || `scene-${index + 1}`,
      title: scene.title || `Scene ${index + 1}`,
      beat: scene.beat || "",
      narration: scene.narration || "",
      onScreenText: scene.onScreenText || scene.title || `Scene ${index + 1}`,
      visual,
      trimStart: normalizeOptionalTime(scene.trimStart),
      trimEnd: normalizeOptionalTime(scene.trimEnd),
      duration,
      start,
      visualIntent: scene.visualIntent || inferVisualIntent({ ...scene, visual, duration, start }),
      cameraPlan: normalizeCameraPlan(scene.cameraPlan, { ...scene, visual, duration, start }),
    };
    start += duration;
    return normalized;
  });

  return {
    ...plan,
    scenes,
    narration: scenes.map((scene) => scene.narration.trim()).filter(Boolean).join(" "),
  };
}

function normalizeScenePatch(scene: PitchScene, patch: EditableScenePatch): PitchScene {
  const trimStart = patch.trimStart === undefined ? scene.trimStart : normalizeOptionalTime(patch.trimStart);
  const trimEnd = patch.trimEnd === undefined ? scene.trimEnd : normalizeOptionalTime(patch.trimEnd);
  const patched = {
    ...scene,
    ...patch,
    visual: patch.visual && visualModes.includes(patch.visual) ? patch.visual : scene.visual,
    duration: patch.duration === undefined ? scene.duration : Math.max(1, Number(patch.duration) || 1),
    trimStart,
    trimEnd: trimEnd !== undefined && trimStart !== undefined && trimEnd <= trimStart ? undefined : trimEnd,
  };
  return {
    ...patched,
    visualIntent: patch.visualIntent || inferVisualIntent(patched),
    cameraPlan: normalizeCameraPlan(patch.cameraPlan || patched.cameraPlan, patched),
  };
}

function scalePitchDuration(plan: PitchPlan, targetDuration: number): PitchPlan {
  const target = Math.max(5, Math.min(180, Number(targetDuration) || 5));
  const current = plan.scenes.reduce((total, scene) => total + Math.max(1, Number(scene.duration) || 1), 0);
  if (!current) return plan;
  const scale = target / current;
  return {
    ...plan,
    targetDuration: target,
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      duration: Math.max(1, Number((Math.max(1, Number(scene.duration) || 1) * scale).toFixed(1))),
    })),
  };
}

function normalizeOptionalTime(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Number(numeric.toFixed(2));
}
