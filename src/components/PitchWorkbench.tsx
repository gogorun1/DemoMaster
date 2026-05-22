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
  Loader2,
  Mic2,
  Pause,
  Play,
  Redo2,
  RefreshCcw,
  Save,
  Sparkles,
  Trophy,
  Undo2,
  Upload,
  Volume2,
} from "lucide-react";
import { VideoCanvas } from "@/components/VideoCanvas";
import { ensureCaptureManifest } from "@/lib/capture-manifest";
import { applyProjectEditOperation, normalizePitchTimeline } from "@/lib/project-edits";
import { drawPitchFrame, getDemoPlaybackTime, getSceneAtTime, getTotalDuration, isDemoScene } from "@/lib/render-frame";
import type { AgentLog, AgentLogEntry, AgentName, DemoCaptureManifest, DemoCaptureResult, PitchResponse, PitchScene, VisualMode } from "@/lib/types";

const sampleRepo = "https://github.com/vercel/ai-chatbot";
const projectSchema = "demomaster.project";
const projectVersion = 1;
const visualModes: VisualMode[] = ["presenter", "problem", "product", "workflow", "evidence", "close"];

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

export function PitchWorkbench() {
  const [repoUrl, setRepoUrl] = useState(sampleRepo);
  const [result, setResult] = useState<PitchResponse | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
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
  const audioRef = useRef<HTMLAudioElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const totalDuration = useMemo(() => (result ? getTotalDuration(result.pitch) : 0), [result]);

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
      finalResult = await runAutomaticCapture(finalResult);
      setResult(normalizePitchResult(finalResult));
      setCurrentTime(0);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function runAutomaticCapture(baseResult: PitchResponse) {
    let nextResult = baseResult;

    try {
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
    commitEditableResult({
      ...result,
      pitch: applyProjectEditOperation(result.pitch, {
        type: "update-scene",
        sceneId,
        patch,
      }),
    });
  }

  function commitEditableResult(nextResult: PitchResponse) {
    if (!result) return;
    setUndoStack((stack) => [...stack.slice(-19), { result, isAudioStale }]);
    setRedoStack([]);
    setResult(normalizePitchResult(nextResult));
    setIsAudioStale(true);
    setExportUrl("");
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
      const captureMedia = await loadCaptureMedia(result.capture);
      await drawExportFrames(context, result, totalDuration, captureMedia);
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

  const heroStatus = isGenerating ? "Agents running" : result?.pitch.mode === "agentic" ? "Pitch ready" : result ? "Fallback ready" : "Ready";

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
              <span>Repository</span>
              <input
                data-demomaster-repo-input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/org/repo"
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
              <h2>Agent run</h2>
            </div>
            {isGenerating ? (
              <LiveAgentRun logs={liveAgentLogs} message={liveMessage} elapsedSeconds={elapsedSeconds} />
            ) : result ? (
              <ul className="run-list">
                {result.agentLogs.map((log) => (
                  <li key={log.agent}>
                    <CheckCircle2 size={14} />
                    <span>{log.agent}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">Gemini agents will inspect, position, script, judge, and render from the repository.</p>
            )}
          </section>

          {result ? (
            <section className="panel compact">
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
          ) : null}
        </aside>

        <section className="main" data-demomaster-output>
          {result ? (
            <>
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
                  <VideoCanvas plan={result.pitch} currentTime={currentTime} capture={result.capture} />
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

              <section className="panel project-toolbar">
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

              <section className="panel">
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

              <section className="output-grid">
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

              <section className="output-grid">
                <FeatureList title="Core functions" items={result.pitch.productReport.coreFunctions} />
                <FeatureList title="Supporting functions" items={result.pitch.productReport.supportingFunctions} />
              </section>

              <section className="panel">
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

              <section className="panel">
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
            </>
          ) : (
            <section className="empty-state">
              <div>
                <Code2 size={42} />
                <h2>Repo in. Pitch video out.</h2>
                <p>One repository URL starts the full agent run: understanding, positioning, scripting, judging, narration, and export.</p>
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
    pitch: normalizePitchTimeline(result.pitch),
  };
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

async function loadCaptureMedia(capture?: DemoCaptureResult) {
  if (capture?.videoUrl) {
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
        video.src = capture.videoUrl || "";
      });
      await seekCaptureVideoFrame(video, 0.05);
      return video;
    } catch {
      return loadCaptureImage(capture.screenshotUrl);
    }
  }

  return loadCaptureImage(capture?.screenshotUrl);
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
  captureMedia?: CanvasImageSource,
) {
  const captureVideo = captureMedia instanceof HTMLVideoElement ? captureMedia : undefined;
  if (captureVideo) {
    captureVideo.currentTime = 0;
    captureVideo.pause();
  }
  const startedAt = performance.now();
  const playbackState = { active: false };
  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const elapsed = Math.min(duration, (now - startedAt) / 1000);
      if (captureVideo) syncExportVideo(captureVideo, result.pitch, elapsed, playbackState);
      drawPitchFrame(context, result.pitch, elapsed, captureMedia);
      if (elapsed >= duration) resolve();
      else requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
  captureVideo?.pause();
}

function syncExportVideo(
  video: HTMLVideoElement,
  plan: PitchResponse["pitch"],
  currentTime: number,
  playbackState: { active: boolean },
) {
  const scene = getSceneAtTime(plan, currentTime);
  if (!isDemoScene(scene)) {
    video.pause();
    playbackState.active = false;
    if (currentTime < firstDemoStart(plan) && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime > 0.1) video.currentTime = 0;
    return;
  }

  if (Number.isFinite(video.duration) && video.duration > 0) {
    const demoDuration = Math.max(1, lastDemoEnd(plan) - firstDemoStart(plan));
    video.playbackRate = Math.max(0.1, Math.min(1, video.duration / demoDuration));
    if (!playbackState.active) {
      video.currentTime = getDemoPlaybackTime(plan, currentTime, video.duration);
      playbackState.active = true;
    }
  }
  void video.play().catch(() => undefined);
}

function firstDemoStart(plan: PitchResponse["pitch"]) {
  return plan.scenes.find(isDemoScene)?.start ?? 0;
}

function lastDemoEnd(plan: PitchResponse["pitch"]) {
  const demoScenes = plan.scenes.filter(isDemoScene);
  const last = demoScenes.at(-1);
  return last ? last.start + last.duration : firstDemoStart(plan) + 1;
}

function pickRecordingMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
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
