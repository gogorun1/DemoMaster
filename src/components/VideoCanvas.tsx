"use client";

import { useEffect, useRef } from "react";
import { drawPitchFrame } from "@/lib/render-frame";
import type { PitchPlan } from "@/lib/types";

interface VideoCanvasProps {
  plan: PitchPlan;
  currentTime: number;
}

export function VideoCanvas({ plan, currentTime }: VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    drawPitchFrame(context, plan, currentTime);
  }, [currentTime, plan]);

  return <canvas ref={canvasRef} width={1280} height={720} aria-label="Generated pitch video preview" />;
}
