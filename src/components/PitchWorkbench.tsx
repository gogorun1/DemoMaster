"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  Download,
  Film,
  Loader2,
  Mic2,
  Pause,
  Play,
  RefreshCcw,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { VideoCanvas } from "@/components/VideoCanvas";
import { drawPitchFrame, getTotalDuration } from "@/lib/render-frame";
import type { PitchRequest, PitchResponse, PitchStyle } from "@/lib/types";

const sampleRequest: PitchRequest = {
  repoUrl: "https://github.com/gogorun1/DemoMaster",
  productHint: "DemoMaster",
  audience: "hackathon judges, founders, and product teams",
  style: "launch",
  includeVoice: true,
};

export function PitchWorkbench() {
  const [form, setForm] = useState<PitchRequest>(sampleRequest);
  const [result, setResult] = useState<PitchResponse | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
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
        body: JSON.stringify(form),
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

  async function togglePlayback() {
    if (!result) return;
    const audio = audioRef.current;
    if (isPlaying) {
      audio?.pause();
      setIsPlaying(false);
      return;
    }

    if (audio && result.audio.status === "ready") {
      audio.currentTime = Math.min(currentTime, Math.max(0, audio.duration - 0.2));
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
        for (const track of destination.stream.getAudioTracks()) {
          stream.addTrack(track);
        }
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
      await drawExportFrames(context, result, totalDuration);
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

  async function finalizeVideoDbStream() {
    if (!result?.pitch.videoDbMedia?.assets.length) return;
    setIsFinalizing(true);
    setError("");
    try {
      const response = await fetch("/api/videodb/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: result.pitch.videoDbMedia.assets }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "VideoDB finalize failed.");
      setResult({
        ...result,
        pitch: { ...result.pitch, videoDbMedia: body.videoDbMedia },
        agentLogs: result.agentLogs.map((log) =>
          log.agent === "VideoDB Media Director Agent" ? { ...log, entries: body.videoDbMedia.logs } : log,
        ),
      });
    } catch (finalizeError) {
      setError(finalizeError instanceof Error ? finalizeError.message : "VideoDB finalize failed.");
    } finally {
      setIsFinalizing(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <aside className="sidebar">
          <div className="brand-bar">
            <div className="brand-title">
              <div className="mark">
                <Film size={20} />
              </div>
              <div>
                <h1>DemoMaster</h1>
                <p>Repo to narrated pitch video</p>
              </div>
            </div>
            <span className="status-pill">
              <span className="status-dot" />
              Studio
            </span>
          </div>

          <form className="form" onSubmit={handleSubmit}>
            <label className="field">
              <span>Demo repo</span>
              <input
                value={form.repoUrl}
                onChange={(event) => setForm({ ...form, repoUrl: event.target.value })}
                placeholder="https://github.com/org/repo"
              />
            </label>

            <label className="field">
              <span>Product hint</span>
              <input
                value={form.productHint}
                onChange={(event) => setForm({ ...form, productHint: event.target.value })}
                placeholder="Product name"
              />
            </label>

            <label className="field">
              <span>Audience</span>
              <textarea
                value={form.audience}
                onChange={(event) => setForm({ ...form, audience: event.target.value })}
                placeholder="judges, founders, buyers..."
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Pitch style</span>
                <select
                  value={form.style}
                  onChange={(event) => setForm({ ...form, style: event.target.value as PitchStyle })}
                >
                  <option value="launch">Launch</option>
                  <option value="investor">Investor</option>
                  <option value="sales">Sales</option>
                  <option value="devrel">DevRel</option>
                </select>
              </label>

              <label className="field">
                <span>Voice</span>
                <select
                  value={form.includeVoice ? "yes" : "no"}
                  onChange={(event) => setForm({ ...form, includeVoice: event.target.value === "yes" })}
                >
                  <option value="yes">Gemini TTS</option>
                  <option value="no">No voice</option>
                </select>
              </label>
            </div>

            <div className="button-row">
              <button className="btn primary" type="submit" disabled={isGenerating}>
                {isGenerating ? <Loader2 size={17} className="spin" /> : <WandSparkles size={17} />}
                Generate
              </button>
              <button className="btn ghost" type="button" onClick={() => setForm(sampleRequest)}>
                <RefreshCcw size={16} />
                Sample
              </button>
            </div>

            {error ? <div className="notice">{error}</div> : null}
            {result?.warnings.length ? <div className="notice">{result.warnings.join(" ")}</div> : null}
          </form>
        </aside>

        <section className="main">
          {result ? (
            <>
              <section className="stage">
                <div className="canvas-wrap">
                  <VideoCanvas plan={result.pitch} currentTime={currentTime} />
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
                  <p>
                    <a className="export-link" href={exportUrl} download={`${result.pitch.productName}-pitch.webm`}>
                      Download exported video
                    </a>
                  </p>
                ) : null}
              </section>

              <section className="output-grid">
                <div className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>{result.pitch.corePromise}</h2>
                      <p>{result.pitch.positioning}</p>
                    </div>
                    <div className="score">{result.pitch.score}</div>
                  </div>
                  <ul className="insight-list">
                    {result.pitch.insights.map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                </div>

                <div className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>Transcript</h2>
                      <p>{result.pitch.narration}</p>
                    </div>
                    <Mic2 size={22} color="#83d17d" />
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-title">
                  <div>
                    <h2>VideoDB generated media</h2>
                    <p>{result.pitch.videoDbMedia?.message || "VideoDB media generation is not configured."}</p>
                  </div>
                  <Film size={22} color="#7ed6bf" />
                </div>
                {result.pitch.videoDbMedia?.streamUrl ? (
                  <p>
                    <a className="export-link" href={result.pitch.videoDbMedia.streamUrl} target="_blank" rel="noreferrer">
                      Open compiled VideoDB stream
                    </a>
                  </p>
                ) : null}
                {result.pitch.videoDbMedia?.assets.length && !result.pitch.videoDbMedia.streamUrl ? (
                  <button className="btn" type="button" onClick={finalizeVideoDbStream} disabled={isFinalizing}>
                    {isFinalizing ? <Loader2 size={17} className="spin" /> : <Film size={17} />}
                    Finalize VideoDB stream
                  </button>
                ) : null}
                <ul className="evidence-list">
                  {result.pitch.videoDbMedia?.assets.length ? (
                    result.pitch.videoDbMedia.assets.map((asset) => (
                      <li className="evidence-item" key={`${asset.kind}-${asset.id || asset.prompt}`}>
                        <h3>
                          {asset.kind} · {asset.status}
                        </h3>
                        <p>{asset.prompt}</p>
                        {asset.playerUrl || asset.streamUrl || asset.outputUrl ? (
                          <p>
                            <a
                              className="export-link"
                              href={asset.playerUrl || asset.streamUrl || asset.outputUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open VideoDB asset
                            </a>
                          </p>
                        ) : null}
                      </li>
                    ))
                  ) : (
                    <li className="evidence-item">
                      <h3>skipped</h3>
                      <p>Set VIDEODB_API_KEY to generate supporting video clips and music from the repo pitch.</p>
                    </li>
                  )}
                </ul>
              </section>

              <section className="output-grid">
                {(result.agentLogs || []).map((log) => (
                  <div className="panel" key={log.agent}>
                    <div className="panel-title">
                      <div>
                        <h2>{log.agent}</h2>
                        <p>{log.entries[log.entries.length - 1]?.message}</p>
                      </div>
                      <Sparkles size={22} color="#f2c36b" />
                    </div>
                    <ul className="evidence-list">
                      {log.entries.map((entry) => (
                        <li className="evidence-item" key={`${log.agent}-${entry.step}`}>
                          <h3>
                            {entry.step} · {entry.status}
                          </h3>
                          <p>{entry.message}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>

              <section className="timeline-panel">
                <div className="panel-title">
                  <div>
                    <h2>Scene plan</h2>
                    <p>{result.pitch.strategy}</p>
                  </div>
                  <Sparkles size={22} color="#f2c36b" />
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
                <Code2 size={42} color="#83d17d" />
                <h2>Turn a demo repo into a narrated pitch.</h2>
                <p>
                  Paste a repository and generate a timed product story with voice, transcript, and pitch-ready scenes.
                </p>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

async function drawExportFrames(context: CanvasRenderingContext2D, result: PitchResponse, duration: number) {
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const elapsed = Math.min(duration, (now - startedAt) / 1000);
      drawPitchFrame(context, result.pitch, elapsed);
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
