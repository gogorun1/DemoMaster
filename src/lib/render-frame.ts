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

export function getDemoPlaybackTime(plan: PitchPlan, time: number, mediaDuration: number) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return 0;
  const maxMediaTime = Math.max(0, mediaDuration - 0.05);
  const demoScenes = plan.scenes.filter(isDemoScene);
  if (!demoScenes.length) return 0;
  const start = demoScenes[0].start;
  const lastScene = demoScenes[demoScenes.length - 1];
  const end = lastScene.start + lastScene.duration;
  const progress = Math.min(1, Math.max(0, (time - start) / Math.max(1, end - start)));
  return Math.min(maxMediaTime, Math.max(0, progress * mediaDuration));
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

export function drawPitchFrame(
  ctx: CanvasRenderingContext2D,
  plan: PitchPlan,
  time: number,
  captureImage?: CanvasImageSource,
) {
  const { width, height } = ctx.canvas;
  const scene = getSceneAtTime(plan, time);
  const total = getTotalDuration(plan);
  const sceneProgress = Math.min(1, Math.max(0, (time - scene.start) / scene.duration));
  const deckStyle = normalizeDeckStyle(plan.deckStyle);
  const colors = themedColors(palette[scene.visual] ?? palette.workflow, deckStyle);

  ctx.clearRect(0, 0, width, height);
  if (captureImage && isDemoScene(scene)) {
    drawFullscreenDemo(ctx, plan, scene, sceneProgress, width, height, captureImage, deckStyle, colors);
    return;
  }

  drawBackground(ctx, width, height, colors, deckStyle);
  drawHeader(ctx, plan, time, total, width, colors);
  drawVisual(ctx, scene, sceneProgress, width, height, colors, captureImage);
  drawCopy(ctx, plan, scene, sceneProgress, width, height, colors, deckStyle);
  drawTimeline(ctx, plan, time, width, height);
}

function drawFullscreenDemo(
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
  const cameraPlan = normalizeCameraPlan(scene.cameraPlan, scene);
  const crop = animatedCameraCrop(plan, scene, cameraPlan, progress);
  drawImageCropCover(ctx, captureImage, crop, 0, 0, width, height);
  drawCameraVignette(ctx, width, height, cameraPlan, colors);
  if (deckStyle.captionStyle === "none") return;

  ctx.font = "650 20px Geist, Arial, sans-serif";
  const narration = wrapText(ctx, scene.narration, width - 160, 2);
  const panelHeight = narration.length > 1 ? 82 : 54;
  const isPill = deckStyle.captionStyle === "pill";
  const panelY = height - panelHeight - (isPill ? 42 : 28);
  const panelX = isPill ? 86 : 56;
  const panelW = width - panelX * 2;
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

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  colors: FrameColors,
  deckStyle: DeckStyle,
) {
  ctx.fillStyle = colors.bgStart;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = colors.bgMid;
  ctx.fillRect(width * 0.58, 0, width * 0.42, height);

  ctx.fillStyle = colors.panel;
  roundRect(ctx, width * 0.56, 96, width * 0.36, height - 176, 10);
  ctx.fill();
  ctx.strokeStyle = colors.panelStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (deckStyle.showGrid) {
    ctx.strokeStyle = deckStyle.theme === "studio" || deckStyle.theme === "midnight" ? "rgba(255,255,255,0.055)" : "rgba(15,23,42,0.055)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 72) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 72) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  ctx.fillStyle = colors.primary;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(0, 0, 12, height);
  ctx.fillRect(44, height - 70, width - 88, 4);
  ctx.globalAlpha = 1;
}

function drawHeader(ctx: CanvasRenderingContext2D, plan: PitchPlan, time: number, total: number, width: number, colors: FrameColors) {
  ctx.fillStyle = colors.ink;
  ctx.font = "760 23px Geist, Arial, sans-serif";
  ctx.fillText(plan.productName, 68, 70);

  ctx.fillStyle = colors.muted;
  ctx.font = "560 15px Geist, Arial, sans-serif";
  fitText(ctx, plan.tagline, 68, 96, width * 0.42);

  ctx.fillStyle = colors.primary;
  roundRect(ctx, width - 164, 42, 96, 34, 999);
  ctx.fill();
  ctx.font = "760 13px Geist Mono, monospace";
  ctx.fillStyle = colors.primary;
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`${Math.round(Math.min(time, total))}s / ${Math.round(total)}s`, width - 88, 64);
  ctx.textAlign = "left";
}

function drawVisual(
  ctx: CanvasRenderingContext2D,
  scene: PitchScene,
  progress: number,
  width: number,
  height: number,
  colors: FrameColors,
  captureImage?: CanvasImageSource,
) {
  const boxWidth = Math.min(480, width * 0.36);
  const boxHeight = height - 218;
  const left = width - boxWidth - 88;
  const top = 126;

  if (captureImage && ["presenter", "close"].includes(scene.visual)) {
    drawCapturedProduct(ctx, left, top, boxWidth, boxHeight, colors, captureImage);
    return;
  }

  if (scene.visual === "presenter") drawTalkingHead(ctx, left, top, boxWidth, boxHeight, colors, progress);
  if (scene.visual === "problem") drawProblem(ctx, left, top, boxWidth, boxHeight, colors, progress);
  if (scene.visual === "product") drawSolution(ctx, left, top, boxWidth, boxHeight, colors, progress);
  if (scene.visual === "workflow") drawWorkflow(ctx, left, top, boxWidth, boxHeight, colors, progress);
  if (scene.visual === "evidence") drawProof(ctx, left, top, boxWidth, boxHeight, colors, progress);
  if (scene.visual === "close") drawCta(ctx, left, top, boxWidth, boxHeight, colors, progress);
}

function drawCapturedProduct(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  captureImage: CanvasImageSource,
) {
  ctx.fillStyle = colors.panel;
  roundRect(ctx, x, y, width, height, 10);
  ctx.fill();
  ctx.strokeStyle = colors.panelStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = colors.ink;
  ctx.font = "780 20px Geist, Arial, sans-serif";
  ctx.fillText("Product proof", x + 26, y + 38);

  ctx.fillStyle = colors.muted;
  ctx.font = "560 13px Geist Mono, monospace";
  ctx.fillText("RECORDED DEMO", x + 26, y + 62);

  drawImageCover(ctx, captureImage, x + 26, y + 84, width - 52, height - 128);

  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 3;
  roundRect(ctx, x + 26, y + 84, width - 52, height - 128, 8);
  ctx.stroke();
}

function drawProblem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  const rows = ["Unclear story", "Feature tour", "No proof moment"];
  rows.forEach((row, index) => {
    const rowY = y + 88 + index * 88;
    const active = progress > index * 0.18;
    ctx.fillStyle = active ? colors.primary : colors.panelStroke;
    roundRect(ctx, x + 34, rowY, 7, 48, 4);
    ctx.fill();
    ctx.fillStyle = colors.ink;
    ctx.font = "760 24px Geist, Arial, sans-serif";
    ctx.fillText(row, x + 58, rowY + 30);
    ctx.fillStyle = colors.muted;
    ctx.font = "540 15px Geist, Arial, sans-serif";
    ctx.fillText(index === 0 ? "The viewer cannot see the win." : index === 1 ? "Screens change without a narrative." : "Claims arrive before evidence.", x + 58, rowY + 56);
  });
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 34, y + height - 64);
  ctx.lineTo(x + width - 34, y + height - 64);
  ctx.stroke();
}

function drawTalkingHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  const items = ["Need", "Flow", "Proof"];
  items.forEach((item, index) => {
    const itemY = y + 92 + index * 78;
    ctx.fillStyle = index <= Math.floor(progress * items.length) ? colors.primary : colors.panelStroke;
    roundRect(ctx, x + 42, itemY, 48, 48, 8);
    ctx.fill();
    ctx.fillStyle = index <= Math.floor(progress * items.length) ? "#ffffff" : colors.muted;
    ctx.font = "800 18px Geist Mono, monospace";
    ctx.fillText(String(index + 1).padStart(2, "0"), x + 53, itemY + 31);
    ctx.fillStyle = colors.ink;
    ctx.font = "780 30px Geist, Arial, sans-serif";
    ctx.fillText(item, x + 112, itemY + 33);
  });
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 66, y + 140);
  ctx.lineTo(x + 66, y + 296);
  ctx.stroke();
}

function drawSolution(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  const nodes = [
    { label: "Input", x: x + 36, y: y + 96 },
    { label: "Agents", x: x + width - 178, y: y + 96 },
    { label: "Pitch", x: x + width - 178, y: y + height - 142 },
    { label: "Video", x: x + 36, y: y + height - 142 },
  ];
  nodes.forEach((node, index) => drawNode(ctx, node.x, node.y, node.label, index % 2 ? colors.accent : colors.primary, colors));
  drawArrow(ctx, x + 162, y + 124, x + width - 190, y + 124, progress, colors.primary);
  drawArrow(ctx, x + width - 116, y + 160, x + width - 116, y + height - 154, progress, colors.accent);
  drawArrow(ctx, x + width - 190, y + height - 114, x + 162, y + height - 114, progress, colors.primary);
}

function drawWorkflow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  const steps = ["understand", "select", "script", "narrate"];
  steps.forEach((step, index) => {
    const stepX = x + 38;
    const stepY = y + 76 + index * 76;
    const active = progress * steps.length >= index;
    drawMiniPanel(ctx, stepX, stepY, width - 76, 54, step, active ? colors.primary : colors.panelStroke, colors);
  });
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + 64, y + 104);
  ctx.lineTo(x + 64, y + 104 + 228 * Math.min(1, progress + 0.12));
  ctx.stroke();
}

function drawProof(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  const metrics = [
    ["01", "Real footage"],
    ["02", "Aligned script"],
    ["03", "Voice QA"],
  ];
  metrics.forEach(([number, label], index) => {
    const metricY = y + 92 + index * 86;
    ctx.fillStyle = index <= Math.floor(progress * metrics.length) ? colors.accent : colors.panelStroke;
    roundRect(ctx, x + 34, metricY, width - 68, 58, 8);
    ctx.fill();
    ctx.fillStyle = colors.primary;
    ctx.font = "800 20px Geist Mono, monospace";
    ctx.fillText(number, x + 56, metricY + 37);
    ctx.fillStyle = colors.ink;
    ctx.font = "760 24px Geist, Arial, sans-serif";
    ctx.fillText(label, x + 104, metricY + 38);
  });
}

function drawCta(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: FrameColors,
  progress: number,
) {
  drawEditorialCard(ctx, x, y, width, height, colors);
  ctx.fillStyle = colors.primary;
  roundRect(ctx, x + 38, y + 78, width - 76, 92, 10);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "850 36px Geist, Arial, sans-serif";
  ctx.fillText("Ready", x + 66, y + 136);

  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(x + width / 2, y + height - 126, 70, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.fillStyle = colors.ink;
  ctx.font = "760 22px Geist, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("export", x + width / 2, y + height - 118);
  ctx.textAlign = "left";
}

function drawCopy(
  ctx: CanvasRenderingContext2D,
  plan: PitchPlan,
  scene: PitchScene,
  progress: number,
  width: number,
  height: number,
  colors: FrameColors,
  deckStyle: DeckStyle,
) {
  const x = 68;
  const maxWidth = Math.min(610, width * 0.47);
  const y = 162;
  const headlineSize = deckStyle.density === "bold" ? 66 : deckStyle.density === "compact" ? 48 : 58;
  const beatSize = deckStyle.density === "compact" ? 20 : 24;

  ctx.fillStyle = colors.primary;
  ctx.font = "780 16px Geist Mono, monospace";
  ctx.fillText(scene.title.toUpperCase(), x, y);

  ctx.fillStyle = colors.ink;
  const fittedHeadline = fitWrappedFont(ctx, scene.onScreenText, maxWidth, 3, headlineSize, 34, 850);
  const titleLines = wrapText(ctx, scene.onScreenText, maxWidth, 3);
  titleLines.forEach((line, index) => ctx.fillText(line, x, y + 74 + index * (fittedHeadline + 4)));

  ctx.fillStyle = colors.muted;
  ctx.font = `500 ${beatSize}px Geist, Arial, sans-serif`;
  const beatLines = wrapText(ctx, scene.beat, maxWidth, 4);
  const beatTop = y + 104 + titleLines.length * (fittedHeadline + 4);
  beatLines.forEach((line, index) => ctx.fillText(line, x, beatTop + index * 34));

  ctx.fillStyle = colors.panel;
  roundRect(ctx, x, height - 168, maxWidth, 90, 8);
  ctx.fill();
  ctx.strokeStyle = colors.panelStroke;
  ctx.stroke();

  ctx.fillStyle = colors.accent;
  ctx.font = "650 20px Geist, Arial, sans-serif";
  const narrationLines = wrapText(ctx, scene.narration, maxWidth - 34, 2);
  narrationLines.forEach((line, index) => ctx.fillText(line, x + 18, height - 117 + index * 28));

  ctx.fillStyle = colors.primary;
  roundRect(ctx, x, height - 54, Math.max(18, maxWidth * progress), 6, 3);
  ctx.fill();

  ctx.fillStyle = colors.muted;
  ctx.font = "600 15px Geist Mono, monospace";
  ctx.fillText(plan.primaryUser, x, height - 28);
}

function drawTimeline(ctx: CanvasRenderingContext2D, plan: PitchPlan, time: number, width: number, height: number) {
  const x = 68;
  const y = height - 40;
  const w = width - 136;
  const total = getTotalDuration(plan);

  ctx.fillStyle = "rgba(255,255,255,0.1)";
  roundRect(ctx, x, y, w, 8, 4);
  ctx.fill();

  plan.scenes.forEach((scene) => {
    const sx = x + (scene.start / total) * w;
    const sw = Math.max(4, (scene.duration / total) * w - 3);
    ctx.fillStyle = palette[scene.visual]?.primary ?? "#83d17d";
    ctx.globalAlpha = time >= scene.start ? 0.92 : 0.28;
    roundRect(ctx, sx, y, sw, 8, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
}

function drawEditorialCard(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, colors: FrameColors) {
  ctx.fillStyle = colors.panel;
  roundRect(ctx, x, y, width, height, 10);
  ctx.fill();
  ctx.strokeStyle = colors.panelStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = colors.primary;
  ctx.globalAlpha = 0.12;
  roundRect(ctx, x + 26, y + 24, width - 52, 10, 5);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNode(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, color: string, colors: FrameColors) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 126, 56, 8);
  ctx.fill();
  ctx.fillStyle = color === colors.accent ? colors.ink : "#ffffff";
  ctx.font = "800 21px Geist, Arial, sans-serif";
  fitText(ctx, label, x + 18, y + 36, 92);
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  progress: number,
  color: string,
) {
  const x = fromX + (toX - fromX) * progress;
  const y = fromY + (toY - fromY) * progress;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(x, y);
  ctx.stroke();
}

function drawMiniPanel(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, label: string, color: string, colors: FrameColors) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, width, height, 7);
  ctx.fill();
  ctx.fillStyle = color === colors.primary ? "#ffffff" : colors.ink;
  ctx.font = "760 20px Geist, Arial, sans-serif";
  ctx.fillText(label, x + 54, y + 34);
  ctx.fillStyle = color === colors.primary ? "rgba(255,255,255,0.7)" : colors.muted;
  ctx.font = "800 14px Geist Mono, monospace";
  ctx.fillText("STEP", x + 18, y + 34);
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

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceWidth = Number("naturalWidth" in image ? image.naturalWidth : "videoWidth" in image ? image.videoWidth : width) || width;
  const sourceHeight = Number("naturalHeight" in image ? image.naturalHeight : "videoHeight" in image ? image.videoHeight : height) || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const sw = width / scale;
  const sh = height / scale;
  const sx = (sourceWidth - sw) / 2;
  const sy = (sourceHeight - sh) / 2;

  ctx.save();
  roundRect(ctx, x, y, width, height, 8);
  ctx.clip();
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  ctx.restore();
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
  const blendProgress = Math.min(1, progress / 0.42);
  const blend = cameraPlan.easing === "linear" ? blendProgress : smoothstep(blendProgress);
  return {
    x: lerp(previous.x, target.x, blend),
    y: lerp(previous.y, target.y, blend),
    width: lerp(previous.width, target.width, blend),
    height: lerp(previous.height, target.height, blend),
  };
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

function fitWrappedFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  maxSize: number,
  minSize: number,
  weight: number,
) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px Geist, Arial, sans-serif`;
    const lines = wrapText(ctx, text, maxWidth, maxLines);
    if (lines.every((line) => ctx.measureText(line).width <= maxWidth)) break;
    size -= 2;
  }
  ctx.font = `${weight} ${size}px Geist, Arial, sans-serif`;
  return size;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
  let output = text;
  while (ctx.measureText(output).width > maxWidth && output.length > 8) {
    output = `${output.slice(0, -5)}...`;
  }
  ctx.fillText(output, x, y);
}

function measure(ctx: CanvasRenderingContext2D, text: string) {
  return ctx.measureText(text).width;
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
