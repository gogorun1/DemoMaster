"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Camera,
  CheckCircle2,
  Code2,
  Download,
  ExternalLink,
  FileText,
  ImagePlus,
  Loader2,
  Mic2,
  Pause,
  Play,
  Redo2,
  RefreshCcw,
  Save,
  Sparkles,
  Timer,
  Trophy,
  Undo2,
  Upload,
  Volume2,
} from "lucide-react";
import { VideoCanvas } from "@/components/VideoCanvas";
import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { applyProjectEditOperation, normalizePitchTimeline } from "@/lib/project-edits";
import { captionStyles, deckDensities, deckThemes, normalizeDeckStyle, normalizePitchSettings, normalizeVoiceSettings, voicePresets } from "@/lib/project-settings";
import { drawPitchFrame, getSceneAtTime, getSceneMediaPlaybackTime, getTotalDuration, isDemoScene } from "@/lib/render-frame";
import { buildRenderScript } from "@/lib/render-script";
import type { AgentLog, AgentLogEntry, AgentName, DemoCaptureManifest, DemoCaptureResult, PitchResponse, PitchScene, ProjectMediaAsset, VisualMode } from "@/lib/types";

const sampleRepo = "https://github.com/vercel/ai-chatbot";
const projectSchema = "demomaster.project";
const projectVersion = 1;
const visualModes: VisualMode[] = ["presenter", "problem", "product", "workflow", "evidence", "close"];
type GenerationStage = "idle" | "understanding" | "capturing" | "aligning" | "preparing" | "ready" | "error";
type InspectorTab = "script" | "media" | "style" | "voice" | "export";

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "script", label: "Script" },
  { id: "media", label: "Media" },
  { id: "style", label: "Style" },
  { id: "voice", label: "Voice" },
  { id: "export", label: "Export" },
];

const generationSteps: Array<{ id: GenerationStage; label: string }> = [
  { id: "understanding", label: "Pitch" },
  { id: "capturing", label: "Capture" },
  { id: "aligning", label: "Align" },
  { id: "preparing", label: "Preview" },
  { id: "ready", label: "Ready" },
];

const liveRunSteps: Array<{ agent: AgentName; label: string; detail: string }> = [
  {
    agent: "Repo Forensics Agent",
    label: "Inspect repo",
    detail: "Reading high-signal files and extracting product evidence.",
  },
  {
    agent: "Pitch Strategy Agent",
    label: "Design product flow",
    detail: "Turning repo evidence into user need, positioning, and flow.",
  },
  {
    agent: "Creative Director Agent",
    label: "Write pitch",
    detail: "Writing the storyboard, transcript, and product report.",
  },
  {
    agent: "Demo Capture Agent",
    label: "Plan capture",
    detail: "Choosing public URL capture first, then local runner if needed.",
  },
  {
    agent: "Browser Capture Agent",
    label: "Record demo",
    detail: "Recording a hosted demo URL or running the repo locally with Playwright.",
  },
  {
    agent: "Open Model Critic Agent",
    label: "Open-model critique",
    detail: "Using Featherless to critique specificity and judge-readiness.",
  },
  {
    agent: "Quality Judge Agent",
    label: "Judge quality",
    detail: "Scoring the plan and applying final improvements.",
  },
  {
    agent: "Capture Alignment Agent",
    label: "Align script",
    detail: "Rewriting the script against the captured UI.",
  },
  {
    agent: "Media Renderer Agent",
    label: "Render voice",
    detail: "Generating narration and preparing the browser video renderer.",
  },
  {
    agent: "Voice QA Agent",
    label: "Verify voice",
    detail: "Checking the narration against the transcript with Speechmatics.",
  },
];

type PitchStreamEvent =
  | { type: "status"; message: string }
  | { type: "agentLog"; log: AgentLog }
  | { type: "complete"; response: PitchResponse }
  | { type: "error"; message: string };

interface EditorSnapshot {
  result: PitchResponse;
  isAudioStale: boolean;
}

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
  const [repoUrl, setRepoUrl] = useState(sampleRepo);
  const [result, setResult] = useState<PitchResponse | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState<GenerationStage>("idle");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("script");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [liveAgentLogs, setLiveAgentLogs] = useState<AgentLog[]>([]);
  const [liveMessage, setLiveMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isAudioRefreshing, setIsAudioRefreshing] = useState(false);
  const [isAudioStale, setIsAudioStale] = useState(false);
  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);
  const [error, setError] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const totalDuration = useMemo(() => (result ? getTotalDuration(result.pitch) : 0), [result]);
  const activeMediaAsset = useMemo(() => getActiveMediaAsset(result, currentTime), [currentTime, result]);
  const currentScene = useMemo(() => (result ? getSceneAtTime(result.pitch, currentTime) : undefined), [currentTime, result]);

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
    const start = performance.now() - currentTime * 1000;

    const tick = () => {
      const nextTime = audio && result.audio.status === "ready" ? audio.currentTime : (performance.now() - start) / 1000;
      if (nextTime >= totalDuration) {
        setCurrentTime(totalDuration);
        setIsPlaying(false);
        audio?.pause();
        return;
      }
      setCurrentTime(nextTime);
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
    setGenerationStage("understanding");
    setElapsedSeconds(0);
    setLiveAgentLogs([]);
    setLiveMessage("Starting agent run.");
    setIsPlaying(false);
    setIsAudioStale(false);
    setUndoStack([]);
    setRedoStack([]);
    setError("");
    setExportUrl("");
    setResult(null);

    try {
      const response = await fetch("/api/pitch/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Generation failed.");
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
          const event = JSON.parse(line) as PitchStreamEvent;
          if (event.type === "status") setLiveMessage(event.message);
          if (event.type === "agentLog") setLiveAgentLogs((logs) => mergeAgentLog(logs, event.log));
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "complete") finalResult = event.response;
        }

        if (done) break;
      }

      if (!finalResult) throw new Error("Generation ended before a pitch response was returned.");
      finalResult = normalizePitchResult(finalResult);
      setResult(finalResult);
      setGenerationStage("capturing");
      finalResult = await runAutomaticCapture(finalResult);
      setGenerationStage("preparing");
      setResult(normalizePitchResult(finalResult));
      setCurrentTime(0);
      setGenerationStage("ready");
    } catch (generationError) {
      setGenerationStage("error");
      setError(generationError instanceof Error ? generationError.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function runAutomaticCapture(baseResult: PitchResponse) {
    let nextResult = baseResult;

    try {
      setGenerationStage("capturing");
      setLiveMessage("Capturing the demo: public URL first, local runner if needed.");
      const captureResponse = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, capturePlan: baseResult.pitch.capturePlan }),
      });
      const captureBody = (await captureResponse.json()) as { capture?: DemoCaptureResult; agentLog?: AgentLog; error?: string };
      if (!captureResponse.ok) throw new Error(captureBody.error || "Could not capture demo.");
      const captureLog = captureBody.agentLog;
      if (captureLog) setLiveAgentLogs((logs) => mergeAgentLog(logs, captureLog));
      nextResult = attachCapture(nextResult, captureBody.capture, captureLog);
      setResult(nextResult);

      if (!captureBody.capture || captureBody.capture.status !== "ready") {
        const message = captureBody.capture?.message || "Demo capture was not available.";
        nextResult = {
          ...nextResult,
          warnings: [...new Set([...nextResult.warnings, message])],
        };
        setResult(nextResult);
        return nextResult;
      }

      setGenerationStage("aligning");
      setLiveMessage("Rewriting the final pitch so the script matches the captured footage.");
      const alignResponse = await fetch("/api/pitch/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pitch: nextResult.pitch, capture: captureBody.capture }),
      });
      const alignBody = (await alignResponse.json()) as {
        pitch?: PitchResponse["pitch"];
        audio?: PitchResponse["audio"];
        voiceQa?: PitchResponse["voiceQa"];
        agentLogs?: AgentLog[];
        error?: string;
      };
      if (!alignResponse.ok || !alignBody.pitch || !alignBody.audio) {
        throw new Error(alignBody.error || "Could not align pitch with captured footage.");
      }
      nextResult = {
        ...nextResult,
        pitch: alignBody.pitch,
        audio: alignBody.audio,
        voiceQa: alignBody.voiceQa,
        agentLogs: mergeAgentLogs(nextResult.agentLogs, alignBody.agentLogs || []),
      };
      setLiveAgentLogs((logs) => mergeAgentLogs(logs, alignBody.agentLogs || []));
      setIsAudioStale(false);
      setResult(normalizePitchResult(nextResult));
      return nextResult;
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : "Demo capture failed.";
      setError(message);
      return {
        ...nextResult,
        warnings: [...new Set([...nextResult.warnings, message])],
      };
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
      await audio.play();
    }
    setIsPlaying(true);
  }

  function scrub(value: string) {
    const next = Number(value);
    setCurrentTime(next);
    if (audioRef.current) audioRef.current.currentTime = next;
  }

  function updateScene(sceneId: string, patch: Partial<PitchScene>) {
    if (!result) return;
    commitEditableResult(
      {
        ...result,
        pitch: applyProjectEditOperation(result.pitch, {
          type: "update-scene",
          sceneId,
          patch,
        }),
      },
      { audioStale: shouldScenePatchInvalidateAudio(patch) },
    );
  }

  function commitEditableResult(nextResult: PitchResponse, options: { audioStale?: boolean } = {}) {
    if (!result) return;
    setUndoStack((stack) => [...stack.slice(-19), { result, isAudioStale }]);
    setRedoStack([]);
    setResult(normalizePitchResult(nextResult));
    setIsAudioStale(options.audioStale ?? true);
    setExportUrl("");
  }

  function updatePitch(pitch: PitchResponse["pitch"], options: { audioStale?: boolean } = {}) {
    if (!result) return;
    commitEditableResult({ ...result, pitch }, options);
  }

  function scaleVideoDuration(targetDuration: number) {
    if (!result) return;
    updatePitch(
      applyProjectEditOperation(result.pitch, {
        type: "scale-duration",
        targetDuration,
      }),
      { audioStale: true },
    );
  }

  function updateVoiceSetting(patch: Partial<NonNullable<PitchResponse["pitch"]["voiceSettings"]>>) {
    if (!result) return;
    updatePitch(
      {
        ...result.pitch,
        voiceSettings: normalizeVoiceSettings({
          ...result.pitch.voiceSettings,
          ...patch,
        }),
      },
      { audioStale: true },
    );
  }

  function updateDeckStyle(patch: Partial<NonNullable<PitchResponse["pitch"]["deckStyle"]>>) {
    if (!result) return;
    updatePitch(
      {
        ...result.pitch,
        deckStyle: normalizeDeckStyle({
          ...result.pitch.deckStyle,
          ...patch,
        }),
      },
      { audioStale: isAudioStale },
    );
  }

  async function importMediaAsset(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !result) return;

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const type = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : undefined;
      if (!type) throw new Error("Upload a video or image file.");
      const asset: ProjectMediaAsset = {
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        name: file.name,
        mimeType: file.type,
        dataUrl,
        createdAt: new Date().toISOString(),
      };
      updatePitch(
        {
          ...result.pitch,
          mediaAssets: [...(result.pitch.mediaAssets || []), asset],
          activeMediaAssetId: asset.id,
        },
        { audioStale: isAudioStale },
      );
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : "Could not import media asset.");
    }
  }

  async function importMediaAssetUrl() {
    if (!result) return;
    const url = mediaUrl.trim();
    if (!url) return;

    try {
      setError("");
      const response = await fetch("/api/media/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await response.json()) as {
        type?: ProjectMediaAsset["type"];
        name?: string;
        mimeType?: string;
        dataUrl?: string;
        error?: string;
      };
      if (!response.ok || !body.type || !body.dataUrl || !body.mimeType || !body.name) {
        throw new Error(body.error || "Could not import media URL.");
      }
      const asset: ProjectMediaAsset = {
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: body.type,
        name: body.name,
        mimeType: body.mimeType,
        dataUrl: body.dataUrl,
        createdAt: new Date().toISOString(),
      };
      updatePitch(
        {
          ...result.pitch,
          mediaAssets: [...(result.pitch.mediaAssets || []), asset],
          activeMediaAssetId: asset.id,
        },
        { audioStale: isAudioStale },
      );
      setMediaUrl("");
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : "Could not import media URL.");
    }
  }

  function setActiveMediaAsset(assetId: string) {
    if (!result) return;
    updatePitch(
      {
        ...result.pitch,
        activeMediaAssetId: assetId || undefined,
      },
      { audioStale: isAudioStale },
    );
  }

  function undoEdit() {
    const previous = undoStack.at(-1);
    if (!previous || !result) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack.slice(-19), { result, isAudioStale }]);
    setResult(previous.result);
    setIsAudioStale(previous.isAudioStale);
    setExportUrl("");
  }

  function redoEdit() {
    const next = redoStack.at(-1);
    if (!next || !result) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack.slice(-19), { result, isAudioStale }]);
    setResult(next.result);
    setIsAudioStale(next.isAudioStale);
    setExportUrl("");
  }

  async function refreshNarration() {
    if (!result || isAudioRefreshing) return;
    setIsAudioRefreshing(true);
    setError("");

    try {
      const response = await fetch("/api/pitch/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pitch: result.pitch }),
      });
      const body = (await response.json()) as {
        pitch?: PitchResponse["pitch"];
        audio?: PitchResponse["audio"];
        voiceQa?: PitchResponse["voiceQa"];
        agentLogs?: AgentLog[];
        error?: string;
      };
      if (!response.ok || !body.pitch || !body.audio) throw new Error(body.error || "Could not regenerate narration.");
      const nextPitch = body.pitch;
      const nextAudio = body.audio;

      setResult((current) =>
        current
          ? normalizePitchResult({
              ...current,
              pitch: nextPitch,
              audio: nextAudio,
              voiceQa: body.voiceQa,
              agentLogs: mergeAgentLogs(current.agentLogs, body.agentLogs || []),
            })
          : current,
      );
      setLiveAgentLogs((logs) => mergeAgentLogs(logs, body.agentLogs || []));
      setIsAudioStale(false);
      setCurrentTime(0);
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : "Could not regenerate narration.");
    } finally {
      setIsAudioRefreshing(false);
    }
  }

  function exportProject() {
    if (!result) return;
    const project = {
      schema: projectSchema,
      version: projectVersion,
      exportedAt: new Date().toISOString(),
      result: normalizePitchResult(result),
      renderScript: buildRenderScript(result.pitch, result.capture),
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(result.pitch.productName || "demomaster")}-project.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const imported = readProjectResult(payload);
      const normalized = normalizePitchResult(imported);
      setResult(normalized);
      setRepoUrl(normalized.repo.repoUrl);
      setCurrentTime(0);
      setIsPlaying(false);
      setIsAudioStale(false);
      setUndoStack([]);
      setRedoStack([]);
      setExportUrl("");
      setError("");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not import project JSON.");
    }
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
          .then((response) => response.arrayBuffer())
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

  const heroStatus = isExporting
    ? "Exporting video"
    : isAudioRefreshing
      ? "Regenerating voice"
      : isGenerating
        ? generationLabel(generationStage)
        : result
          ? "Ready to edit/export"
          : "Ready";

  return (
    <main className="app-shell" data-demomaster-root>
      <section className="topbar">
        <div className="brand-lockup">
          <div className="mark">
            <Trophy size={20} />
          </div>
          <div>
            <h1>DemoMaster</h1>
            <p>AI Agent Olympics repo-to-pitch studio</p>
          </div>
        </div>
        <span className="status-pill">
          <span className={isGenerating ? "status-dot pulse" : result?.pitch.mode === "fallback" ? "status-dot fallback" : "status-dot"} />
          {heroStatus}
        </span>
      </section>

      <div className="workspace">
        <aside className="sidebar">
          <form className="repo-form" onSubmit={handleSubmit}>
            <label className="field">
              <span>Repository or app URL</span>
              <input
                data-demomaster-repo-input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/org/repo or https://app.example.com"
                spellCheck={false}
              />
            </label>

            <div className="button-row">
              <button className="btn primary" type="button" onClick={startGeneration} disabled={isGenerating} data-demomaster-generate>
                {isGenerating ? <Loader2 size={17} className="spin" /> : <Sparkles size={17} />}
                Generate pitch video
              </button>
              <button className="icon-btn" type="button" onClick={() => setRepoUrl(sampleRepo)} title="Use sample repo">
                <RefreshCcw size={17} />
              </button>
            </div>

            {error ? <div className="notice error">{error}</div> : null}
            {result?.warnings.length ? <div className="notice">{result.warnings.join(" ")}</div> : null}
          </form>

          <section className="panel compact">
            <div className="panel-heading">
              <Brain size={18} />
              <h2>Generation</h2>
            </div>
            <GenerationProgress
              stage={generationStage}
              isGenerating={isGenerating}
              elapsedSeconds={elapsedSeconds}
              message={liveMessage}
              liveLogs={liveAgentLogs}
              result={result}
            />
          </section>
        </aside>

        <section className="main" data-demomaster-output>
          {result ? (
            <>
              <section className="editor-grid">
                <div className="preview-column">
                  <section className="stage">
                <div className="stage-meta">
                  <div>
                    <span className="eyebrow">
                      {result.pitch.productName} · {result.pitch.mode === "agentic" ? "Agentic run" : "Fallback run"}
                    </span>
                    <h2>{result.pitch.corePromise}</h2>
                    <p>{result.pitch.positioning}</p>
                  </div>
                  <div className="score">{result.pitch.score}</div>
                </div>

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
                      Export final video
                    </button>
                    <button className="btn" type="button" onClick={refreshNarration} disabled={isAudioRefreshing || !isAudioStale}>
                      {isAudioRefreshing ? <Loader2 size={17} className="spin" /> : <Volume2 size={17} />}
                      {isAudioStale ? "Regenerate voice" : "Voice synced"}
                    </button>
                  </div>
                  <div className="scrubber">
                    <span className="timecode">{formatTime(currentTime)}</span>
                    <input
                      type="range"
                      min="0"
                      max={totalDuration}
                      step="0.1"
                      value={currentTime}
                      onChange={(event) => scrub(event.target.value)}
                    />
                    <span className="timecode">{formatTime(totalDuration)}</span>
                  </div>
                </div>

                {result.audio.dataUrl ? <audio ref={audioRef} src={result.audio.dataUrl} preload="auto" /> : null}
                {isAudioStale ? <div className="notice project-notice">Scene script changed. Regenerate voice before final export.</div> : null}
                {exportUrl ? (
                  <a className="export-link" href={exportUrl} download={`${result.pitch.productName}-pitch.webm`}>
                    Download final pitch video
                  </a>
                ) : null}
                  </section>
                  {currentScene ? (
                    <div className="scene-strip">
                      <span className="timecode">{formatTime(currentScene.start)}</span>
                      <strong>{currentScene.title}</strong>
                      <p>{currentScene.visualIntent?.summary || currentScene.beat}</p>
                    </div>
                  ) : null}
                </div>

                <aside className="inspector-panel">
                  <div className="inspector-tabs" role="tablist" aria-label="Project editor">
                    {inspectorTabs.map((tab) => (
                      <button
                        className={inspectorTab === tab.id ? "inspector-tab active" : "inspector-tab"}
                        key={tab.id}
                        onClick={() => setInspectorTab(tab.id)}
                        role="tab"
                        type="button"
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

              <section className="panel project-toolbar" hidden={inspectorTab !== "export"}>
                <div className="panel-heading">
                  <FileText size={18} />
                  <h2>Project script</h2>
                </div>
                <div className="button-row">
                  <button className="btn" type="button" onClick={exportProject}>
                    <Save size={17} />
                    Export project JSON
                  </button>
                  <button className="btn" type="button" onClick={() => projectInputRef.current?.click()}>
                    <Upload size={17} />
                    Import project JSON
                  </button>
                  <button className="btn" type="button" onClick={undoEdit} disabled={!undoStack.length}>
                    <Undo2 size={17} />
                    Undo
                  </button>
                  <button className="btn" type="button" onClick={redoEdit} disabled={!redoStack.length}>
                    <Redo2 size={17} />
                    Redo
                  </button>
                  <input ref={projectInputRef} type="file" accept="application/json,.json" onChange={importProject} hidden />
                </div>
              </section>

              <section className="panel" hidden={inspectorTab !== "style" && inspectorTab !== "voice"}>
                <div className="panel-heading">
                  <Timer size={18} />
                  <h2>Timing, voice, and deck style</h2>
                </div>
                <div className="settings-grid">
                  <label className="field compact-field" hidden={inspectorTab !== "style"}>
                    <span>Target duration</span>
                    <input
                      type="number"
                      min="5"
                      max="180"
                      step="1"
                      value={Math.round(result.pitch.targetDuration || totalDuration)}
                      onChange={(event) => scaleVideoDuration(Number(event.target.value))}
                    />
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "voice"}>
                    <span>Voice</span>
                    <select
                      value={result.pitch.voiceSettings?.voiceName || "Kore"}
                      onChange={(event) => updateVoiceSetting({ voiceName: event.target.value })}
                    >
                      {voicePresets.map((voice) => (
                        <option value={voice} key={voice}>
                          {voice}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "voice"}>
                    <span>Tone</span>
                    <select
                      value={result.pitch.voiceSettings?.tone || "warm"}
                      onChange={(event) => updateVoiceSetting({ tone: event.target.value as NonNullable<PitchResponse["pitch"]["voiceSettings"]>["tone"] })}
                    >
                      <option value="warm">warm</option>
                      <option value="clear">clear</option>
                      <option value="energetic">energetic</option>
                      <option value="executive">executive</option>
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "voice"}>
                    <span>Pacing</span>
                    <select
                      value={result.pitch.voiceSettings?.pacing || "measured"}
                      onChange={(event) => updateVoiceSetting({ pacing: event.target.value as NonNullable<PitchResponse["pitch"]["voiceSettings"]>["pacing"] })}
                    >
                      <option value="calm">calm</option>
                      <option value="measured">measured</option>
                      <option value="brisk">brisk</option>
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "style"}>
                    <span>Theme</span>
                    <select
                      value={result.pitch.deckStyle?.theme || "graphite"}
                      onChange={(event) => updateDeckStyle({ theme: event.target.value as NonNullable<PitchResponse["pitch"]["deckStyle"]>["theme"] })}
                    >
                      {deckThemes.map((theme) => (
                        <option value={theme} key={theme}>
                          {theme}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "style"}>
                    <span>Deck density</span>
                    <select
                      value={result.pitch.deckStyle?.density || "balanced"}
                      onChange={(event) => updateDeckStyle({ density: event.target.value as NonNullable<PitchResponse["pitch"]["deckStyle"]>["density"] })}
                    >
                      {deckDensities.map((density) => (
                        <option value={density} key={density}>
                          {density}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "style"}>
                    <span>Demo caption</span>
                    <select
                      value={result.pitch.deckStyle?.captionStyle || "bar"}
                      onChange={(event) => updateDeckStyle({ captionStyle: event.target.value as NonNullable<PitchResponse["pitch"]["deckStyle"]>["captionStyle"] })}
                    >
                      {captionStyles.map((style) => (
                        <option value={style} key={style}>
                          {style}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field compact-field" hidden={inspectorTab !== "style"}>
                    <span>Accent</span>
                    <input type="color" value={result.pitch.deckStyle?.primaryColor || "#2563eb"} onChange={(event) => updateDeckStyle({ primaryColor: event.target.value })} />
                  </label>
                  <label className="toggle-field" hidden={inspectorTab !== "style"}>
                    <input
                      type="checkbox"
                      checked={result.pitch.deckStyle?.showGrid ?? true}
                      onChange={(event) => updateDeckStyle({ showGrid: event.target.checked })}
                    />
                    <span>Grid</span>
                  </label>
                </div>
              </section>

              <section className="panel" hidden={inspectorTab !== "media"}>
                <div className="panel-heading">
                  <ImagePlus size={18} />
                  <h2>Demo footage</h2>
                </div>
                <div className="media-controls">
                  <div className="button-row">
                    <button className="btn" type="button" onClick={() => mediaInputRef.current?.click()}>
                      <Upload size={17} />
                      Upload footage
                    </button>
                    <input ref={mediaInputRef} type="file" accept="video/*,image/*" onChange={importMediaAsset} hidden />
                  </div>
                  <div className="url-import-row">
                    <label className="field compact-field">
                      <span>Media URL</span>
                      <input value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="https://..." />
                    </label>
                    <button className="btn" type="button" onClick={importMediaAssetUrl} disabled={!mediaUrl.trim()}>
                      <ExternalLink size={17} />
                      Add URL
                    </button>
                  </div>
                  <label className="field compact-field">
                    <span>Active footage</span>
                    <select value={result.pitch.activeMediaAssetId || ""} onChange={(event) => setActiveMediaAsset(event.target.value)}>
                      <option value="">Captured demo footage</option>
                      {(result.pitch.mediaAssets || []).map((asset) => (
                        <option value={asset.id} key={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {activeMediaAsset ? <p className="muted-copy">{activeMediaAsset.name} replaces captured demo footage in preview and export.</p> : null}
                </div>
              </section>

              <section className="panel" hidden={inspectorTab !== "media"}>
                <div className="panel-heading">
                  <Camera size={18} />
                  <h2>Demo capture</h2>
                </div>
                <div className="capture-layout">
                  <div className="capture-copy">
                    <p>{result.pitch.capturePlan.message}</p>
                    <dl>
                      <div>
                        <dt>Install</dt>
                        <dd>{result.pitch.capturePlan.installCommand}</dd>
                      </div>
                      <div>
                        <dt>Run</dt>
                        <dd>{result.pitch.capturePlan.runCommand}</dd>
                      </div>
                      <div>
                        <dt>Port</dt>
                        <dd>{result.pitch.capturePlan.port}</dd>
                      </div>
                    </dl>
                    <p className="muted-copy">
                      DemoMaster tries a hosted demo URL first. If none works, it clones the repo into a temporary local runner and records it with Playwright.
                    </p>
                    {result.capture ? (
                      <div className="capture-status">
                        <span className={`small-status ${captureStatusClass(result.capture.status)}`}>{result.capture.status}</span>
                        <p>{result.capture.message}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="capture-preview">
                    {result.capture?.videoUrl ? (
                      <video
                        src={result.capture.videoUrl}
                        controls
                        muted
                        playsInline
                        preload="auto"
                        poster={result.capture.screenshotUrl}
                      />
                    ) : result.capture?.screenshotUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={result.capture.screenshotUrl} alt="Captured product demo" />
                    ) : (
                      <div className="capture-empty">
                        <Camera size={28} />
                        <span>Public URL or local runner footage will appear here.</span>
                      </div>
                    )}
                    <div className="capture-links">
                      {result.capture?.targetUrl && result.capture.provider === "public-url" ? (
                        <a href={result.capture.targetUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Open app
                        </a>
                      ) : null}
                      {result.capture?.videoUrl ? (
                        <a href={result.capture.videoUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Raw capture video
                        </a>
                      ) : null}
                    </div>
                    {result.capture?.manifest ? <CaptureManifestPanel manifest={result.capture.manifest} /> : null}
                  </div>
                </div>
              </section>

              <section className="output-grid" hidden>
                <section className="panel">
                  <div className="panel-heading">
                    <FileText size={18} />
                    <h2>Product report</h2>
                  </div>
                  <div className="report-block">
                    <h3>User need</h3>
                    <p>{result.pitch.productReport.userNeed}</p>
                  </div>
                  <div className="report-block">
                    <h3>Product shape</h3>
                    <p>{result.pitch.productReport.productShape}</p>
                  </div>
                  <div className="report-block">
                    <h3>Why this flow works</h3>
                    <p>{result.pitch.productReport.whyThisFlowWorks}</p>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <Mic2 size={18} />
                    <h2>Transcript</h2>
                  </div>
                  <p className="transcript">{result.pitch.narration}</p>
                  {result.voiceQa ? (
                    <div className="voice-qa">
                      <div>
                        <span className={`small-status ${captureStatusClass(result.voiceQa.status)}`}>{result.voiceQa.status}</span>
                        <strong>Speechmatics voice QA</strong>
                      </div>
                      <p>{result.voiceQa.message}</p>
                      {typeof result.voiceQa.similarity === "number" ? (
                        <small>{Math.round(result.voiceQa.similarity * 100)}% match · {result.voiceQa.wordCount || 0} words</small>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </section>

              <section className="output-grid" hidden>
                <FeatureList title="Core functions" items={result.pitch.productReport.coreFunctions} />
                <FeatureList title="Supporting functions" items={result.pitch.productReport.supportingFunctions} />
              </section>

              <section className="panel" hidden>
                <div className="panel-heading">
                  <Sparkles size={18} />
                  <h2>Agent logs</h2>
                </div>
                <div className="agent-grid">
                  {result.agentLogs.map((log) => (
                    <article className="agent-panel" key={log.agent}>
                      <header>
                        <strong>{log.agent}</strong>
                        <span>{log.model || log.provider}</span>
                      </header>
                      <ul>
                        {log.entries.map((entry, entryIndex) => (
                          <LogEntry entry={entry} key={`${log.agent}-${entry.step}-${entryIndex}`} />
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>

              <section className="panel" hidden={inspectorTab !== "script"}>
                <div className="panel-heading">
                  <FileText size={18} />
                  <h2>Scene script editor</h2>
                </div>
                <div className="scene-editor-list">
                  {result.pitch.scenes.map((scene) => (
                    <article className="scene-editor-item" key={scene.id}>
                      <header>
                        <span className="scene-time">{formatTime(scene.start)}</span>
                        <strong>{scene.id}</strong>
                      </header>
                      <div className="scene-editor-grid">
                        <label className="field compact-field">
                          <span>Title</span>
                          <input value={scene.title} onChange={(event) => updateScene(scene.id, { title: event.target.value })} />
                        </label>
                        <label className="field compact-field">
                          <span>Visual</span>
                          <select value={scene.visual} onChange={(event) => updateScene(scene.id, { visual: event.target.value as VisualMode })}>
                            {visualModes.map((mode) => (
                              <option value={mode} key={mode}>
                                {mode}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field compact-field">
                          <span>Duration</span>
                          <input
                            type="number"
                            min="1"
                            max="30"
                            step="0.5"
                            value={scene.duration}
                            onChange={(event) => updateScene(scene.id, { duration: Number(event.target.value) })}
                          />
                        </label>
                        {isDemoScene(scene) ? (
                          <>
                            <label className="field compact-field">
                              <span>Segment</span>
                              <select value={scene.sourceSegmentId || ""} onChange={(event) => updateScene(scene.id, { sourceSegmentId: event.target.value || undefined })}>
                                <option value="">Auto</option>
                                {(result.capture?.manifest?.segments || []).map((segment) => (
                                  <option value={segment.id} key={segment.id}>
                                    {segment.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field compact-field">
                              <span>Media</span>
                              <select value={scene.mediaAssetId || ""} onChange={(event) => updateScene(scene.id, { mediaAssetId: event.target.value || undefined })}>
                                <option value="">Active/default</option>
                                {(result.pitch.mediaAssets || []).map((asset) => (
                                  <option value={asset.id} key={asset.id}>
                                    {asset.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field compact-field">
                              <span>Trim start</span>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                value={scene.trimStart ?? ""}
                                onChange={(event) => updateScene(scene.id, { trimStart: event.target.value === "" ? undefined : Number(event.target.value) })}
                              />
                            </label>
                            <label className="field compact-field">
                              <span>Trim end</span>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                value={scene.trimEnd ?? ""}
                                onChange={(event) => updateScene(scene.id, { trimEnd: event.target.value === "" ? undefined : Number(event.target.value) })}
                              />
                            </label>
                            <label className="field compact-field">
                              <span>Camera</span>
                              <select value={scene.cameraPlan?.mode || "wide"} onChange={(event) => updateScene(scene.id, { cameraPlan: { ...scene.cameraPlan, mode: event.target.value as NonNullable<PitchScene["cameraPlan"]>["mode"] } })}>
                                <option value="wide">wide</option>
                                <option value="focus">focus</option>
                                <option value="follow">follow</option>
                                <option value="manual">manual</option>
                              </select>
                            </label>
                            <label className="field compact-field">
                              <span>Focus target</span>
                              <input
                                value={scene.cameraPlan?.focusLabel || scene.visualIntent?.targetHint || ""}
                                onChange={(event) => updateScene(scene.id, { cameraPlan: { ...scene.cameraPlan, focusLabel: event.target.value, mode: scene.cameraPlan?.mode || "focus" } })}
                                placeholder="input block, model selector"
                              />
                            </label>
                            <div className="camera-grid wide">
                              <label className="field compact-field">
                                <span>Crop X</span>
                                <input type="number" min="0" max="1" step="0.01" value={scene.cameraPlan?.crop?.x ?? 0} onChange={(event) => updateScene(scene.id, { cameraPlan: updateCameraCrop(scene, { x: Number(event.target.value) }) })} />
                              </label>
                              <label className="field compact-field">
                                <span>Crop Y</span>
                                <input type="number" min="0" max="1" step="0.01" value={scene.cameraPlan?.crop?.y ?? 0} onChange={(event) => updateScene(scene.id, { cameraPlan: updateCameraCrop(scene, { y: Number(event.target.value) }) })} />
                              </label>
                              <label className="field compact-field">
                                <span>Crop W</span>
                                <input type="number" min="0.18" max="1" step="0.01" value={scene.cameraPlan?.crop?.width ?? 1} onChange={(event) => updateScene(scene.id, { cameraPlan: updateCameraCrop(scene, { width: Number(event.target.value) }) })} />
                              </label>
                              <label className="field compact-field">
                                <span>Crop H</span>
                                <input type="number" min="0.18" max="1" step="0.01" value={scene.cameraPlan?.crop?.height ?? 1} onChange={(event) => updateScene(scene.id, { cameraPlan: updateCameraCrop(scene, { height: Number(event.target.value) }) })} />
                              </label>
                            </div>
                          </>
                        ) : null}
                        <label className="field compact-field wide">
                          <span>On-screen text</span>
                          <input value={scene.onScreenText} onChange={(event) => updateScene(scene.id, { onScreenText: event.target.value })} />
                        </label>
                        <label className="field compact-field wide">
                          <span>Beat</span>
                          <textarea value={scene.beat} onChange={(event) => updateScene(scene.id, { beat: event.target.value })} rows={2} />
                        </label>
                        <label className="field compact-field wide">
                          <span>Narration</span>
                          <textarea value={scene.narration} onChange={(event) => updateScene(scene.id, { narration: event.target.value })} rows={3} />
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
                </aside>
              </section>

              <RunDetails result={result} />
            </>
          ) : (
            <section className="empty-state">
              <div>
                <Code2 size={42} />
                <h2>URL in. Pitch video out.</h2>
                <p>Use a GitHub repository or live app URL to start the full agent run: understanding, positioning, scripting, capture, narration, and export.</p>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
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
  const sceneAsset = scene.mediaAssetId
    ? getMediaAssetById(result.pitch.mediaAssets, scene.mediaAssetId)
    : undefined;
  return sceneAsset || getMediaAssetById(result.pitch.mediaAssets, result.pitch.activeMediaAssetId);
}

function getMediaAssetById(assets: ProjectMediaAsset[] | undefined, assetId?: string) {
  return assetId ? assets?.find((asset) => asset.id === assetId) : undefined;
}

function shouldScenePatchInvalidateAudio(patch: Partial<PitchScene>) {
  return Boolean(patch.title !== undefined || patch.beat !== undefined || patch.narration !== undefined || patch.onScreenText !== undefined || patch.duration !== undefined);
}

function updateCameraCrop(scene: PitchScene, cropPatch: Partial<NonNullable<NonNullable<PitchScene["cameraPlan"]>["crop"]>>): NonNullable<PitchScene["cameraPlan"]> {
  return {
    ...scene.cameraPlan,
    mode: scene.cameraPlan?.mode === "wide" ? "focus" : scene.cameraPlan?.mode || "focus",
    crop: {
      x: scene.cameraPlan?.crop?.x ?? 0,
      y: scene.cameraPlan?.crop?.y ?? 0,
      width: scene.cameraPlan?.crop?.width ?? 1,
      height: scene.cameraPlan?.crop?.height ?? 1,
      ...cropPatch,
    },
  };
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read uploaded media."));
    };
    reader.onerror = () => reject(new Error("Could not read uploaded media."));
    reader.readAsDataURL(file);
  });
}

function CaptureManifestPanel({ manifest }: { manifest: DemoCaptureManifest }) {
  return (
    <div className="capture-manifest">
      <div className="capture-manifest-head">
        <strong>Capture manifest</strong>
        <span>{manifest.segments.length} segment{manifest.segments.length === 1 ? "" : "s"}</span>
      </div>
      <ul>
        {manifest.segments.map((segment) => (
          <li key={segment.id}>
            <span className="timecode">{formatTime(segment.startMs / 1000)}</span>
            <div>
              <strong>{segment.label}</strong>
              <p>{segment.narrationHint}</p>
            </div>
          </li>
        ))}
      </ul>
      {manifest.warnings.length ? <p className="capture-manifest-warning">{manifest.warnings.slice(0, 2).join(" ")}</p> : null}
    </div>
  );
}

function readProjectResult(payload: unknown): PitchResponse {
  if (!payload || typeof payload !== "object") throw new Error("Project JSON must be an object.");
  const maybeProject = payload as { schema?: unknown; result?: unknown; pitch?: unknown };
  const result = maybeProject.schema === projectSchema ? maybeProject.result : maybeProject;
  if (!result || typeof result !== "object") throw new Error("Project JSON does not contain a result object.");

  const candidate = result as Partial<PitchResponse>;
  if (!candidate.repo || !candidate.pitch || !candidate.audio || !Array.isArray(candidate.agentLogs)) {
    throw new Error("Project JSON is missing repo, pitch, audio, or agent logs.");
  }
  if (!Array.isArray(candidate.pitch.scenes)) throw new Error("Project JSON is missing pitch scenes.");
  return candidate as PitchResponse;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "demomaster";
}

function FeatureList({ title, items }: { title: string; items: Array<{ name: string; why: string }> }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <CheckCircle2 size={18} />
        <h2>{title}</h2>
      </div>
      <ul className="feature-list">
        {items.map((item) => (
          <li key={item.name}>
            <h3>{item.name}</h3>
            <p>{item.why}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GenerationProgress({
  stage,
  isGenerating,
  elapsedSeconds,
  message,
  liveLogs,
  result,
}: {
  stage: GenerationStage;
  isGenerating: boolean;
  elapsedSeconds: number;
  message: string;
  liveLogs: AgentLog[];
  result: PitchResponse | null;
}) {
  const activeIndex = generationSteps.findIndex((step) => step.id === stage);
  const safeActiveIndex = activeIndex === -1 ? (result ? generationSteps.length - 1 : 0) : activeIndex;

  return (
    <div className="generation-progress">
      <div className="live-run-head">
        <span>{isGenerating ? message || generationLabel(stage) : result ? "Ready to edit and export." : "Waiting for a repository."}</span>
        <strong>{isGenerating ? formatDuration(elapsedSeconds) : `${liveLogs.length || result?.agentLogs.length || 0} logs`}</strong>
      </div>
      <ol className="stage-steps">
        {generationSteps.map((step, index) => {
          const status = stage === "error" ? (index <= safeActiveIndex ? "error" : "waiting") : index < safeActiveIndex || (!isGenerating && result && step.id === "ready") ? "done" : index === safeActiveIndex && isGenerating ? "running" : index === safeActiveIndex && result ? "done" : "waiting";
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

function RunDetails({ result }: { result: PitchResponse }) {
  return (
    <details className="run-details">
      <summary>
        <span>Run details</span>
        <small>Report, transcript, capture evidence, partner stack, and logs</small>
      </summary>
      <div className="run-details-grid">
        <section className="panel">
          <div className="panel-heading">
            <FileText size={18} />
            <h2>Product report</h2>
          </div>
          <div className="report-block">
            <h3>User need</h3>
            <p>{result.pitch.productReport.userNeed}</p>
          </div>
          <div className="report-block">
            <h3>Product shape</h3>
            <p>{result.pitch.productReport.productShape}</p>
          </div>
          <div className="report-block">
            <h3>Why this flow works</h3>
            <p>{result.pitch.productReport.whyThisFlowWorks}</p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <Mic2 size={18} />
            <h2>Transcript</h2>
          </div>
          <p className="transcript">{result.pitch.narration}</p>
          {result.voiceQa ? (
            <div className="voice-qa">
              <div>
                <span className={`small-status ${captureStatusClass(result.voiceQa.status)}`}>{result.voiceQa.status}</span>
                <strong>Speechmatics voice QA</strong>
              </div>
              <p>{result.voiceQa.message}</p>
            </div>
          ) : null}
        </section>

        <FeatureList title="Core functions" items={result.pitch.productReport.coreFunctions} />
        <FeatureList title="Supporting functions" items={result.pitch.productReport.supportingFunctions} />

        <section className="panel">
          <div className="panel-heading">
            <Code2 size={18} />
            <h2>Partner stack</h2>
          </div>
          <ul className="stack-list">
            {result.pitch.partnerStack.map((partner) => (
              <li key={partner.name}>
                <span className={`small-status ${partner.status}`}>{partner.status}</span>
                <div>
                  <strong>{partner.name}</strong>
                  <p>{partner.role}</p>
                  <small>{partner.detail}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <Sparkles size={18} />
            <h2>Agent logs</h2>
          </div>
          <LiveAgentRun logs={result.agentLogs} message="Completed agent run." elapsedSeconds={0} />
          <div className="agent-grid compact-agent-grid">
            {result.agentLogs.map((log) => (
              <article className="agent-panel" key={log.agent}>
                <header>
                  <strong>{log.agent}</strong>
                  <span>{log.model || log.provider}</span>
                </header>
                <ul>
                  {log.entries.map((entry, entryIndex) => (
                    <LogEntry entry={entry} key={`${log.agent}-${entry.step}-${entryIndex}`} />
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

function LiveAgentRun({ logs, message, elapsedSeconds }: { logs: AgentLog[]; message: string; elapsedSeconds: number }) {
  const logByAgent = new Map(logs.map((log) => [log.agent, log]));
  const nextIndex = liveRunSteps.findIndex((step) => !logByAgent.has(step.agent));
  const activeIndex = nextIndex === -1 ? liveRunSteps.length - 1 : nextIndex;

  return (
    <div className="live-run">
      <div className="live-run-head">
        <span>{message || "Running agent pipeline."}</span>
        <strong>{formatDuration(elapsedSeconds)}</strong>
      </div>
      <ul className="run-list progress-list">
        {liveRunSteps.map((step, index) => {
          const log = logByAgent.get(step.agent);
          const hasError = log?.entries.some((entry) => entry.status === "error");
          const status = hasError ? "error" : log ? "done" : index === activeIndex ? "running" : "waiting";
          const latestEntry = log?.entries.at(-1);
          const detail = latestEntry?.message || (status === "running" ? step.detail : "Waiting for previous agent.");

          return (
            <li key={step.agent} className={`run-step ${status}`}>
              <div className="run-step-icon">
                {status === "done" ? <CheckCircle2 size={14} /> : status === "running" ? <Loader2 size={14} className="spin" /> : null}
              </div>
              <div>
                <div className="run-step-title">
                  <span>{step.label}</span>
                  <small className={`small-status ${status === "done" ? "ready" : status === "waiting" ? "optional" : status}`}>
                    {status}
                  </small>
                </div>
                <p>{detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LogEntry({ entry }: { entry: AgentLogEntry }) {
  return (
    <li>
      <span className={`log-status ${entry.status}`}>{entry.status}</span>
      <div>
        <h3>{entry.step}</h3>
        <p>{entry.message}</p>
      </div>
    </li>
  );
}

function mergeAgentLog(logs: AgentLog[], nextLog: AgentLog) {
  const existing = logs.find((log) => log.agent === nextLog.agent);
  if (!existing) return [...logs, nextLog];
  return logs.map((log) =>
    log.agent === nextLog.agent
      ? {
          ...log,
          provider: nextLog.provider,
          model: nextLog.model || log.model,
          entries: mergeLogEntries(log.entries, nextLog.entries),
        }
      : log,
  );
}

function mergeLogEntries(entries: AgentLogEntry[], nextEntries: AgentLogEntry[]) {
  return nextEntries.reduce<AgentLogEntry[]>((merged, entry) => {
    const index = merged.findIndex((item) => item.step === entry.step);
    if (index === -1) return [...merged, entry];
    return merged.map((item, itemIndex) => (itemIndex === index ? entry : item));
  }, entries);
}

function mergeAgentLogs(logs: AgentLog[], nextLogs: AgentLog[]) {
  return nextLogs.reduce((merged, log) => mergeAgentLog(merged, log), logs);
}

function attachCapture(result: PitchResponse, capture?: DemoCaptureResult, agentLog?: AgentLog) {
  return {
    ...result,
    capture: capture || result.capture,
    agentLogs: agentLog ? mergeAgentLog(result.agentLogs, agentLog) : result.agentLogs,
  };
}

function captureStatusClass(status: DemoCaptureResult["status"]) {
  if (status === "ready") return "ready";
  if (status === "error") return "error";
  if (status === "running") return "running";
  return "optional";
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

async function drawExportFrames(
  context: CanvasRenderingContext2D,
  result: PitchResponse,
  duration: number,
  exportMedia: ExportMediaSet,
) {
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
  if (!isDemoScene(scene)) {
    video.pause();
    playbackState.active = false;
    playbackState.sceneId = undefined;
    playbackState.lastTime = currentTime;
    if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime > 0.1) video.currentTime = 0;
    return;
  }

  if (Number.isFinite(video.duration) && video.duration > 0) {
    const trimStart = Math.min(Math.max(0, scene.trimStart ?? 0), Math.max(0, video.duration - 0.05));
    const trimEnd = scene.trimEnd !== undefined && scene.trimEnd > trimStart ? Math.min(scene.trimEnd, video.duration) : video.duration;
    const mediaSpan = Math.max(1, trimEnd - trimStart);
    video.playbackRate = Math.max(0.1, Math.min(2, mediaSpan / Math.max(1, scene.duration)));
    if (!playbackState.active || playbackState.sceneId !== scene.id || currentTime < playbackState.lastTime) {
      video.currentTime = getSceneMediaPlaybackTime(plan, currentTime, video.duration);
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

function generationLabel(stage: GenerationStage) {
  if (stage === "understanding") return "Generating pitch";
  if (stage === "capturing") return "Capturing demo";
  if (stage === "aligning") return "Aligning script";
  if (stage === "preparing") return "Preparing preview";
  if (stage === "ready") return "Ready to edit/export";
  if (stage === "error") return "Needs attention";
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
