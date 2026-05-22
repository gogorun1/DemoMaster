import type { PitchPlan, PitchScene, VisualMode } from "@/lib/types";

export type EditableScenePatch = Partial<Pick<PitchScene, "title" | "beat" | "narration" | "onScreenText" | "visual" | "duration">>;

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

  return plan;
}

export function normalizePitchTimeline(plan: PitchPlan): PitchPlan {
  let start = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const duration = Number.isFinite(Number(scene.duration)) ? Math.max(1, Number(scene.duration)) : 1;
    const visual = visualModes.includes(scene.visual) ? scene.visual : "workflow";
    const normalized = {
      ...scene,
      id: scene.id || `scene-${index + 1}`,
      title: scene.title || `Scene ${index + 1}`,
      beat: scene.beat || "",
      narration: scene.narration || "",
      onScreenText: scene.onScreenText || scene.title || `Scene ${index + 1}`,
      visual,
      duration,
      start,
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
  return {
    ...scene,
    ...patch,
    visual: patch.visual && visualModes.includes(patch.visual) ? patch.visual : scene.visual,
    duration: patch.duration === undefined ? scene.duration : Math.max(1, Number(patch.duration) || 1),
  };
}
