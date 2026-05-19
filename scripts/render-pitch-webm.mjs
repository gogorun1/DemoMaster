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
const renderOriginUrl = result.capture?.screenshotUrl ? new URL(result.capture.screenshotUrl, baseUrl).toString() : baseUrl;
await page.goto(renderOriginUrl, { waitUntil: "domcontentloaded" });

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
      const isDemoScene = ["product", "workflow", "evidence"].includes(scene.visual);

      if (captureMedia && isDemoScene) {
        drawFullscreenDemo(ctx, width, height, result, scene, time, progress, captureMedia);
        return;
      }

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

      ctx.fillStyle = "#ffffff";
      ctx.font = "850 64px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.onScreenText || scene.title || pitch.corePromise || "", 72, 230, 900, 72, 3);

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "550 25px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.narration || pitch.positioning || "", 72, 494, 960, 36, 3);

      ctx.fillStyle = "rgba(59,130,246,0.95)";
      ctx.fillRect(72, 624, (width - 144) * progress, 6);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(72 + (width - 144) * progress, 624, (width - 144) * (1 - progress), 6);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 16px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(`${scene.title || "Scene"} · ${Math.round(time)}s`, 72, 662);
    }

    function drawFullscreenDemo(ctx, width, height, result, scene, time, progress, media) {
      drawImageCover(ctx, media, 0, 0, width, height);

      const topGradient = ctx.createLinearGradient(0, 0, 0, 150);
      topGradient.addColorStop(0, "rgba(15,23,42,0.82)");
      topGradient.addColorStop(1, "rgba(15,23,42,0)");
      ctx.fillStyle = topGradient;
      ctx.fillRect(0, 0, width, 150);

      const bottomGradient = ctx.createLinearGradient(0, height - 300, 0, height);
      bottomGradient.addColorStop(0, "rgba(15,23,42,0)");
      bottomGradient.addColorStop(0.36, "rgba(15,23,42,0.72)");
      bottomGradient.addColorStop(1, "rgba(15,23,42,0.94)");
      ctx.fillStyle = bottomGradient;
      ctx.fillRect(0, height - 300, width, 300);

      ctx.fillStyle = "rgba(15,23,42,0.72)";
      roundRect(ctx, 48, 34, width - 96, 58, 10);
      ctx.fill();
      ctx.fillStyle = "#f8fafc";
      ctx.font = "750 26px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(result.pitch.productName || "Demo", 72, 71);
      ctx.fillStyle = "#bfdbfe";
      ctx.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.fillText("FULLSCREEN DEMO", width - 72, 70);
      ctx.textAlign = "left";

      ctx.fillStyle = "rgba(15,23,42,0.78)";
      roundRect(ctx, 48, height - 220, Math.min(1000, width - 96), 146, 10);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.stroke();

      ctx.fillStyle = "#bfdbfe";
      ctx.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText((scene.title || "Demo").toUpperCase(), 72, height - 184);
      ctx.fillStyle = "#ffffff";
      ctx.font = "850 36px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.onScreenText || scene.beat || "Recorded product flow", 72, height - 136, 930, 40, 2);

      ctx.fillStyle = "#dbeafe";
      ctx.font = "600 19px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      wrapText(ctx, scene.narration || "", 72, height - 58, width - 220, 24, 2);

      ctx.fillStyle = "rgba(255,255,255,0.2)";
      roundRect(ctx, 48, height - 18, width - 96, 6, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(59,130,246,0.96)";
      roundRect(ctx, 48, height - 18, (width - 96) * progress, 6, 3);
      ctx.fill();

      const total = (result.pitch.scenes || []).reduce((sum, item) => sum + Number(item.duration || 0), 0) || 1;
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "650 14px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(Math.min(time, total))}s / ${Math.round(total)}s`, width - 48, height - 54);
      ctx.textAlign = "left";
    }

    function drawImageCover(ctx, media, x, y, w, h) {
      const sourceW = media.videoWidth || media.naturalWidth || w;
      const sourceH = media.videoHeight || media.naturalHeight || h;
      const scale = Math.max(w / sourceW, h / sourceH);
      const sw = w / scale;
      const sh = h / scale;
      const sx = (sourceW - sw) / 2;
      const sy = (sourceH - sh) / 2;
      ctx.drawImage(media, sx, sy, sw, sh, x, y, w, h);
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

    function syncCaptureVideo(video, scenes, time, playbackState) {
      if (!video) return;
      const scene = scenes.find((item) => time >= item.start && time < item.start + item.duration) || scenes.at(-1) || {};
      if (!["product", "workflow", "evidence"].includes(scene.visual)) {
        video.pause();
        playbackState.active = false;
        if (time < getDemoWindow(scenes).start && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime > 0.1) video.currentTime = 0;
        return;
      }

      if (Number.isFinite(video.duration) && video.duration > 0) {
        const demoWindow = getDemoWindow(scenes);
        const demoDuration = Math.max(1, demoWindow.end - demoWindow.start);
        video.playbackRate = Math.max(0.1, Math.min(1, video.duration / demoDuration));
        if (!playbackState.active) {
          video.currentTime = getDemoPlaybackTime(scenes, time, video.duration);
          playbackState.active = true;
        }
      }
      video.play().catch(() => undefined);
    }

    function getDemoPlaybackTime(scenes, time, mediaDuration) {
      const { start, end } = getDemoWindow(scenes);
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return 0;
      const progress = Math.min(1, Math.max(0, (time - start) / Math.max(1, end - start)));
      return Math.min(mediaDuration - 0.05, Math.max(0, progress * mediaDuration));
    }

    function getDemoWindow(scenes) {
      const demoScenes = scenes.filter((item) => ["product", "workflow", "evidence"].includes(item.visual));
      if (!demoScenes.length) return { start: 0, end: 1 };
      const start = Number(demoScenes[0].start || 0);
      const last = demoScenes[demoScenes.length - 1];
      return { start, end: Number(last.start || 0) + Number(last.duration || 0) };
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
      captureVideo.pause();
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
    const playbackState = { active: false };
    await new Promise((resolve) => {
      const frame = (now) => {
        const time = Math.min(duration, (now - started) / 1000);
        syncCaptureVideo(captureVideo, scenes, time, playbackState);
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
