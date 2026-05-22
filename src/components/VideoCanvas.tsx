"use client";

import { useEffect, useRef } from "react";
import { drawPitchFrame, getSceneAtTime, getSceneMediaPlaybackTime, isDemoScene } from "@/lib/render-frame";
import type { DemoCaptureResult, PitchPlan, ProjectMediaAsset } from "@/lib/types";

interface VideoCanvasProps {
  plan: PitchPlan;
  currentTime: number;
  capture?: DemoCaptureResult;
  mediaAsset?: ProjectMediaAsset;
}

export function VideoCanvas({ plan, currentTime, capture, mediaAsset }: VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureMediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const playbackStateRef = useRef<{ active: boolean; lastTime: number; sceneId?: string }>({ active: false, lastTime: 0 });
  const latestFrameRef = useRef({ plan, currentTime });

  useEffect(() => {
    latestFrameRef.current = { plan, currentTime };
  }, [currentTime, plan]);

  useEffect(() => {
    captureMediaRef.current = null;
    playbackStateRef.current = { active: false, lastTime: 0 };
    let cancelled = false;

    const videoUrl = mediaAsset?.type === "video" ? mediaAsset.dataUrl : capture?.videoUrl;
    const imageUrl = mediaAsset?.type === "image" ? mediaAsset.dataUrl : capture?.screenshotUrl;

    if (videoUrl) {
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
        const frame = latestFrameRef.current;
        if (canvas && context) drawPitchFrame(context, frame.plan, frame.currentTime, drawableMedia(video));
      };
      video.src = videoUrl;
      return () => {
        cancelled = true;
        video.pause();
      };
    }

    if (!imageUrl) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      captureMediaRef.current = image;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const frame = latestFrameRef.current;
      if (canvas && context) drawPitchFrame(context, frame.plan, frame.currentTime, image);
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [capture?.screenshotUrl, capture?.videoUrl, mediaAsset?.dataUrl, mediaAsset?.type]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const media = drawableMedia(captureMediaRef.current);
    if (media instanceof HTMLVideoElement) syncPreviewVideo(media, plan, currentTime, playbackStateRef.current);
    drawPitchFrame(context, plan, currentTime, drawableMedia(media));
  }, [currentTime, plan]);

  return <canvas ref={canvasRef} width={1280} height={720} aria-label="Generated pitch video preview" />;
}

function syncPreviewVideo(video: HTMLVideoElement, plan: PitchPlan, currentTime: number, playbackState: { active: boolean; lastTime: number; sceneId?: string }) {
  const scene = getSceneAtTime(plan, currentTime);
  if (!isDemoScene(scene)) {
    video.pause();
    playbackState.active = false;
    playbackState.sceneId = undefined;
    playbackState.lastTime = currentTime;
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

function drawableMedia(media: HTMLImageElement | HTMLVideoElement | null | undefined) {
  if (!(media instanceof HTMLVideoElement)) return media || undefined;
  return media.videoWidth > 0 && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? media : undefined;
}
