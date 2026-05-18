export type PitchStyle = "launch" | "investor" | "sales" | "devrel";

export type VisualMode = "talkingHead" | "problem" | "solution" | "workflow" | "proof" | "cta";

export interface PitchRequest {
  repoUrl: string;
  productHint?: string;
  audience: string;
  style: PitchStyle;
  includeVoice: boolean;
}

export interface RepoFileSummary {
  path: string;
  content: string;
}

export interface RepoContext {
  source: "github" | "manual" | "unavailable";
  repoUrl: string;
  owner?: string;
  repo?: string;
  branch?: string;
  description?: string;
  homepage?: string;
  language?: string;
  fileTree: string[];
  files: RepoFileSummary[];
  warnings: string[];
}

export interface VideoMoment {
  query: string;
  start: number;
  end: number;
  label: string;
  text: string;
  confidence?: number;
}

export interface VideoEvidence {
  status: "ready" | "skipped" | "error";
  provider: "videodb";
  videoId?: string;
  streamUrl?: string;
  moments: VideoMoment[];
  message: string;
}

export interface VideoDbAsset {
  kind: "video" | "music";
  prompt: string;
  status: "processing" | "done" | "failed" | "error";
  id?: string;
  outputUrl?: string;
  streamUrl?: string;
  playerUrl?: string;
  message?: string;
}

export interface VideoDbMedia {
  status: "ready" | "skipped" | "error";
  provider: "videodb";
  assets: VideoDbAsset[];
  streamUrl?: string;
  message: string;
  logs: AgentLogEntry[];
}

export interface AgentLogEntry {
  step: string;
  status: "pending" | "running" | "done" | "skipped" | "error";
  message: string;
}

export interface AgentLog {
  agent: "Repo Strategist Agent" | "VideoDB Media Director Agent";
  entries: AgentLogEntry[];
}

export interface PitchScene {
  id: string;
  title: string;
  beat: string;
  narration: string;
  onScreenText: string;
  visual: VisualMode;
  duration: number;
  start: number;
  evidenceQuery?: string;
}

export interface PitchPlan {
  productName: string;
  tagline: string;
  audience: string;
  corePromise: string;
  positioning: string;
  strategy: string;
  score: number;
  cta: string;
  insights: string[];
  scenes: PitchScene[];
  narration: string;
  videoEvidence: VideoEvidence;
  videoDbMedia?: VideoDbMedia;
  generatedAt: string;
}

export interface AudioResult {
  status: "ready" | "skipped" | "error";
  provider: "gemini";
  dataUrl?: string;
  mimeType?: string;
  voice?: string;
  message: string;
}

export interface PitchResponse {
  repo: RepoContext;
  pitch: PitchPlan;
  audio: AudioResult;
  warnings: string[];
  agentLogs: AgentLog[];
}
