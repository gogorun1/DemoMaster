"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Camera,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Mic2,
  Pause,
  Play,
  RefreshCcw,
  Sparkles,
  Trash2,
  Trophy,
} from "lucide-react";
import { VideoCanvas } from "@/components/VideoCanvas";
import { drawPitchFrame, getTotalDuration } from "@/lib/render-frame";
import type { AgentLog, AgentLogEntry, DemoCaptureResult, PitchResponse } from "@/lib/types";

const sampleRepo = "https://github.com/vercel/ai-chatbot";

export function PitchWorkbench() {
  const [repoUrl, setRepoUrl] = useState(sampleRepo);
  const [result, setResult] = useState<PitchResponse | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isStartingCapture, setIsStartingCapture] = useState(false);
  const [isDestroyingCapture, setIsDestroyingCapture] = useState(false);
  const [isPreparingManualRunner, setIsPreparingManualRunner] = useState(false);
  const [isAttachingManualRunner, setIsAttachingManualRunner] = useState(false);
  const [manualCloudInit, setManualCloudInit] = useState("");
  const [manualStatusUrl, setManualStatusUrl] = useState("");
  const [error, setError] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const totalDuration = useMemo(() => (result ? getTotalDuration(result.pitch) : 0), [result]);

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

  useEffect(() => {
    const instanceId = result?.capture?.instanceId;
    const shouldPoll = result?.capture?.status === "running";
    if (!instanceId || !shouldPoll) return;

    const timer = window.setInterval(() => {
      refreshCapture(instanceId).catch((refreshError) => {
        setError(refreshError instanceof Error ? refreshError.message : "Capture status failed.");
      });
    }, 12000);

    return () => window.clearInterval(timer);
    // refreshCapture reads the latest result state and is intentionally not a stable polling dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.capture?.instanceId, result?.capture?.status]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsGenerating(true);
    setIsPlaying(false);
    setError("");
    setExportUrl("");

    try {
      const response = await fetch("/api/pitch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Generation failed.");
      setResult(body as PitchResponse);
      setCurrentTime(0);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function startVultrCapture() {
    if (!result) return;
    setIsStartingCapture(true);
    setError("");
    try {
      const response = await fetch("/api/vultr/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, capturePlan: result.pitch.capturePlan }),
      });
      const body = (await response.json()) as { capture?: DemoCaptureResult; agentLog?: AgentLog; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not start Vultr runner.");
      updateCapture(body.capture, body.agentLog);
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Could not start Vultr runner.");
    } finally {
      setIsStartingCapture(false);
    }
  }

  async function refreshCapture(instanceId = result?.capture?.instanceId) {
    if (!result || !instanceId) return;
    const response = await fetch("/api/vultr/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId, port: result.pitch.capturePlan.port }),
    });
    const body = (await response.json()) as { capture?: DemoCaptureResult; agentLog?: AgentLog; error?: string };
    if (!response.ok) throw new Error(body.error || "Could not read Vultr runner status.");
    updateCapture(body.capture, body.agentLog);
  }

  async function destroyCapture() {
    if (!result?.capture?.instanceId) return;
    setIsDestroyingCapture(true);
    setError("");
    try {
      const response = await fetch("/api/vultr/destroy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: result.capture.instanceId }),
      });
      const body = (await response.json()) as { capture?: DemoCaptureResult; agentLog?: AgentLog; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not destroy Vultr runner.");
      updateCapture(body.capture, body.agentLog);
    } catch (destroyError) {
      setError(destroyError instanceof Error ? destroyError.message : "Could not destroy Vultr runner.");
    } finally {
      setIsDestroyingCapture(false);
    }
  }

  async function prepareManualRunner() {
    if (!result) return;
    setIsPreparingManualRunner(true);
    setError("");
    try {
      const response = await fetch("/api/vultr/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, capturePlan: result.pitch.capturePlan }),
      });
      const body = (await response.json()) as { cloudInit?: string; statusUrl?: string; agentLog?: AgentLog; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not prepare manual Vultr runner.");
      setManualCloudInit(body.cloudInit || "");
      setManualStatusUrl((current) => current || body.statusUrl || "");
      if (body.agentLog) updateAgentLog(body.agentLog);
    } catch (manualError) {
      setError(manualError instanceof Error ? manualError.message : "Could not prepare manual Vultr runner.");
    } finally {
      setIsPreparingManualRunner(false);
    }
  }

  async function attachManualRunner() {
    if (!manualStatusUrl.trim()) return;
    setIsAttachingManualRunner(true);
    setError("");
    try {
      const response = await fetch("/api/vultr/manual-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusUrl: manualStatusUrl }),
      });
      const body = (await response.json()) as { capture?: DemoCaptureResult; agentLog?: AgentLog; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not attach manual Vultr runner.");
      updateCapture(body.capture, body.agentLog);
    } catch (manualError) {
      setError(manualError instanceof Error ? manualError.message : "Could not attach manual Vultr runner.");
    } finally {
      setIsAttachingManualRunner(false);
    }
  }

  async function copyManualCloudInit() {
    if (!manualCloudInit) return;
    await navigator.clipboard?.writeText(manualCloudInit).catch(() => undefined);
  }

  function updateCapture(capture?: DemoCaptureResult, agentLog?: AgentLog) {
    if (!capture) return;
    setResult((current) => {
      if (!current) return current;
      return {
        ...current,
        capture,
        agentLogs: agentLog ? upsertAgentLog(current.agentLogs, agentLog) : current.agentLogs,
      };
    });
  }

  function updateAgentLog(agentLog: AgentLog) {
    setResult((current) => {
      if (!current) return current;
      return {
        ...current,
        agentLogs: upsertAgentLog(current.agentLogs, agentLog),
      };
    });
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
      const captureImage = await loadCaptureImage(result.capture?.screenshotUrl);
      await drawExportFrames(context, result, totalDuration, captureImage);
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
    <main className="app-shell">
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
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/org/repo"
                spellCheck={false}
              />
            </label>

            <div className="button-row">
              <button className="btn primary" type="submit" disabled={isGenerating}>
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
              <ul className="run-list">
                {["Inspect repo", "Design product flow", "Write pitch", "Plan capture", "Judge quality", "Render voice"].map((step) => (
                  <li key={step}>
                    <Loader2 size={14} className="spin" />
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
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

        <section className="main">
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
                      Export WebM
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
                {exportUrl ? (
                  <a className="export-link" href={exportUrl} download={`${result.pitch.productName}-pitch.webm`}>
                    Download exported video
                  </a>
                ) : null}
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
                    <div className="button-row">
                      <button className="btn primary" type="button" onClick={startVultrCapture} disabled={isStartingCapture || result.capture?.status === "running"}>
                        {isStartingCapture ? <Loader2 size={17} className="spin" /> : <Camera size={17} />}
                        Start Vultr runner
                      </button>
                      {result.capture?.instanceId ? (
                        <button className="btn" type="button" onClick={() => refreshCapture()} disabled={result.capture?.status === "destroyed"}>
                          <RefreshCcw size={17} />
                          Refresh
                        </button>
                      ) : null}
                      {result.capture?.instanceId && result.capture.status !== "destroyed" ? (
                        <button className="btn danger" type="button" onClick={destroyCapture} disabled={isDestroyingCapture}>
                          {isDestroyingCapture ? <Loader2 size={17} className="spin" /> : <Trash2 size={17} />}
                          Destroy VM
                        </button>
                      ) : null}
                    </div>
                    <div className="manual-runner">
                      <div className="manual-runner-head">
                        <div>
                          <strong>Manual Vultr runner</strong>
                          <p>Use this when the hackathon account blocks API access but still allows Console Compute.</p>
                        </div>
                        <button className="btn" type="button" onClick={prepareManualRunner} disabled={isPreparingManualRunner}>
                          {isPreparingManualRunner ? <Loader2 size={17} className="spin" /> : <Code2 size={17} />}
                          Prepare
                        </button>
                      </div>
                      {manualCloudInit ? (
                        <>
                          <div className="button-row">
                            <button className="btn" type="button" onClick={copyManualCloudInit}>
                              <Copy size={17} />
                              Copy cloud-init
                            </button>
                          </div>
                          <textarea className="manual-script" value={manualCloudInit} readOnly spellCheck={false} />
                          <label className="field compact-field">
                            <span>Status URL</span>
                            <input
                              value={manualStatusUrl}
                              onChange={(event) => setManualStatusUrl(event.target.value)}
                              placeholder="http://203.0.113.10:8090/status.json"
                              spellCheck={false}
                            />
                          </label>
                          <button className="btn primary" type="button" onClick={attachManualRunner} disabled={isAttachingManualRunner}>
                            {isAttachingManualRunner ? <Loader2 size={17} className="spin" /> : <RefreshCcw size={17} />}
                            Attach manual runner
                          </button>
                        </>
                      ) : null}
                    </div>
                    {result.capture ? (
                      <div className="capture-status">
                        <span className={`small-status ${captureStatusClass(result.capture.status)}`}>{result.capture.status}</span>
                        <p>{result.capture.message}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="capture-preview">
                    {result.capture?.screenshotUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={result.capture.screenshotUrl} alt="Captured product running on Vultr" />
                    ) : (
                      <div className="capture-empty">
                        <Camera size={28} />
                        <span>Vultr runner will attach real product footage here.</span>
                      </div>
                    )}
                    <div className="capture-links">
                      {result.capture?.targetUrl ? (
                        <a href={result.capture.targetUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Open app
                        </a>
                      ) : null}
                      {result.capture?.statusUrl ? (
                        <a href={result.capture.statusUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Status
                        </a>
                      ) : null}
                      {result.capture?.videoUrl ? (
                        <a href={result.capture.videoUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          Capture video
                        </a>
                      ) : null}
                    </div>
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
                        {log.entries.map((entry) => (
                          <LogEntry entry={entry} key={`${log.agent}-${entry.step}`} />
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <FileText size={18} />
                  <h2>Scene plan</h2>
                </div>
                <ul className="scene-list">
                  {result.pitch.scenes.map((scene) => (
                    <li className="scene-item" key={scene.id}>
                      <span className="scene-time">{formatTime(scene.start)}</span>
                      <div>
                        <h3>{scene.title}</h3>
                        <p>{scene.narration}</p>
                      </div>
                    </li>
                  ))}
                </ul>
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

function upsertAgentLog(logs: AgentLog[], nextLog: AgentLog) {
  const exists = logs.some((log) => log.agent === nextLog.agent);
  return exists ? logs.map((log) => (log.agent === nextLog.agent ? nextLog : log)) : [...logs, nextLog];
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

async function drawExportFrames(
  context: CanvasRenderingContext2D,
  result: PitchResponse,
  duration: number,
  captureImage?: CanvasImageSource,
) {
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const elapsed = Math.min(duration, (now - startedAt) / 1000);
      drawPitchFrame(context, result.pitch, elapsed, captureImage);
      if (elapsed >= duration) resolve();
      else requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
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
