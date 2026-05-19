"use client";

import { useEffect, useRef } from "react";
import { drawPitchFrame } from "@/lib/render-frame";
import type { DemoCaptureResult, PitchPlan } from "@/lib/types";

interface VideoCanvasProps {
  plan: PitchPlan;
  currentTime: number;
  capture?: DemoCaptureResult;
}

export function VideoCanvas({ plan, currentTime, capture }: VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    captureImageRef.current = null;
    if (!capture?.screenshotUrl) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      captureImageRef.current = image;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (canvas && context) drawPitchFrame(context, plan, currentTime, image);
    };
    image.src = capture.screenshotUrl;
  }, [capture?.screenshotUrl, currentTime, plan]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    drawPitchFrame(context, plan, currentTime, captureImageRef.current || undefined);
  }, [currentTime, plan]);

  return <canvas ref={canvasRef} width={1280} height={720} aria-label="Generated pitch video preview" />;
}
