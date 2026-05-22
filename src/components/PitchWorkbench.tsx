"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Mic2,
  Pause,
  Play,
  RefreshCcw,
  Sparkles,
  Trophy,
  Video,
  Wand2,
} from "lucide-react";
import { VideoCanvas } from "@/components/VideoCanvas";
import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { normalizePitchTimeline } from "@/lib/project-edits";
import { normalizePitchSettings, voicePresets } from "@/lib/project-settings";
import { drawPitchFrame, getPresentationMediaTime, getSceneAtTime, getTotalDuration, shouldPlayPresentationMedia } from "@/lib/render-frame";
import type { DemoCaptureResult, PitchResponse, ProjectMediaAsset, VoiceSettings } from "@/lib/types";

const sampleAppUrl = "https://demo-master-red.vercel.app";
const durationOptions = [30, 45, 60, 90] as const;

type DirectorStage = "idle" | "scouting" | "recording" | "planning" | "narrating" | "rendering" | "ready" | "error";

const directorSteps: Array<{ id: DirectorStage; label: string }> = [
  { id: "scouting", label: "Scout" },
  { id: "recording", label: "Record" },
  { id: "planning", label: "Flow" },
  { id: "narrating", label: "Voice" },
  { id: "rendering", label: "Render" },
  { id: "ready", label: "Ready" },
];

type DemoDirectorStreamEvent =
  | { type: "status"; stage: DirectorStage; message: string }
  | { type: "complete"; response: PitchResponse }
  | { type: "error"; message: string };

type LoadedMedia = HTMLImageElement | HTMLVideoElement;

interface ExportMediaSet {
  defaultMedia?: LoadedMedia;
  assets: Map<string, LoadedMedia>;
}

interface ExportMediaSelection {
  key: string;
  media?: LoadedMedia;
}

export function PitchWorkbench() {
  const [appUrl, setAppUrl] = useState(sampleAppUrl);
  const [targetDuration, setTargetDuration] = useState(60);
  const [voiceName, setVoiceName] = useState("Kore");
  const [voiceTone, setVoiceTone] = useState<VoiceSettings["tone"]>("warm");
  const [voicePacing, setVoicePacing] = useState<VoiceSettings["pacing"]>("measured");
  const [result, setResult] = useState<PitchResponse | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [stage, setStage] = useState<DirectorStage>("idle");
  const [statusMessage, setStatusMessage] = useState("Paste a live app URL to start.");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const totalDuration = useMemo(() => (result ? getTotalDuration(result.pitch) : 0), [result]);
  const activeMediaAsset = useMemo(() => getActiveMediaAsset(result, currentTime), [currentTime, result]);
  const currentScene = useMemo(() => (result ? getSceneAtTime(result.pitch, currentTime) : undefined), [currentTime, result]);
  const isRunActive = isGenerating && stage !== "ready";
  const heroStatus = isExporting ? "Exporting video" : isRunActive ? stageLabel(stage) : result ? "Ready to export" : "Ready";

  useEffect(() => {
    document.documentElement.dataset.demomasterHydrated = "true";
  }, []);

  useEffect(() => {
    if (!isGenerating) return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  useEffect(() => {
    if (!isPlaying || !result) return;

    let frame = 0;
    const audio = audioRef.current;
    const startedAt = performance.now() - currentTime * 1000;

    const tick = () => {
      const nextTime = Math.min(totalDuration, Math.max(0, (performance.now() - startedAt) / 1000));
      setCurrentTime(nextTime);
      if (nextTime >= totalDuration) {
        setIsPlaying(false);
        audio?.pause();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [currentTime, isPlaying, result, totalDuration]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isGenerating) return;
    await startGeneration();
  }

  async function startGeneration() {
    if (isGenerating) return;
    setIsGenerating(true);
    setStage("scouting");
    setStatusMessage("Opening the live app.");
    setElapsedSeconds(0);
    setError("");
    setExportUrl("");
    setIsPlaying(false);
    setCurrentTime(0);
    setResult(null);

    try {
      const response = await fetch("/api/demo-director/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appUrl, targetDuration, voiceName, voiceTone, voicePacing }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Demo generation failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: PitchResponse | null = null;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as DemoDirectorStreamEvent;
          if (event.type === "status") {
            setStage(event.stage);
            setStatusMessage(event.message);
          }
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "complete") finalResult = event.response;
        }

        if (done) break;
      }

      if (!finalResult) throw new Error("The director run ended before returning a video plan.");
      setResult(normalizePitchResult(finalResult));
      setStage("ready");
      setStatusMessage("Preview is ready.");
    } catch (generationError) {
      setStage("error");
      setError(generationError instanceof Error ? generationError.message : "Demo generation failed.");
      setStatusMessage("Needs attention.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function togglePlayback() {
    if (!result) return;
    const audio = audioRef.current;
    if (isPlaying) {
      audio?.pause();
      setIsPlaying(false);
      return;
    }

    if (audio && result.audio.status === "ready") {
      audio.currentTime = Math.min(currentTime, Math.max(0, (audio.duration || totalDuration) - 0.2));
      await audio.play().catch(() => undefined);
    }
    setIsPlaying(true);
  }

  function scrub(value: string) {
    const next = Number(value);
    setCurrentTime(next);
    if (audioRef.current) audioRef.current.currentTime = next;
  }

  async function exportVideo() {
    if (!result) return;
    setIsExporting(true);
    setExportUrl("");

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas rendering is not available.");

      const mimeType = pickRecordingMimeType();
      const stream = canvas.captureStream(30);
      const audioContext = result.audio.dataUrl ? new AudioContext() : null;
      let source: AudioBufferSourceNode | null = null;

      if (audioContext && result.audio.dataUrl) {
        const audioBuffer = await fetch(result.audio.dataUrl)
          .then((audioResponse) => audioResponse.arrayBuffer())
          .then((buffer) => audioContext.decodeAudioData(buffer));
        const destination = audioContext.createMediaStreamDestination();
        source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(destination);
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      }

      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      const stopped = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
      });

      recorder.start();
      source?.start();
      const exportMedia = await loadExportMediaSet(result.capture, result.pitch);
      await drawExportFrames(context, result, totalDuration, exportMedia);
      source?.stop();
      recorder.stop();

      const blob = await stopped;
      setExportUrl(URL.createObjectURL(blob));
      await audioContext?.close();
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <main className="app-shell" data-demomaster-root>
      <section className="topbar">
        <div className="brand-lockup">
          <div className="mark">
            <Trophy size={20} />
          </div>
          <div>
            <h1>DemoMaster</h1>
            <p>Live app URL to narrated demo video</p>
          </div>
        </div>
        <span className="status-pill">
          <span className={isRunActive ? "status-dot pulse" : stage === "error" ? "status-dot fallback" : "status-dot"} />
          {heroStatus}
        </span>
      </section>

      <div className="workspace director-workspace">
        <aside className="sidebar">
          <form className="repo-form director-form" onSubmit={handleSubmit}>
            <label className="field">
              <span>Live app URL</span>
              <input
                data-demomaster-repo-input
                value={appUrl}
                onChange={(event) => setAppUrl(event.target.value)}
                placeholder="https://app.example.com"
                spellCheck={false}
              />
            </label>

            <div className="duration-control">
              <span>Video length</span>
              <div className="duration-options" role="group" aria-label="Target video length">
                {durationOptions.map((duration) => (
                  <button
                    className={targetDuration === duration ? "duration-option active" : "duration-option"}
                    type="button"
                    key={duration}
                    onClick={() => setTargetDuration(duration)}
                  >
                    {duration}s
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-grid compact-settings">
              <label className="field compact-field">
                <span>Voice</span>
                <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>
                  {voicePresets.map((voice) => (
                    <option value={voice} key={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field compact-field">
                <span>Style</span>
                <select value={voiceTone} onChange={(event) => setVoiceTone(event.target.value as VoiceSettings["tone"])}>
                  <option value="warm">Warm</option>
                  <option value="clear">Clear</option>
                  <option value="energetic">Energetic</option>
                  <option value="executive">Executive</option>
                </select>
              </label>
              <label className="field compact-field">
                <span>Pacing</span>
                <select value={voicePacing} onChange={(event) => setVoicePacing(event.target.value as VoiceSettings["pacing"])}>
                  <option value="calm">Calm</option>
                  <option value="measured">Measured</option>
                  <option value="brisk">Brisk</option>
                </select>
              </label>
            </div>

            <div className="button-row">
              <button className="btn primary" type="submit" disabled={isGenerating} data-demomaster-generate>
                {isGenerating ? <Loader2 size={17} className="spin" /> : <Sparkles size={17} />}
                Generate demo
              </button>
              <button className="icon-btn" type="button" onClick={() => setAppUrl(sampleAppUrl)} title="Use sample app">
                <RefreshCcw size={17} />
              </button>
            </div>

            {error ? <div className="notice error">{error}</div> : null}
            {result?.warnings.length ? <details className="compact-details"><summary>Warnings</summary><p>{result.warnings.join(" ")}</p></details> : null}
          </form>

          <section className="panel compact">
            <div className="panel-heading">
              <Wand2 size={18} />
              <h2>Director run</h2>
            </div>
            <DirectorProgress stage={stage} isGenerating={isRunActive} elapsedSeconds={elapsedSeconds} message={statusMessage} result={result} />
          </section>
        </aside>

        <section className="main" data-demomaster-output>
          {result ? (
            <section className="director-grid">
              <div className="preview-column">
                <section className="stage video-stage">
                  <div className="canvas-wrap">
                    <VideoCanvas plan={result.pitch} currentTime={currentTime} capture={result.capture} mediaAsset={activeMediaAsset} />
                  </div>

                  <div className="stage-controls">
                    <div className="button-row">
                      <button className="btn primary" type="button" onClick={togglePlayback}>
                        {isPlaying ? <Pause size={17} /> : <Play size={17} />}
                        {isPlaying ? "Pause" : "Play"}
                      </button>
                      <button className="btn" type="button" onClick={exportVideo} disabled={isExporting}>
                        {isExporting ? <Loader2 size={17} className="spin" /> : <Download size={17} />}
                        Export video
                      </button>
                    </div>
                    <div className="scrubber">
                      <span className="timecode">{formatTime(currentTime)}</span>
                      <input type="range" min="0" max={totalDuration} step="0.1" value={currentTime} onChange={(event) => scrub(event.target.value)} />
                      <span className="timecode">{formatTime(totalDuration)}</span>
                    </div>
                  </div>

                  {result.audio.dataUrl ? <audio ref={audioRef} src={result.audio.dataUrl} preload="auto" /> : null}
                  {exportUrl ? (
                    <a className="export-link" href={exportUrl} download={`${slugify(result.pitch.productName)}-demo.webm`}>
                      Download generated demo video
                    </a>
                  ) : null}
                </section>

                {currentScene ? (
                  <div className="scene-strip director-scene-strip">
                    <span className="timecode">{formatTime(currentScene.start)}</span>
                    <strong>{currentScene.title}</strong>
                    <p>{currentScene.cameraPlan?.focusLabel || currentScene.visualIntent?.targetHint || currentScene.beat}</p>
                  </div>
                ) : null}
              </div>

              <aside className="flow-panel">
                <section className="panel">
                  <div className="panel-heading split-heading">
                    <div>
                      <div className="heading-kicker">Demo flow</div>
                      <h2>{result.pitch.productName}</h2>
                    </div>
                    <span className="small-status ready">{Math.round(totalDuration)}s</span>
                  </div>
                  <ol className="beat-list">
                    {result.pitch.scenes.map((scene) => (
                      <li className={currentScene?.id === scene.id ? "beat-card active" : "beat-card"} key={scene.id}>
                        <div className="beat-time">
                          <span>{formatTime(scene.start)}</span>
                          <strong>{Math.round(scene.duration)}s</strong>
                        </div>
                        <div>
                          <h3>{scene.title}</h3>
                          <p>{scene.narration}</p>
                          <div className="beat-tags">
                            <span>{scene.visual}</span>
                            {scene.cameraPlan?.focusLabel ? <span>{scene.cameraPlan.focusLabel}</span> : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <Mic2 size={18} />
                    <h2>Voice and capture</h2>
                  </div>
                  <div className="metric-grid">
                    <Metric label="Voice" value={result.pitch.voiceSettings?.voiceName || voiceName} />
                    <Metric label="Narration" value={result.audio.status} />
                    <Metric label="Capture" value={result.capture?.status || "skipped"} />
                    <Metric label="Scenes" value={String(result.pitch.scenes.length)} />
                  </div>
                  <div className="capture-links compact-links">
                    {result.capture?.targetUrl ? (
                      <a href={result.capture.targetUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={14} />
                        Open app
                      </a>
                    ) : null}
                    {result.capture?.videoUrl ? (
                      <a href={result.capture.videoUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={14} />
                        Raw footage
                      </a>
                    ) : null}
                  </div>
                </section>
              </aside>
            </section>
          ) : (
            <section className="empty-state director-empty">
              <div>
                <Video size={38} />
                <h2>Video preview</h2>
                <p>Enter a live app URL. DemoMaster will scout the product, record a browser flow, write a timed script, generate voice, and add zoom/highlight direction.</p>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

function DirectorProgress({
  stage,
  isGenerating,
  elapsedSeconds,
  message,
  result,
}: {
  stage: DirectorStage;
  isGenerating: boolean;
  elapsedSeconds: number;
  message: string;
  result: PitchResponse | null;
}) {
  const activeIndex = directorSteps.findIndex((step) => step.id === stage);
  const safeActiveIndex = activeIndex === -1 ? (result ? directorSteps.length - 1 : 0) : activeIndex;

  return (
    <div className="generation-progress">
      <div className="live-run-head">
        <span>{isGenerating ? message : result ? "Ready to preview and export." : message}</span>
        <strong>{isGenerating ? formatDuration(elapsedSeconds) : result ? "done" : "idle"}</strong>
      </div>
      <ol className="stage-steps">
        {directorSteps.map((step, index) => {
          const status =
            stage === "error"
              ? index <= safeActiveIndex
                ? "error"
                : "waiting"
              : index < safeActiveIndex || (!isGenerating && result && step.id === "ready")
                ? "done"
                : index === safeActiveIndex && isGenerating
                  ? "running"
                  : index === safeActiveIndex && result
                    ? "done"
                    : "waiting";
          return (
            <li className={`stage-step ${status}`} key={step.id}>
              <span>{status === "running" ? <Loader2 size={13} className="spin" /> : status === "done" ? <CheckCircle2 size={13} /> : null}</span>
              <strong>{step.label}</strong>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function normalizePitchResult(result: PitchResponse): PitchResponse {
  return {
    ...result,
    capture: ensureCaptureManifest(result.capture),
    pitch: normalizePitchSettings(normalizePitchTimeline(result.pitch)),
  };
}

function getActiveMediaAsset(result: PitchResponse | null, currentTime: number) {
  if (!result?.pitch.mediaAssets?.length) return undefined;
  const scene = getSceneAtTime(result.pitch, currentTime);
  const sceneAsset = scene.mediaAssetId ? getMediaAssetById(result.pitch.mediaAssets, scene.mediaAssetId) : undefined;
  return sceneAsset || getMediaAssetById(result.pitch.mediaAssets, result.pitch.activeMediaAssetId);
}

function getMediaAssetById(assets: ProjectMediaAsset[] | undefined, assetId?: string) {
  return assetId ? assets?.find((asset) => asset.id === assetId) : undefined;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "demomaster"
  );
}

async function loadCaptureImage(url?: string) {
  if (!url) return undefined;
  try {
    const image = new Image();
    image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not load capture image."));
      image.src = url;
    });
    return image;
  } catch {
    return undefined;
  }
}

async function loadCaptureMedia(capture?: DemoCaptureResult, mediaAsset?: ProjectMediaAsset) {
  const videoUrl = mediaAsset?.type === "video" ? mediaAsset.dataUrl : capture?.videoUrl;
  const imageUrl = mediaAsset?.type === "image" ? mediaAsset.dataUrl : capture?.screenshotUrl;

  if (videoUrl) {
    try {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Could not load capture video."));
        video.src = videoUrl;
      });
      await seekCaptureVideoFrame(video, 0.05);
      return video;
    } catch {
      return loadCaptureImage(imageUrl);
    }
  }

  return loadCaptureImage(imageUrl);
}

async function loadExportMediaSet(capture: DemoCaptureResult | undefined, pitch: PitchResponse["pitch"]): Promise<ExportMediaSet> {
  const defaultMedia = await loadCaptureMedia(capture);
  const assets = new Map<string, LoadedMedia>();

  await Promise.all(
    (pitch.mediaAssets || []).map(async (asset) => {
      const media = await loadCaptureMedia(capture, asset);
      if (media) assets.set(asset.id, media);
    }),
  );

  return { defaultMedia, assets };
}

async function seekCaptureVideoFrame(video: HTMLVideoElement, time: number) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
  await new Promise<void>((resolve) => {
    const done = () => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => resolve());
      } else {
        requestAnimationFrame(() => resolve());
      }
    };
    if (Math.abs(video.currentTime - target) < 0.03 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      done();
      return;
    }
    video.addEventListener("seeked", done, { once: true });
    video.currentTime = target;
  });
}

async function drawExportFrames(context: CanvasRenderingContext2D, result: PitchResponse, duration: number, exportMedia: ExportMediaSet) {
  pauseInactiveExportVideos(exportMedia);
  const startedAt = performance.now();
  const playbackStates = new Map<string, { active: boolean; lastTime: number; sceneId?: string }>();
  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const elapsed = Math.min(duration, (now - startedAt) / 1000);
      const selection = selectExportMedia(result, elapsed, exportMedia);
      const captureVideo = selection.media instanceof HTMLVideoElement ? selection.media : undefined;
      pauseInactiveExportVideos(exportMedia, selection.key);
      if (captureVideo) {
        const state = playbackStates.get(selection.key) || { active: false, lastTime: 0 };
        syncExportVideo(captureVideo, result.pitch, elapsed, state);
        playbackStates.set(selection.key, state);
      }
      drawPitchFrame(context, result.pitch, elapsed, drawableExportMedia(selection.media));
      if (elapsed >= duration) resolve();
      else requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
  pauseInactiveExportVideos(exportMedia);
}

function selectExportMedia(result: PitchResponse, currentTime: number, exportMedia: ExportMediaSet): ExportMediaSelection {
  const scene = getSceneAtTime(result.pitch, currentTime);
  if (scene.mediaAssetId) {
    const media = exportMedia.assets.get(scene.mediaAssetId);
    if (media) return { key: `asset:${scene.mediaAssetId}`, media };
  }

  if (result.pitch.activeMediaAssetId) {
    const media = exportMedia.assets.get(result.pitch.activeMediaAssetId);
    if (media) return { key: `asset:${result.pitch.activeMediaAssetId}`, media };
  }

  return { key: "default", media: exportMedia.defaultMedia };
}

function pauseInactiveExportVideos(exportMedia: ExportMediaSet, activeKey?: string) {
  if (exportMedia.defaultMedia instanceof HTMLVideoElement && activeKey !== "default") exportMedia.defaultMedia.pause();
  for (const [assetId, media] of exportMedia.assets) {
    if (media instanceof HTMLVideoElement && activeKey !== `asset:${assetId}`) media.pause();
  }
}

function drawableExportMedia(media: LoadedMedia | undefined) {
  if (!(media instanceof HTMLVideoElement)) return media;
  return media.videoWidth > 0 && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? media : undefined;
}

function syncExportVideo(
  video: HTMLVideoElement,
  plan: PitchResponse["pitch"],
  currentTime: number,
  playbackState: { active: boolean; lastTime: number; sceneId?: string },
) {
  const scene = getSceneAtTime(plan, currentTime);
  const shouldPlay = shouldPlayPresentationMedia(plan, currentTime);
  const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
  const targetTime = hasDuration ? getPresentationMediaTime(plan, currentTime, video.duration) : 0;

  if (!shouldPlay) {
    video.pause();
    playbackState.active = false;
    playbackState.sceneId = undefined;
    playbackState.lastTime = currentTime;
    if (hasDuration && Math.abs(video.currentTime - targetTime) > 0.08) video.currentTime = targetTime;
    return;
  }

  if (hasDuration) {
    const trimStart = Math.min(Math.max(0, scene.trimStart ?? 0), Math.max(0, video.duration - 0.05));
    const trimEnd = scene.trimEnd !== undefined && scene.trimEnd > trimStart ? Math.min(scene.trimEnd, video.duration) : video.duration;
    const mediaSpan = Math.max(1, trimEnd - trimStart);
    video.playbackRate = Math.max(0.1, Math.min(2, mediaSpan / Math.max(1, scene.duration)));
    if (!playbackState.active || playbackState.sceneId !== scene.id || currentTime < playbackState.lastTime) {
      video.currentTime = targetTime;
      playbackState.active = true;
      playbackState.sceneId = scene.id;
    }
  }
  playbackState.lastTime = currentTime;
  void video.play().catch(() => undefined);
}

function pickRecordingMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function stageLabel(value: DirectorStage) {
  if (value === "scouting") return "Scouting app";
  if (value === "recording") return "Recording flow";
  if (value === "planning") return "Planning script";
  if (value === "narrating") return "Generating voice";
  if (value === "rendering") return "Preparing render";
  if (value === "ready") return "Ready";
  if (value === "error") return "Needs attention";
  return "Ready";
}

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(value: number) {
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, "0")}s`;
}
