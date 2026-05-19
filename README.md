# DemoMaster

DemoMaster turns one GitHub repository into a narrated product pitch video for the AI Agent Olympics / Milan AI Week demo format.

The app is intentionally repo-only:

1. Paste a GitHub repository URL.
2. Gemini agents inspect the repo, define the product flow, write the pitch, and judge the quality.
3. Gemini generates narration audio.
4. A Demo Capture Agent can provision a Vultr VM, run the repo, and capture real browser footage.
5. The browser renders a playable 16:9 pitch video that can be exported as WebM.

No reference-video input or external video-database workflow is used.

## Partner Stack

- Google Gemini: primary reasoning, strategy, storyboard, quality judge, and narration audio.
- Featherless: optional second-opinion critic through an OpenAI-compatible API.
- Speechmatics: optional future extension for voice-first briefs; not required for repo-only input.
- Vultr: VM runner for cloning the repository, launching it, and capturing real demo footage.

## Getting Started

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Environment

Set these in `.env.local`:

```bash
GEMINI_API_KEY=...
GEMINI_REASONING_MODEL=gemini-3-flash-preview
GEMINI_AGENT_TIMEOUT_MS=25000
GEMINI_CREATIVE_TIMEOUT_MS=45000
GEMINI_AUDIO_MODEL=gemini-3.1-flash-tts-preview
GEMINI_AUDIO_VOICE=Kore
GEMINI_AUDIO_TIMEOUT_MS=45000
REPO_CONTEXT_TIMEOUT_MS=15000
PITCH_AGENT_TOTAL_TIMEOUT_MS=90000
PITCH_AUDIO_TOTAL_TIMEOUT_MS=45000
GITHUB_TOKEN=...
```

Optional partner extensions:

```bash
FEATHERLESS_API_KEY=...
FEATHERLESS_MODEL=Qwen/Qwen3-235B-A22B-Instruct-2507
SPEECHMATICS_API_KEY=...
VULTR_API_KEY=...
VULTR_ENABLE_PROVISIONING=false
VULTR_REGION=ams
VULTR_PLAN=vc2-1c-2gb
VULTR_OS_ID=1743
```

`GITHUB_TOKEN` is optional for public repositories, but helps avoid rate limits and is required for private repos. If `GEMINI_API_KEY` is absent, the app returns a deterministic fallback so the UI stays usable.

## Demo Capture Runner

The app includes a Vultr-backed Demo Capture Agent:

- Gemini creates a capture plan from the repo.
- The user explicitly clicks `Start Vultr runner`.
- The server calls the Vultr API to create a VM with cloud-init user data.
- The VM clones the repo, detects the package manager, installs dependencies, starts the app, installs Playwright, and writes `capture.png`, `capture.webm`, and `status.json`.
- The web UI polls runner status and uses the captured screenshot in the video renderer.

Provisioning is disabled unless `VULTR_ENABLE_PROVISIONING=true` to avoid accidental paid resource creation. Use `Destroy VM` in the UI after capture.

## Scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
```
