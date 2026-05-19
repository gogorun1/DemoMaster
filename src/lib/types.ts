export type VisualMode = "presenter" | "problem" | "product" | "workflow" | "evidence" | "close";

export interface PitchRequest {
  repoUrl: string;
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

export interface ProductFunction {
  name: string;
  why: string;
}

export interface ProductReport {
  userNeed: string;
  productShape: string;
  experienceFlow: string[];
  coreFunctions: ProductFunction[];
  supportingFunctions: ProductFunction[];
  whyThisFlowWorks: string;
  qualityBar: string[];
}

export interface PartnerCapability {
  name: "Google Gemini" | "Featherless" | "Speechmatics" | "Playwright";
  role: string;
  status: "ready" | "optional" | "skipped";
  detail: string;
}

export interface DemoCaptureStep {
  label: string;
  action: string;
  expected: string;
}

export interface DemoCapturePlan {
  source: "public-url" | "local-runner";
  targetUrl?: string;
  installCommand: string;
  runCommand: string;
  port: number;
  steps: DemoCaptureStep[];
  message: string;
}

export interface DemoCaptureResult {
  status: "ready" | "running" | "skipped" | "error";
  provider: "public-url" | "local-runner";
  runId?: string;
  targetUrl?: string;
  screenshotUrl?: string;
  videoUrl?: string;
  interactionSummary?: string[];
  message: string;
  logs: AgentLogEntry[];
}

export interface AgentLogEntry {
  step: string;
  status: "pending" | "running" | "done" | "skipped" | "error";
  message: string;
}

export type AgentName =
  | "Repo Forensics Agent"
  | "Pitch Strategy Agent"
  | "Creative Director Agent"
  | "Open Model Critic Agent"
  | "Quality Judge Agent"
  | "Demo Capture Agent"
  | "Browser Capture Agent"
  | "Capture Alignment Agent"
  | "Voice QA Agent"
  | "Media Renderer Agent";

export interface AgentLog {
  agent: AgentName;
  provider: "gemini" | "featherless" | "speechmatics" | "browser";
  model?: string;
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
}

export interface PitchPlan {
  mode: "agentic" | "fallback";
  productName: string;
  tagline: string;
  primaryUser: string;
  corePromise: string;
  positioning: string;
  strategy: string;
  score: number;
  cta: string;
  insights: string[];
  scenes: PitchScene[];
  narration: string;
  productReport: ProductReport;
  partnerStack: PartnerCapability[];
  capturePlan: DemoCapturePlan;
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

export interface VoiceQaResult {
  status: "ready" | "skipped" | "error";
  provider: "speechmatics";
  transcript?: string;
  similarity?: number;
  wordCount?: number;
  jobId?: string;
  message: string;
}

export interface PitchResponse {
  repo: RepoContext;
  pitch: PitchPlan;
  audio: AudioResult;
  voiceQa?: VoiceQaResult;
  capture?: DemoCaptureResult;
  warnings: string[];
  agentLogs: AgentLog[];
}
