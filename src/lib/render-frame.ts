import { normalizeDeckStyle } from "@/lib/project-settings";
import { normalizeCameraPlan } from "@/lib/semantic-director";
import type { CameraCrop, CameraPlan, DeckStyle, PitchPlan, PitchScene, VisualMode } from "@/lib/types";

type FrameColors = {
  primary: string;
  secondary: string;
  accent: string;
  bgStart: string;
  bgMid: string;
  ink: string;
  muted: string;
  panel: string;
  panelStroke: string;
};

const palette: Record<VisualMode, { primary: string; secondary: string; accent: string }> = {
  presenter: { primary: "#2563eb", secondary: "#f8fafc", accent: "#dbeafe" },
  problem: { primary: "#f97316", secondary: "#fff7ed", accent: "#fed7aa" },
  product: { primary: "#059669", secondary: "#f0fdf4", accent: "#bbf7d0" },
  workflow: { primary: "#7c3aed", secondary: "#f5f3ff", accent: "#ddd6fe" },
  evidence: { primary: "#0ea5e9", secondary: "#f0f9ff", accent: "#bae6fd" },
  close: { primary: "#111827", secondary: "#f8fafc", accent: "#a7f3d0" },
};

export function getTotalDuration(plan: PitchPlan) {
  return plan.scenes.reduce((total, scene) => total + scene.duration, 0);
}

export function getSceneAtTime(plan: PitchPlan, time: number) {
  return (
    plan.scenes.find((scene) => time >= scene.start && time < scene.start + scene.duration) ??
    plan.scenes[plan.scenes.length - 1]
  );
}

export function isDemoScene(scene: PitchScene) {
  return ["product", "workflow", "evidence"].includes(scene.visual);
}

export function getSceneMediaPlaybackTime(plan: PitchPlan, time: number, mediaDuration: number) {
  const scene = getSceneAtTime(plan, time);
  if (!isDemoScene(scene)) return 0;
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return 0;
  const maxMediaTime = Math.max(0, mediaDuration - 0.05);
  const trimStart = Math.min(Math.max(0, scene.trimStart ?? 0), maxMediaTime);
  const trimEnd =
    scene.trimEnd !== undefined && scene.trimEnd > trimStart
      ? Math.min(scene.trimEnd, mediaDuration)
      : mediaDuration;
  const localProgress = Math.min(1, Math.max(0, (time - scene.start) / Math.max(1, scene.duration)));
  return Math.min(maxMediaTime, Math.max(0, trimStart + (trimEnd - trimStart) * localProgress));
}

export function getPresentationMediaTime(plan: PitchPlan, time: number, mediaDuration: number) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return 0;
  const scene = getSceneAtTime(plan, time);
  if (isDemoScene(scene)) return getSceneMediaPlaybackTime(plan, time, mediaDuration);
  const maxMediaTime = Math.max(0, mediaDuration - 0.05);
  const demoScenes = plan.scenes.filter(isDemoScene);
  if (!demoScenes.length) return scene.visual === "close" ? maxMediaTime : 0;
  const firstDemo = demoScenes[0];
  const lastDemo = demoScenes[demoScenes.length - 1];
  if (scene.start < firstDemo.start) return 0;
  if (scene.start >= lastDemo.start + lastDemo.duration || scene.visual === "close") return maxMediaTime;
  return getSceneMediaPlaybackTime(plan, Math.max(firstDemo.start, Math.min(time, lastDemo.start + lastDemo.duration - 0.05)), mediaDuration);
}

export function shouldPlayPresentationMedia(plan: PitchPlan, time: number) {
  return isDemoScene(getSceneAtTime(plan, time));
}

export function drawPitchFrame(
  ctx: CanvasRenderingContext2D,
  plan: PitchPlan,
  time: number,
  captureImage?: CanvasImageSource,
) {
  const { width, height } = ctx.canvas;
  const scene = getSceneAtTime(plan, time);
  const sceneProgress = Math.min(1, Math.max(0, (time - scene.start) / scene.duration));
  const deckStyle = normalizeDeckStyle(plan.deckStyle);
  const colors = themedColors(palette[scene.visual] ?? palette.workflow, deckStyle);

  ctx.clearRect(0, 0, width, height);
  if (captureImage) {
    drawFootageFrame(ctx, plan, scene, sceneProgress, width, height, captureImage, deckStyle, colors);
    return;
  }

  drawFootagePlaceholder(ctx, scene, width, height, colors);
}

function drawFootageFrame(
  ctx: CanvasRenderingContext2D,
  plan: PitchPlan,
  scene: PitchScene,
  progress: number,
  width: number,
  height: number,
  captureImage: CanvasImageSource,
  deckStyle: DeckStyle,
  colors: FrameColors,
) {
  const cameraPlan = isDemoScene(scene)
    ? normalizeCameraPlan(scene.cameraPlan, scene)
    : ({ mode: "wide", crop: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1, padding: 0, easing: "smooth" } as CameraPlan);
  const crop = isDemoScene(scene) ? animatedCameraCrop(plan, scene, cameraPlan, progress) : { x: 0, y: 0, width: 1, height: 1 };
  drawImageCropCover(ctx, captureImage, crop, 0, 0, width, height);
  drawCameraVignette(ctx, width, height, cameraPlan, colors);
  if (deckStyle.captionStyle === "none") return;

  ctx.font = "650 20px Geist, Arial, sans-serif";
  const narration = wrapText(ctx, scene.narration, width - 160, 2);
  const panelHeight = narration.length > 1 ? 82 : 54;
  const isPill = deckStyle.captionStyle === "pill";
  const panelX = isPill ? 86 : 56;
  const panelW = width - panelX * 2;
  const panelY = captionYForCrop(crop, height, panelHeight, isPill);
  ctx.fillStyle = "rgba(15,23,42,0.76)";
  roundRect(ctx, panelX, panelY, panelW, panelHeight, isPill ? 999 : 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  narration.forEach((line, index) => ctx.fillText(line, panelX + 24, panelY + 34 + index * 27));
  ctx.shadowBlur = 0;
}

function drawFootagePlaceholder(ctx: CanvasRenderingContext2D, scene: PitchScene, width: number, height: number, colors: FrameColors) {
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  for (let x = 0; x < width; x += 72) {
    ctx.fillRect(x, 0, 1, height);
  }
  ctx.fillStyle = colors.primary;
  ctx.globalAlpha = 0.8;
  roundRect(ctx, 58, 52, 220, 38, 999);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.font = "760 14px Geist Mono, monospace";
  ctx.fillText("DEMO FOOTAGE", 78, 77);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "850 48px Geist, Arial, sans-serif";
  fitText(ctx, scene.title || "Waiting for demo footage", 58, 150, width - 116);
  ctx.fillStyle = "rgba(248,250,252,0.68)";
  ctx.font = "560 22px Geist, Arial, sans-serif";
  fitText(ctx, "The video will use the first captured frame for the intro, live footage for the walkthrough, and the final frame for the close.", 58, 194, width - 116);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawImageCropCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  crop: CameraCrop,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceWidth = Number("naturalWidth" in image ? image.naturalWidth : "videoWidth" in image ? image.videoWidth : width) || width;
  const sourceHeight = Number("naturalHeight" in image ? image.naturalHeight : "videoHeight" in image ? image.videoHeight : height) || height;
  const cropX = crop.x * sourceWidth;
  const cropY = crop.y * sourceHeight;
  const cropWidth = crop.width * sourceWidth;
  const cropHeight = crop.height * sourceHeight;
  const targetAspect = width / height;
  const cropAspect = cropWidth / cropHeight;
  let sx = cropX;
  let sy = cropY;
  let sw = cropWidth;
  let sh = cropHeight;

  if (cropAspect > targetAspect) {
    sw = cropHeight * targetAspect;
    sx = cropX + (cropWidth - sw) / 2;
  } else {
    sh = cropWidth / targetAspect;
    sy = cropY + (cropHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function animatedCameraCrop(plan: PitchPlan, scene: PitchScene, cameraPlan: CameraPlan, progress: number): CameraCrop {
  const target = cameraPlan.crop || { x: 0, y: 0, width: 1, height: 1 };
  if (cameraPlan.mode === "wide") return { x: 0, y: 0, width: 1, height: 1 };
  const previous = previousDemoCrop(plan, scene);
  const elapsedSeconds = progress * Math.max(0.1, scene.duration);
  const blendProgress = Math.min(1, elapsedSeconds / 0.85);
  const blend = cameraPlan.easing === "linear" ? blendProgress : smoothstep(blendProgress);
  return {
    x: lerp(previous.x, target.x, blend),
    y: lerp(previous.y, target.y, blend),
    width: lerp(previous.width, target.width, blend),
    height: lerp(previous.height, target.height, blend),
  };
}

function captionYForCrop(crop: CameraCrop, height: number, panelHeight: number, isPill: boolean) {
  const targetBottom = crop.y + crop.height;
  if (targetBottom > 0.78) return isPill ? 42 : 32;
  return height - panelHeight - (isPill ? 42 : 28);
}

function previousDemoCrop(plan: PitchPlan, scene: PitchScene): CameraCrop {
  const index = plan.scenes.findIndex((candidate) => candidate.id === scene.id);
  if (index <= 0) return { x: 0, y: 0, width: 1, height: 1 };
  for (let i = index - 1; i >= 0; i -= 1) {
    const previousScene = plan.scenes[i];
    if (!isDemoScene(previousScene)) break;
    const previousPlan = normalizeCameraPlan(previousScene.cameraPlan, previousScene);
    if (previousPlan.mode !== "wide" && previousPlan.crop) return previousPlan.crop;
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return { x: 0, y: 0, width: 1, height: 1 };
}

function drawCameraVignette(ctx: CanvasRenderingContext2D, width: number, height: number, cameraPlan: CameraPlan, colors: FrameColors) {
  const gradient = ctx.createRadialGradient(width / 2, height / 2, width * 0.18, width / 2, height / 2, width * 0.72);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.24)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (cameraPlan.mode === "wide" || !cameraPlan.focusLabel) return;
  ctx.fillStyle = "rgba(15,23,42,0.66)";
  roundRect(ctx, 48, 42, 260, 42, 8);
  ctx.fill();
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 15px Geist Mono, monospace";
  fitText(ctx, cameraPlan.focusLabel.toUpperCase(), 66, 69, 222);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const charMode = !cleaned.includes(" ");
  const words = charMode ? Array.from(cleaned) : cleaned.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? (charMode ? `${line}${word}` : `${line} ${word}`) : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const original = charMode ? words.join("") : words.join(" ");
  const rendered = charMode ? lines.join("") : lines.join(" ");
  if (lines.length === maxLines && original.length > rendered.length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:!?]$/, "")}...`;
  }
  return lines;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
  let output = text;
  while (ctx.measureText(output).width > maxWidth && output.length > 8) {
    output = `${output.slice(0, -5)}...`;
  }
  ctx.fillText(output, x, y);
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function smoothstep(value: number) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function themedColors(base: { primary: string; secondary: string; accent: string }, deckStyle: DeckStyle): FrameColors {
  const primary = deckStyle.primaryColor || base.primary;
  if (deckStyle.theme === "paper") {
    return {
      primary,
      secondary: "#f8fafc",
      accent: base.primary === primary ? base.accent : "#dbeafe",
      bgStart: "#fbfcfe",
      bgMid: "#eef4ff",
      ink: "#111827",
      muted: "#526070",
      panel: "rgba(255,255,255,0.84)",
      panelStroke: "rgba(15,23,42,0.12)",
    };
  }
  if (deckStyle.theme === "studio") {
    return {
      primary,
      secondary: "#121826",
      accent: base.accent,
      bgStart: "#111827",
      bgMid: "#1f2937",
      ink: "#f8fafc",
      muted: "#cbd5e1",
      panel: "rgba(2,6,23,0.56)",
      panelStroke: "rgba(255,255,255,0.12)",
    };
  }
  if (deckStyle.theme === "midnight") {
    return {
      primary,
      secondary: "#08111f",
      accent: "#bfdbfe",
      bgStart: "#020617",
      bgMid: "#0f172a",
      ink: "#f8fafc",
      muted: "#b6c2d2",
      panel: "rgba(2,6,23,0.62)",
      panelStroke: "rgba(191,219,254,0.14)",
    };
  }
  return {
    primary,
    secondary: "#f1f5f9",
    accent: base.accent,
    bgStart: "#f8fafc",
    bgMid: "#e8eef7",
    ink: "#0f172a",
    muted: "#5f6b7a",
    panel: "rgba(255,255,255,0.8)",
    panelStroke: "rgba(15,23,42,0.12)",
  };
}
