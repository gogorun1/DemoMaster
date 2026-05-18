import type { PitchPlan, PitchRequest, RepoContext, VideoEvidence } from "@/lib/types";

export function fallbackPitchPlan(
  request: PitchRequest,
  repo: RepoContext,
  videoEvidence: VideoEvidence,
): PitchPlan {
  const inferredName = request.productHint?.trim() || repo.repo || "DemoMaster";
  const productName = titleCase(inferredName.replace(/[-_]/g, " "));
  const audience = request.audience || "busy product evaluators";
  const scenes = [
    {
      id: "cold-open",
      title: "Cold open",
      beat: "Name the painful before-state and make the audience feel the cost immediately.",
      narration: `${productName} starts with the moment every demo team knows: the product works, but the story still takes hours to shape.`,
      onScreenText: "Great demos need a sharper story.",
      visual: "talkingHead" as const,
      duration: 9,
      start: 0,
      evidenceQuery: "problem or friction",
    },
    {
      id: "promise",
      title: "The promise",
      beat: "Turn the repo into a clear outcome, not a feature inventory.",
      narration: `Paste a repository, and ${productName} finds the pitch angle, proof points, transcript, and voiceover path.`,
      onScreenText: "Repo in. Pitch out.",
      visual: "solution" as const,
      duration: 11,
      start: 9,
      evidenceQuery: "core workflow",
    },
    {
      id: "workflow",
      title: "Workflow",
      beat: "Show the system thinking: repository signals, pitch structure, transcript, then narration.",
      narration: "Gemini reads the product surface and produces a tight story. The renderer turns that plan into a voice-led pitch video with transcript built in.",
      onScreenText: "Understand -> Script -> Narrate -> Render",
      visual: "workflow" as const,
      duration: 14,
      start: 20,
      evidenceQuery: "aha moment",
    },
    {
      id: "proof",
      title: "Proof",
      beat: "Anchor the pitch in concrete signals from the codebase.",
      narration: "The result is a timed pitch plan with on-screen text, narration, talking-head moments, and a browser-rendered video you can export with voice.",
      onScreenText: "A timed, narrated pitch package.",
      visual: "proof" as const,
      duration: 13,
      start: 34,
      evidenceQuery: "successful outcome",
    },
    {
      id: "cta",
      title: "Close",
      beat: "End with a buyer-friendly transformation.",
      narration: `${productName} turns raw demo material into a crisp product story, ready for teams that need to ship a better pitch today.`,
      onScreenText: "Ship the story behind the demo.",
      visual: "talkingHead" as const,
      duration: 10,
      start: 47,
      evidenceQuery: "final result",
    },
  ];

  return {
    productName,
    tagline: "AI-directed demo pitch videos from a repository.",
    audience,
    corePromise: "Convert a working demo into a polished narrated product pitch.",
    positioning: "A practical pitch studio for hackathon teams, founders, and devrel teams.",
    strategy:
      "Lead with the cost of unstructured demos, reveal the repo-to-video workflow quickly, then use proof moments and a confident close.",
    score: 78,
    cta: "Generate the first narrated cut, then refine the scenes that matter most.",
    insights: [
      "The strongest pitch angle is transformation: raw implementation becomes a clear buyer-ready story.",
      "The first 15 seconds should avoid setup and show the before/after promise immediately.",
      "The transcript should be clear enough to stand alone as the pitch script.",
      "Short captions and one claim per scene will feel closer to premium product launches.",
    ],
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    videoEvidence,
    generatedAt: new Date().toISOString(),
  };
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
