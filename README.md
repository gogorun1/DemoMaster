# DemoMaster

DemoMaster turns one GitHub repository into a narrated product pitch video for the AI Agent Olympics / Milan AI Week demo format.

The app is intentionally repo-only:

1. Paste a GitHub repository URL.
2. Gemini agents inspect the repo, define the product flow, write the pitch, and judge the quality.
3. Gemini TTS generates narration.
4. The browser renders a playable 16:9 pitch video that can be exported as WebM.

No reference-video input or external video-database workflow is used.

## Partner Stack

- Google Gemini: primary reasoning, strategy, storyboard, quality judge, and TTS narration.
- Featherless: optional second-opinion critic through an OpenAI-compatible API.
- Speechmatics: optional future extension for voice-first briefs; not required for repo-only input.
- Vultr: deployment target for the hackathon demo.

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
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Kore
GEMINI_TTS_TIMEOUT_MS=45000
GITHUB_TOKEN=...
```

Optional partner extensions:

```bash
FEATHERLESS_API_KEY=...
FEATHERLESS_MODEL=Qwen/Qwen3-235B-A22B-Instruct-2507
SPEECHMATICS_API_KEY=...
VULTR_API_KEY=...
```

`GITHUB_TOKEN` is optional for public repositories, but helps avoid rate limits and is required for private repos. If `GEMINI_API_KEY` is absent, the app returns a deterministic fallback so the UI stays usable.

## Demo Capture Direction

The production-quality version should include a Demo Capture Agent:

- Gemini infers the run command and the shortest credible demo path from the repo.
- A Vultr VM or container sandbox runs the repository without exposing host secrets.
- Playwright opens the running app and records real browser footage.
- The renderer mixes that captured product footage with Gemini narration, captions, transcript, and agent logs.

This is infrastructure/orchestration work, not a video-database dependency.

## Scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
```
