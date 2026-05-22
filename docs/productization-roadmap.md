# DemoMaster Productization Roadmap

DemoMaster is moving from a one-shot repo-to-video prototype into a script-based demo video studio. This roadmap tracks product phases, acceptance criteria, and verification expectations.

## Phase 1: Editable Project Script Foundation

Goal: make generated pitch results editable without changing the existing capture and canvas renderer.

Delivered:

- Export generated work as a versioned project JSON file.
- Import project JSON back into the workbench.
- Edit scene title, visual mode, duration, on-screen text, beat, and narration.
- Recompute scene start times and full narration after edits.
- Mark narration audio stale when the script changes.
- Regenerate narration and voice QA through a dedicated `/api/pitch/audio` endpoint.

Acceptance checks:

- TypeScript passes with `npm run typecheck`.
- ESLint passes with `npm run lint`.
- Production build passes with `npm run build`.
- Local API smoke test returns `200` for `/api/pitch/audio`.
- Browser smoke test confirms the app shell loads on `localhost:3000`.

## Phase 2: Capture Manifest And Recording Plan

Goal: stop treating Playwright recording as a single opaque clip.

Delivered:

- Added a typed capture manifest model with source media, segment timing, narration hints, provider metadata, and capture warnings.
- Added a backward-compatible manifest builder that derives editable segments from existing capture results.
- Normalized imported and generated projects so captures always expose manifest data when available.
- Displayed capture manifest segments in the workbench for review before final editing.

Planned:

- Upgrade capture steps from natural-language instructions into typed actions with selectors, values, expected states, and shot intent.
- Preserve current heuristic exploration as fallback behavior.
- Make final pitch generation consume the capture manifest instead of only a screenshot and free-form summary.

Acceptance checks:

- Capture result remains backward-compatible with current renderer.
- Manifest is present for public URL, sandbox runner, local runner, and skipped/error capture states.
- Existing capture fallback paths continue to typecheck and build.

## Phase 3: Script-Based Editing Workflow

Goal: make every edit an explicit operation on the project script.

Delivered:

- Added deterministic project edit operations for scene updates and scene moves.
- Routed scene editor changes through the operation layer instead of direct ad hoc state mutation.
- Added undo and redo history for script edits.

Planned:

- Add edit operations such as trim, rewrite narration, set overlay, and replace capture segment.
- Add a command box that converts natural-language edit requests into structured operations.
- Apply operations locally first, then optionally ask an AI editor to propose patches.

Acceptance checks:

- Operation application is deterministic and unit-testable.
- Invalid operations return clear errors and do not corrupt the project.
- Exported project JSON contains enough information to reproduce the edit state.

## Phase 4: Flexible Media And Rendering

Goal: support user-owned demo footage and more precise composition.

Planned:

- Allow uploaded video or screenshot assets.
- Allow assigning source segments to timeline scenes.
- Add fit, crop, zoom, captions, and basic overlay controls.
- Evaluate moving the renderer from direct canvas drawing to a Remotion composition while keeping the project script as the source of truth.

Acceptance checks:

- User-supplied media can be previewed, saved in project JSON metadata, and exported.
- Canvas renderer remains stable while the render abstraction evolves.
- A sample project renders consistently in browser preview and headless export.

## Phase 5: Market-Ready Product Surface

Goal: harden the studio for repeatable customer use.

Planned:

- Project persistence.
- Version history.
- Shareable rendered outputs.
- Team-safe capture controls.
- Robust onboarding and empty states.
- Error recovery for failed AI, failed capture, and stale media.

Acceptance checks:

- End-to-end demo projects can be created, edited, saved, reloaded, rendered, and shared.
- Core flows have automated coverage.
- Security posture is documented for untrusted repository execution.
