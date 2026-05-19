"use client";

import { useEffect, useRef } from "react";
import { drawPitchFrame, getDemoPlaybackTime, getSceneAtTime, isDemoScene } from "@/lib/render-frame";
import type { DemoCaptureResult, PitchPlan } from "@/lib/types";

interface VideoCanvasProps {
  plan: PitchPlan;
  currentTime: number;
  capture?: DemoCaptureResult;
}

export function VideoCanvas({ plan, currentTime, capture }: VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureMediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const playbackStateRef = useRef({ active: false, lastTime: 0 });

  useEffect(() => {
    captureMediaRef.current = null;
    let cancelled = false;

    if (capture?.videoUrl) {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onloadeddata = () => {
        if (cancelled) return;
        captureMediaRef.current = video;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas && context) drawPitchFrame(context, plan, currentTime, video);
      };
      video.src = capture.videoUrl;
      return () => {
        cancelled = true;
        video.pause();
      };
    }

    if (!capture?.screenshotUrl) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      captureMediaRef.current = image;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (canvas && context) drawPitchFrame(context, plan, currentTime, image);
    };
    image.src = capture.screenshotUrl;
    return () => {
      cancelled = true;
    };
  }, [capture?.screenshotUrl, capture?.videoUrl, currentTime, plan]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const media = captureMediaRef.current || undefined;
    if (media instanceof HTMLVideoElement) syncPreviewVideo(media, plan, currentTime, playbackStateRef.current);
    drawPitchFrame(context, plan, currentTime, media);
  }, [currentTime, plan]);

  return <canvas ref={canvasRef} width={1280} height={720} aria-label="Generated pitch video preview" />;
}

function syncPreviewVideo(video: HTMLVideoElement, plan: PitchPlan, currentTime: number, playbackState: { active: boolean; lastTime: number }) {
  const scene = getSceneAtTime(plan, currentTime);
  if (!isDemoScene(scene)) {
    video.pause();
    playbackState.active = false;
    playbackState.lastTime = currentTime;
    return;
  }

  if (Number.isFinite(video.duration) && video.duration > 0) {
    const demoDuration = Math.max(1, lastDemoEnd(plan) - firstDemoStart(plan));
    video.playbackRate = Math.max(0.1, Math.min(1, video.duration / demoDuration));
    if (!playbackState.active || currentTime < playbackState.lastTime) {
      video.currentTime = getDemoPlaybackTime(plan, currentTime, video.duration);
      playbackState.active = true;
    }
  }
  playbackState.lastTime = currentTime;
  void video.play().catch(() => undefined);
}

function firstDemoStart(plan: PitchPlan) {
  return plan.scenes.find(isDemoScene)?.start ?? 0;
}

function lastDemoEnd(plan: PitchPlan) {
  const demoScenes = plan.scenes.filter(isDemoScene);
  const last = demoScenes.at(-1);
  return last ? last.start + last.duration : firstDemoStart(plan) + 1;
}
