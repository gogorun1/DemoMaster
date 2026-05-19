import type { PitchPlan, PitchScene, VisualMode } from "@/lib/types";

const palette: Record<VisualMode, { primary: string; secondary: string; accent: string }> = {
  presenter: { primary: "#2563eb", secondary: "#101827", accent: "#dbeafe" },
  problem: { primary: "#dc2626", secondary: "#241313", accent: "#fecaca" },
  product: { primary: "#059669", secondary: "#0d1c17", accent: "#d1fae5" },
  workflow: { primary: "#7c3aed", secondary: "#181126", accent: "#ede9fe" },
  evidence: { primary: "#d97706", secondary: "#21180d", accent: "#fed7aa" },
  close: { primary: "#0f766e", secondary: "#0c1d1b", accent: "#ccfbf1" },
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
  const colors = palette[scene.visual] ?? palette.workflow;

  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx, width, height, colors);
  drawHeader(ctx, plan, time, total, width);
  drawVisual(ctx, scene, sceneProgress, width, height, colors, captureImage);
  drawCopy(ctx, plan, scene, sceneProgress, width, height, colors);
  drawTimeline(ctx, plan, time, width, height);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  colors: { primary: string; secondary: string },
) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#070807");
  gradient.addColorStop(0.48, "#111512");
  gradient.addColorStop(1, colors.secondary);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.055)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.fillStyle = colors.primary;
  ctx.globalAlpha = 0.07;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
}

function drawHeader(ctx: CanvasRenderingContext2D, plan: PitchPlan, time: number, total: number, width: number) {
  ctx.fillStyle = "rgba(8,9,8,0.72)";
  roundRect(ctx, 42, 34, width - 84, 58, 8);
  ctx.fill();

  ctx.fillStyle = "#f1f3ed";
  ctx.font = "700 25px Geist, Arial, sans-serif";
  ctx.fillText(plan.productName, 68, 70);

  ctx.fillStyle = "#aab3a8";
  ctx.font = "500 17px Geist, Arial, sans-serif";
  fitText(ctx, plan.tagline, 68 + measure(ctx, plan.productName) + 24, 70, width - 360);

  ctx.font = "600 16px Geist Mono, monospace";
  ctx.fillStyle = "#83d17d";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(Math.min(time, total))}s / ${Math.round(total)}s`, width - 68, 70);
  ctx.textAlign = "left";
}

function drawVisual(
  ctx: CanvasRenderingContext2D,
  scene: PitchScene,
  progress: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string; secondary: string },
  captureImage?: CanvasImageSource,
) {
  const left = 68;
  const top = 136;
  const boxWidth = Math.min(520, width * 0.42);
  const boxHeight = height - 246;

  ctx.fillStyle = "rgba(8,9,8,0.62)";
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 2;
  roundRect(ctx, left, top, boxWidth, boxHeight, 8);
  ctx.fill();
  ctx.stroke();

  if (captureImage && ["product", "workflow", "evidence"].includes(scene.visual)) {
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
  colors: { primary: string; accent: string },
  captureImage: CanvasImageSource,
) {
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x + 30, y + 44, width - 60, height - 88, 8);
  ctx.fill();

  drawImageCover(ctx, captureImage, x + 38, y + 72, width - 76, height - 136);

  ctx.fillStyle = "rgba(17,19,23,0.82)";
  roundRect(ctx, x + 54, y + height - 116, width - 108, 46, 8);
  ctx.fill();
  ctx.fillStyle = colors.accent;
  ctx.font = "700 18px Geist, Arial, sans-serif";
  fitText(ctx, "Captured from the running repo", x + 74, y + height - 87, width - 150);
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 4;
  roundRect(ctx, x + 38, y + 72, width - 76, height - 136, 8);
  ctx.stroke();
}

function drawProblem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  const rows = ["feature tour", "missing hook", "no proof beat", "weak close"];
  rows.forEach((row, index) => {
    const rowY = y + 78 + index * 72;
    drawChip(ctx, x + 42, rowY, width - 84, 44, row, index < 2 + Math.round(progress * 2) ? colors.primary : "#4b514b");
  });
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x + 64, y + height - 84);
  ctx.bezierCurveTo(x + 170, y + height - 126, x + 266, y + height - 32, x + width - 58, y + height - 110);
  ctx.stroke();
}

function drawTalkingHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  const cx = x + width / 2;
  const faceY = y + height * 0.34;
  const mouth = 8 + Math.sin(progress * Math.PI * 18) * 5;

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, x + 54, y + 44, width - 108, height - 88, 8);
  ctx.fill();

  ctx.fillStyle = colors.accent;
  ctx.beginPath();
  ctx.arc(cx, faceY, 72, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#080908";
  ctx.beginPath();
  ctx.arc(cx - 26, faceY - 12, 6, 0, Math.PI * 2);
  ctx.arc(cx + 26, faceY - 12, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#080908";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx - 24, faceY + 28);
  ctx.quadraticCurveTo(cx, faceY + 28 + mouth, cx + 24, faceY + 28);
  ctx.stroke();

  ctx.fillStyle = colors.primary;
  roundRect(ctx, cx - 92, faceY + 84, 184, 132, 8);
  ctx.fill();

  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 4;
  for (let i = 0; i < 9; i += 1) {
    const wx = x + 82 + i * ((width - 164) / 8);
    const waveHeight = 18 + Math.sin(progress * Math.PI * 12 + i) * 18;
    ctx.beginPath();
    ctx.moveTo(wx, y + height - 66 - waveHeight);
    ctx.lineTo(wx, y + height - 66 + waveHeight);
    ctx.stroke();
  }
}

function drawSolution(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  drawNode(ctx, x + 60, y + 92, "Repo", colors.primary);
  drawNode(ctx, x + width - 190, y + 92, "Pitch", colors.accent);
  drawNode(ctx, x + 60, y + height - 150, "Video", colors.accent);
  drawNode(ctx, x + width - 190, y + height - 150, "Voice", colors.primary);
  drawArrow(ctx, x + 206, y + 117, x + width - 214, y + 117, progress, colors.primary);
  drawArrow(ctx, x + 140, y + height - 126, x + width - 214, y + 136, progress, colors.accent);
  drawArrow(ctx, x + width - 118, y + 160, x + width - 118, y + height - 150, progress, colors.primary);
}

function drawWorkflow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  const steps = ["understand", "select", "script", "narrate"];
  steps.forEach((step, index) => {
    const stepX = x + 46 + index * ((width - 92) / steps.length);
    const active = progress * steps.length >= index;
    drawMiniPanel(ctx, stepX, y + 92 + index * 44, (width - 118) / 2, 64, step, active ? colors.primary : "#5b665d");
  });
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 70, y + height - 82);
  for (let i = 0; i < 7; i += 1) {
    const px = x + 70 + i * ((width - 140) / 6);
    const py = y + height - 82 - Math.sin(i + progress * 3) * 34;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawProof(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  const bars = [0.42, 0.68, 0.82, 0.58, 0.91];
  bars.forEach((bar, index) => {
    const barHeight = (height - 170) * bar * Math.min(1, progress + 0.2);
    const bx = x + 64 + index * ((width - 128) / bars.length);
    ctx.fillStyle = index === 4 ? colors.primary : "rgba(255,255,255,0.16)";
    roundRect(ctx, bx, y + height - 72 - barHeight, 44, barHeight, 5);
    ctx.fill();
  });
  ctx.fillStyle = colors.accent;
  ctx.font = "700 82px Geist, Arial, sans-serif";
  ctx.fillText("92", x + width - 178, y + 140);
  ctx.font = "600 20px Geist, Arial, sans-serif";
  ctx.fillText("pitch score", x + width - 176, y + 174);
}

function drawCta(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
  progress: number,
) {
  ctx.fillStyle = colors.primary;
  roundRect(ctx, x + 58, y + 94, width - 116, 86, 8);
  ctx.fill();
  ctx.fillStyle = "#080908";
  ctx.font = "800 34px Geist, Arial, sans-serif";
  ctx.fillText("Export", x + 88, y + 148);

  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(x + width / 2, y + height - 142, 74, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.fillStyle = "#f1f3ed";
  ctx.font = "700 24px Geist, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ready", x + width / 2, y + height - 134);
  ctx.textAlign = "left";
}

function drawCopy(
  ctx: CanvasRenderingContext2D,
  plan: PitchPlan,
  scene: PitchScene,
  progress: number,
  width: number,
  height: number,
  colors: { primary: string; accent: string },
) {
  const x = Math.min(660, width * 0.52);
  const maxWidth = width - x - 68;
  const y = 154;

  ctx.fillStyle = colors.primary;
  ctx.font = "700 18px Geist Mono, monospace";
  ctx.fillText(scene.title.toUpperCase(), x, y);

  ctx.fillStyle = "#f1f3ed";
  ctx.font = "800 58px Geist, Arial, sans-serif";
  const titleLines = wrapText(ctx, scene.onScreenText, maxWidth, 3);
  titleLines.forEach((line, index) => ctx.fillText(line, x, y + 74 + index * 62));

  ctx.fillStyle = "#cbd3c6";
  ctx.font = "500 23px Geist, Arial, sans-serif";
  const beatLines = wrapText(ctx, scene.beat, maxWidth, 4);
  beatLines.forEach((line, index) => ctx.fillText(line, x, y + 286 + index * 34));

  ctx.fillStyle = "rgba(8,9,8,0.58)";
  roundRect(ctx, x, height - 166, maxWidth, 88, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.11)";
  ctx.stroke();

  ctx.fillStyle = colors.accent;
  ctx.font = "650 20px Geist, Arial, sans-serif";
  const narrationLines = wrapText(ctx, scene.narration, maxWidth - 34, 2);
  narrationLines.forEach((line, index) => ctx.fillText(line, x + 18, height - 117 + index * 28));

  ctx.fillStyle = colors.primary;
  roundRect(ctx, x, height - 52, maxWidth * progress, 6, 3);
  ctx.fill();

  ctx.fillStyle = "#aab3a8";
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

function drawChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  color: string,
) {
  ctx.fillStyle = "rgba(255,255,255,0.075)";
  roundRect(ctx, x, y, width, height, 7);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 9, height, 5);
  ctx.fill();
  ctx.fillStyle = "#f1f3ed";
  ctx.font = "650 22px Geist, Arial, sans-serif";
  ctx.fillText(text, x + 24, y + 29);
}

function drawNode(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, color: string) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 130, 58, 8);
  ctx.fill();
  ctx.fillStyle = "#080908";
  ctx.font = "800 22px Geist, Arial, sans-serif";
  ctx.fillText(label, x + 22, y + 37);
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

function drawMiniPanel(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, label: string, color: string) {
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, x, y, width, height, 7);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = "750 20px Geist, Arial, sans-serif";
  ctx.fillText(label, x + 18, y + 40);
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

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
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

function measure(ctx: CanvasRenderingContext2D, text: string) {
  return ctx.measureText(text).width;
}
