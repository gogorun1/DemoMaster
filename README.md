# DemoMaster

DemoMaster turns a demo repository into a narrated product pitch video plan and browser-rendered video export.

It combines:

- Gemini structured output for repo understanding, positioning, scriptwriting, and pitch strategy.
- Gemini TTS for voiceover audio.
- VideoDB generated media jobs for supporting pitch video clips and background music from the repo-derived story.
- A browser canvas renderer that previews and exports a narrated WebM pitch video.

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
VIDEODB_API_KEY=...
GITHUB_TOKEN=...
```

`GITHUB_TOKEN` is optional for public repositories, but helps avoid rate limits. If Gemini keys are absent, DemoMaster returns a deterministic fallback plan so the UI remains usable. If VideoDB keys are absent, it still builds and exports the pitch video, but skips generated media jobs.

## Flow

1. Paste a GitHub repository URL.
2. Generate a pitch package.
3. Review the transcript, scene plan, and VideoDB-generated media jobs.
4. Preview the timeline, play the voiceover, and export a narrated WebM.

## Notes

The app is designed as a hackathon-quality MVP. For production, add persisted jobs, upload handling, authenticated private repo access, durable media storage, and background rendering.
