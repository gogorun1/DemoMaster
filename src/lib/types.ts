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
  name: "Google Gemini" | "Featherless" | "Speechmatics" | "Vultr";
  role: string;
  status: "ready" | "optional" | "skipped";
  detail: string;
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
  | "Quality Judge Agent"
  | "Media Renderer Agent";

export interface AgentLog {
  agent: AgentName;
  provider: "gemini" | "featherless" | "browser";
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
