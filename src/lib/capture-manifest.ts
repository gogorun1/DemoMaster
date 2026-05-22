import type { DemoCaptureManifest, DemoCaptureResult, DemoCaptureSegment } from "@/lib/types";

const DEFAULT_SEGMENT_MS = 3500;
const MIN_CAPTURE_MS = 4000;

export function ensureCaptureManifest(capture?: DemoCaptureResult): DemoCaptureResult | undefined {
  if (!capture) return undefined;
  if (capture.manifest) return capture;
  return {
    ...capture,
    manifest: buildCaptureManifest(capture),
  };
}

export function buildCaptureManifest(capture: DemoCaptureResult): DemoCaptureManifest {
  const summaries = capture.interactionSummary?.length
    ? capture.interactionSummary
    : [capture.message || "Captured the available product surface."];
  const segments = summaries.map((summary, index) => buildSegment(capture, summary, index, summaries.length));
  const durationMs = segments.length ? Math.max(MIN_CAPTURE_MS, segments[segments.length - 1].endMs) : MIN_CAPTURE_MS;

  return {
    version: 1,
    provider: capture.provider,
    status: capture.status,
    runId: capture.runId,
    targetUrl: capture.targetUrl,
    primaryVideoUrl: capture.videoUrl,
    primaryScreenshotUrl: capture.screenshotUrl,
    durationMs,
    segments,
    warnings: capture.logs
      .filter((entry) => entry.status === "error" || entry.status === "skipped")
      .map((entry) => `${entry.step}: ${entry.message}`),
  };
}

function buildSegment(
  capture: DemoCaptureResult,
  summary: string,
  index: number,
  count: number,
): DemoCaptureSegment {
  const startMs = index * DEFAULT_SEGMENT_MS;
  const isLast = index === count - 1;
  const endMs = startMs + (isLast ? Math.max(DEFAULT_SEGMENT_MS, MIN_CAPTURE_MS / Math.max(1, count)) : DEFAULT_SEGMENT_MS);

  return {
    id: `capture-segment-${index + 1}`,
    label: segmentLabel(summary, index),
    actionSummary: summary,
    startMs,
    endMs,
    source: capture.videoUrl ? "recording" : capture.screenshotUrl ? "screenshot" : capture.status === "ready" ? "interaction" : "fallback",
    videoUrl: capture.videoUrl,
    screenshotUrl: capture.screenshotUrl,
    narrationHint: narrationHint(summary),
  };
}

function segmentLabel(summary: string, index: number) {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return `Segment ${index + 1}`;
  return cleaned.length > 54 ? `${cleaned.slice(0, 51)}...` : cleaned;
}

function narrationHint(summary: string) {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Explain what this captured moment proves in the product workflow.";
  return `Explain why this captured step matters: ${cleaned}`;
}
