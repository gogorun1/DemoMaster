# DemoMaster

DemoMaster turns one GitHub repository into a narrated product pitch video for the AI Agent Olympics / Milan AI Week demo format.

The app is intentionally repo-only:

1. Paste a GitHub repository URL.
2. Gemini agents inspect the repo, define the product flow, write the pitch, and judge the quality.
3. A Browser Capture Agent records a public hosted demo URL when one is available.
4. If no public URL works, the app clones the repo into `/tmp`, installs dependencies, starts it locally, and records real browser footage with Playwright.
5. A Capture Alignment Agent rewrites the final script against the captured UI, then Gemini regenerates narration audio.
6. The browser renders a playable 16:9 pitch video that can be exported as WebM.

No reference-video input or external video-database workflow is used.

## Partner Stack

- Google Gemini: primary reasoning, strategy, storyboard, quality judge, and narration audio.
- Featherless: visible Open Model Critic Agent through an OpenAI-compatible API.
- Speechmatics: Voice QA Agent that transcribes generated narration and checks it against the transcript.
- Playwright: public URL and local browser capture without remote infrastructure provisioning.

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
SPEECHMATICS_LANGUAGE=en
SPEECHMATICS_OPERATING_POINT=enhanced
SPEECHMATICS_QA_TIMEOUT_MS=45000
GEMINI_CAPTURE_ALIGN_TIMEOUT_MS=45000
```

`GITHUB_TOKEN` is optional for public repositories, but helps avoid rate limits and is required for private repos. If `GEMINI_API_KEY` is absent, the app returns a deterministic fallback so the UI stays usable.

Local repository execution is disabled by default because submitted repositories are untrusted code. To run the local fallback for trusted repositories only, set both values:

```bash
DEMOMASTER_ENABLE_LOCAL_RUNNER=1
DEMOMASTER_LOCAL_RUNNER_ALLOWED_REPOS=owner/repo
```

The local runner uses a minimal child-process environment, disables package lifecycle scripts during install, and no longer injects provider or GitHub tokens into cloned repositories. Run it inside an external sandbox/container with restricted egress before enabling it for anything beyond a reviewed allowlist.

## Demo Capture

DemoMaster uses two capture paths, in this order:

- Public URL capture: reads GitHub homepage metadata and hosted demo links from sampled repo files, then records the page with Playwright.
- Local runner capture: clones the repo into `/tmp/demomaster-runs`, detects npm/pnpm/yarn, installs dependencies, starts `dev`, `start`, or `preview`, then records `http://127.0.0.1:<port>`.

Capture artifacts are stored under `/tmp/demomaster-captures` and served through `/api/captures/...`. Temporary local runner folders are removed after capture.

## Secret Scanning

```bash
gitleaks detect --source . --redact --config .gitleaks.toml
pre-commit install
```

CI runs gitleaks on pushes to `main` and pull requests. Enable GitHub secret scanning and push protection in repository settings as an additional server-side guard.

## Scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
```
