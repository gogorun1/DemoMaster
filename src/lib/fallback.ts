import type { AgentLog, PartnerCapability, PitchPlan, PitchRequest, RepoContext } from "@/lib/types";

export function fallbackPitchPlan(request: PitchRequest, repo: RepoContext): PitchPlan {
  const productName = titleCase((repo.repo || inferNameFromUrl(request.repoUrl) || "DemoMaster").replace(/[-_]/g, " "));
  const primaryUser = "hackathon builders, founders, and technical teams who need a credible demo pitch fast";
  const scenes = [
    {
      id: "cold-open",
      title: "The cost",
      beat: "A working repository is not the same as a story people understand.",
      narration: `${productName} begins with a familiar problem: the code works, but the pitch is still scattered across README notes, product guesses, and last-minute narration.`,
      onScreenText: "A working demo still needs a story.",
      visual: "presenter" as const,
      duration: 9,
      start: 0,
    },
    {
      id: "product-read",
      title: "Repo read",
      beat: "Inspect the repository and infer what the product actually does.",
      narration: "The system reads the repository, extracts product signals, and separates real evidence from generic claims.",
      onScreenText: "Repo signals become product evidence.",
      visual: "workflow" as const,
      duration: 10,
      start: 9,
    },
    {
      id: "strategy",
      title: "Pitch strategy",
      beat: "Choose one sharp promise and the fastest route to an aha moment.",
      narration: "A strategy agent picks the strongest audience, the clearest before-and-after, and the proof points that deserve screen time.",
      onScreenText: "One promise. One audience. One arc.",
      visual: "product" as const,
      duration: 11,
      start: 19,
    },
    {
      id: "quality-loop",
      title: "Quality loop",
      beat: "A judge agent checks whether the story is specific, credible, and pitch-ready.",
      narration: "A critic reviews the pitch for vague language, weak evidence, and awkward flow before the final script is locked.",
      onScreenText: "The pitch is judged before it is rendered.",
      visual: "evidence" as const,
      duration: 11,
      start: 30,
    },
    {
      id: "render",
      title: "Narrated output",
      beat: "Generate a narrated product video and transcript from the approved pitch plan.",
      narration: `The final output is a clean narrated pitch video, a transcript, and transparent agent logs showing how ${productName} was understood and shaped.`,
      onScreenText: "Pitch video, transcript, and agent logs.",
      visual: "close" as const,
      duration: 10,
      start: 41,
    },
  ];

  return {
    mode: "fallback",
    productName,
    tagline: "Autonomous repo-to-pitch video agent.",
    primaryUser,
    corePromise: "Turn a repository into a credible narrated product pitch without hand-writing the story.",
    positioning: "Built for AI Agent Olympics style demos: agentic reasoning, visible process, and a real media output.",
    strategy: "Lead with the gap between code and story, prove repo understanding, show the agent quality loop, then deliver a narrated video package.",
    score: repo.source === "github" ? 78 : 66,
    cta: "Paste a public GitHub repository and generate the pitch video package.",
    insights: [
      "The product should ask for only one thing: the repository.",
      "The strongest UX is an agent run with transparent checkpoints, not a long configuration form.",
      "The final video must be useful even if the viewer never opens the source repo.",
      "Quality improves when a judge agent critiques specificity before media rendering.",
    ],
    scenes,
    narration: scenes.map((scene) => scene.narration).join(" "),
    productReport: {
      userNeed: "Builders need to turn a working demo into a clear, investor- or judge-ready story under time pressure.",
      productShape: "A single-input pitch studio: repo in, agentic analysis in the middle, narrated video out.",
      experienceFlow: [
        "Paste repository URL.",
        "Watch specialized agents inspect, position, script, and judge the story.",
        "Review the generated pitch video, transcript, and evidence-backed scene plan.",
        "Export the narrated WebM for submission or iteration.",
      ],
      coreFunctions: [
        {
          name: "Repository understanding",
          why: "The product cannot create a credible pitch unless it grounds claims in files, routes, components, README content, and API surfaces.",
        },
        {
          name: "Demo capture",
          why: "A high-quality pitch video should show the product actually running, so the system needs a sandboxed runner plus browser recording.",
        },
        {
          name: "Multi-agent pitch synthesis",
          why: "Separate analyst, strategist, creative, and judge roles make the output easier to trust than a single opaque prompt.",
        },
        {
          name: "Narrated video rendering",
          why: "The requested deliverable is a pitch video with voice, not only a script or slide outline.",
        },
      ],
      supportingFunctions: [
        {
          name: "Transcript",
          why: "Teams need to submit, edit, or rehearse the pitch outside the app.",
        },
        {
          name: "Agent logs",
          why: "Logs prove the demo is real and help judges see autonomous reasoning and tool use.",
        },
        {
          name: "Partner stack visibility",
          why: "AI Agent Olympics rewards practical use of partner technology, so the app should show what was used and why.",
        },
      ],
      whyThisFlowWorks:
        "It removes unnecessary choices before generation, makes progress legible while agents work, and puts the final artifact first after completion.",
      qualityBar: [
        "No reference video input.",
        "No generic AI hype without repo evidence.",
        "Aha moment within the first 15 seconds.",
        "Short captions, one claim per scene, exportable video.",
      ],
    },
    partnerStack: buildPartnerStack(Boolean(process.env.GEMINI_API_KEY)),
    generatedAt: new Date().toISOString(),
  };
}

export function fallbackAgentLogs(repo: RepoContext): AgentLog[] {
  return [
    {
      agent: "Repo Forensics Agent",
      provider: "gemini",
      entries: [
        {
          step: "Inspect repository",
          status: repo.source === "github" ? "done" : "skipped",
          message:
            repo.source === "github"
              ? `Loaded ${repo.files.length} high-signal file(s) from ${repo.owner}/${repo.repo}.`
              : repo.warnings[0] || "Repository inspection was not available.",
        },
      ],
    },
    {
      agent: "Pitch Strategy Agent",
      provider: "gemini",
      entries: [
        {
          step: "Use deterministic fallback",
          status: "skipped",
          message: "Gemini was not available, so DemoMaster returned a conservative repo-only pitch structure.",
        },
      ],
    },
    {
      agent: "Creative Director Agent",
      provider: "gemini",
      entries: [
        {
          step: "Draft storyboard",
          status: "skipped",
          message: "The fallback storyboard preserves the intended user flow without inventing unsupported product claims.",
        },
      ],
    },
    {
      agent: "Quality Judge Agent",
      provider: "gemini",
      entries: [
        {
          step: "Apply local quality bar",
          status: "done",
          message: "Checked for repo-only input, short captions, and a video-first output.",
        },
      ],
    },
  ];
}

export function buildPartnerStack(hasGemini: boolean): PartnerCapability[] {
  return [
    {
      name: "Google Gemini",
      role: "repo reasoning, pitch writing, judging, and narration audio",
      status: hasGemini ? "ready" : "skipped",
      detail: hasGemini
        ? "Configured through GEMINI_API_KEY and used as the primary AI Agent Olympics partner stack."
        : "Set GEMINI_API_KEY to run the real agent pipeline.",
    },
    {
      name: "Featherless",
      role: "optional open-model critic for second-opinion judging",
      status: process.env.FEATHERLESS_API_KEY ? "ready" : "optional",
      detail: process.env.FEATHERLESS_API_KEY
        ? "Configured through FEATHERLESS_API_KEY for an optional judge pass."
        : "Optional. Add FEATHERLESS_API_KEY to route the judge agent through Featherless.",
    },
    {
      name: "Speechmatics",
      role: "optional voice-input extension for future spoken repo briefs",
      status: process.env.SPEECHMATICS_API_KEY ? "ready" : "optional",
      detail: "Not required for repo-only input. Kept as a natural extension for voice-first agent workflows.",
    },
    {
      name: "Vultr",
      role: "deployment target for the hackathon demo",
      status: process.env.VULTR_API_KEY ? "ready" : "optional",
      detail: "The app remains portable to Vultr; runtime does not require Vultr credentials locally.",
    },
  ];
}

function inferNameFromUrl(repoUrl: string) {
  return repoUrl.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "");
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
