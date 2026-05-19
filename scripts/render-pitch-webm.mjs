import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const inputPath = process.argv[2];
const baseUrl = process.argv[3] || "http://localhost:3000";

if (!inputPath) {
  console.error("Usage: node scripts/render-pitch-webm.mjs /path/to/final-result.json [baseUrl]");
  process.exit(1);
}

const result = JSON.parse(await readFile(inputPath, "utf8"));
const runId = result.capture?.runId || result.capture?.videoUrl?.match(/\/api\/captures\/([^/]+)\//)?.[1] || `${Date.now()}`;
const outputDir = path.join(tmpdir(), "demomaster-captures", runId);
const outputPath = path.join(outputDir, "pitch.webm");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(120000);
await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

const base64 = await page.evaluate(
  async ({ result, baseUrl }) => {
    document.body.innerHTML = "<canvas id='stage' width='1280' height='720'></canvas>";
    document.body.style.margin = "0";
    document.body.style.background = "#0b0d12";
    function drawFrame(ctx, width, height, result, time, captureMedia) {
      const pitch = result.pitch;
      const scenes = pitch.scenes || [];
      const scene = scenes.find((item) => time >= item.start && time < item.start + item.duration) || scenes.at(-1) || {};
      const local = Math.max(0, time - Number(scene.start || 0));
      const progress = Math.min(1, local / Math.max(1, Number(scene.duration || 1)));

      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#111827");
      gradient.addColorStop(0.45, "#172033");
      gradient.addColorStop(1, "#0f172a");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(48, 44, width - 96, height - 88);

      ctx.fillStyle = "#e5e7eb";
      ctx.font = "700 26px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(pitch.productName || "DemoMaster", 72, 90);
      ctx.font = "500 18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("Generated pitch video", 72, 118);

      const mediaRect = scene.visual === "presenter" || scene.visual === "problem"
        ? { x: 718, y: 142, w: 466, h: 300 }
        : { x: 560, y: 130, w: 624, h: 352 };
      drawMedia(ctx, captureMedia, mediaRect.x, mediaRect.y, mediaRect.w, mediaRect.h);

      const copyX = 72;
      const copyW = scene.visual === "presenter" || scene.visual === "problem" ? 560 : 430;
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 52px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.onScreenText || scene.title || pitch.corePromise || "", copyX, 220, copyW, 60, 3);

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "500 23px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.narration || pitch.positioning || "", 72, 490, 760, 34, 3);

      ctx.fillStyle = "rgba(59,130,246,0.95)";
      ctx.fillRect(72, 624, (width - 144) * progress, 6);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(72 + (width - 144) * progress, 624, (width - 144) * (1 - progress), 6);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 16px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(`${scene.title || "Scene"} · ${Math.round(time)}s`, 72, 662);
    }

    function drawMedia(ctx, media, x, y, w, h) {
      ctx.save();
      ctx.fillStyle = "#020617";
      roundRect(ctx, x, y, w, h, 16);
      ctx.fill();
      ctx.clip();
      if (media) {
        const sourceW = media.videoWidth || media.naturalWidth || w;
        const sourceH = media.videoHeight || media.naturalHeight || h;
        const scale = Math.min(w / sourceW, h / sourceH);
        const drawW = sourceW * scale;
        const drawH = sourceH * scale;
        ctx.drawImage(media, x + (w - drawW) / 2, y + (h - drawH) / 2, drawW, drawH);
      } else {
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "700 22px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText("Demo capture", x + 34, y + 64);
      }
      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, 16);
      ctx.stroke();
    }

    function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
      const words = String(text).split(/\s+/).filter(Boolean);
      let line = "";
      let lines = 0;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          ctx.fillText(line, x, y + lines * lineHeight);
          line = word;
          lines += 1;
          if (lines >= maxLines) return;
        } else {
          line = test;
        }
      }
      if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
    }

    function roundRect(ctx, x, y, w, h, radius) {
      const r = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function loadVideo(src) {
      return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.onloadeddata = () => resolve(video);
        video.onerror = () => reject(new Error("Video failed to load."));
        video.src = src;
      });
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Image failed to load."));
        image.src = src;
      });
    }

    function pickMimeType() {
      return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      ) || "";
    }

    function arrayBufferToBase64(buffer) {
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    const canvas = document.getElementById("stage");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable.");

    const width = canvas.width;
    const height = canvas.height;
    const scenes = result.pitch.scenes || [];
    const duration = scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0) || 55;
    const captureUrl = result.capture?.videoUrl || result.capture?.screenshotUrl || "";
    const absoluteCaptureUrl = captureUrl ? new URL(captureUrl, baseUrl).toString() : "";

    const captureVideo = absoluteCaptureUrl && result.capture?.videoUrl ? await loadVideo(absoluteCaptureUrl).catch(() => null) : null;
    const captureImage = !captureVideo && absoluteCaptureUrl ? await loadImage(absoluteCaptureUrl).catch(() => null) : null;
    if (captureVideo) {
      captureVideo.loop = true;
      captureVideo.muted = true;
      await captureVideo.play().catch(() => undefined);
    }

    const stream = canvas.captureStream(30);
    const audioContext = result.audio?.dataUrl ? new AudioContext() : null;
    let source = null;
    if (audioContext && result.audio?.dataUrl) {
      const buffer = await fetch(result.audio.dataUrl)
        .then((response) => response.arrayBuffer())
        .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer));
      const destination = audioContext.createMediaStreamDestination();
      source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }

    const chunks = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    });

    recorder.start(250);
    source?.start();

    const started = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        const time = Math.min(duration, (now - started) / 1000);
        drawFrame(ctx, width, height, result, time, captureVideo || captureImage);
        if (time >= duration) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    source?.stop();
    captureVideo?.pause();
    recorder.stop();
    const blob = await stopped;
    await audioContext?.close();
    const buffer = await blob.arrayBuffer();
    return arrayBufferToBase64(buffer);
  },
  { result, baseUrl },
);

await writeFile(outputPath, Buffer.from(base64, "base64"));
await writeFile(path.join(outputDir, "pitch-result.json"), JSON.stringify(result, null, 2));
await browser.close();

console.log(JSON.stringify({
  runId,
  outputPath,
  url: `/api/captures/${runId}/pitch.webm`,
}, null, 2));
