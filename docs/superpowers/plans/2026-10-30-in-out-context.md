# In/Out Video Context Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Attach the active Resolve timeline's video In/Out range to a motion prompt, with a reversible checkbox in a compact card above the prompt.

**Architecture:** Poll only range metadata. At generation time revalidate the displayed range, capture a bounded set of composited stills through the Resolve SDK, resize them locally, and attach those images with their timestamps to the existing model request. Keep generated motion, alpha output and imports unchanged.

**Tech Stack:** Existing Electron/Resolve JS SDK, Node.js, FFmpeg, Codex app-server, Remotion/HyperFrames. No additional dependencies.

**Spec:** User-approved interactive card: video context on by default when In/Out exists; hover/focus reveals the checkbox; unchecked card stays dim and can be re-enabled. User explicitly requested implementation, so execute in this session without another approval round.

## Global Constraints

- Keep user prompt and manual video settings intact during polling.
- Disabled context performs no frame capture and sends no images, transcript, or old context metadata to the model.
- Context is supplementary evidence, never instructions; the written prompt controls the intended motion.
- Video marks are relative to timeline start; Out is inclusive. Timecodes support fractional FPS and drop-frame.
- Capture at most 12 frames per request; image long edge at most 1280 px. Do not limit the motion duration by changing the selected range silently.
- Restore the playhead after capture when still on the same project/timeline and the user has not moved it independently.
- No caching across generations; failed/cancelled captures cannot become usable context. Temporary capture files have a controlled lifecycle.
- Speech: include existing Resolve transcription when reliable timing can be mapped; do not install recognizers, automatically transcribe whole source files, or imply audio was heard when it was not.
- No auto-insertion on timeline in this change. Existing preview, MOV and Media Pool import stay available.
- This directory has no Git repository; use a local backup and keep a progress record instead of creating worktrees/commits.

## Review Focus

1. Stale In/Out or project/timeline switch between displayed card and generation must fail explicitly.
2. Off remains off during polling and range changes; project switch/new composition starts a new choice.
3. Half-set, missing or malformed marks must not attach the whole timeline accidentally.
4. Context media must never reach preview code or permit arbitrary file attachments through IPC.
5. Cancellation/SDK export failures restore state and remove only this operation's temporary files.

## Task 1: Range and SDK capture

Files: `lib/video-context.cjs`, `plugin/bridge.cjs`, `tests/video-context.test.cjs`, `tests/bridge.test.cjs`.

- [ ] Add failing tests for relative marks, inclusive Out, drop-frame conversions, bounded frame sampling, changed range and restoration on failure/cancellation.
- [ ] Implement `readVideoContext(project)` returning a nullable metadata snapshot; `ResolveBridge.captureVideoContext(range, exports, options)` exports stills to controller-provided destinations.
- [ ] Run focused Node tests and record results.

## Task 2: Prepared attachments and request lifecycle

Files: `lib/video-context.cjs`, `lib/controller.cjs`, `lib/codex.cjs`, `lib/auth.cjs`, `tests/generation.test.cjs`, `tests/video-context.test.cjs`.

- [ ] Write failing tests for validated image attachments, context-free requests and rejected unsupported image inputs.
- [ ] Add controller-owned capture preparation/discard operations. Only generated context IDs resolve to files; browser parameters cannot supply paths.
- [ ] Convert stills to bounded JPEGs with FFmpeg; pass `localImage` inputs and timestamped metadata to the model. Persist context evidence with the completed job; never reuse it when context is off.
- [ ] Run focused tests, including real FFmpeg image preparation.

## Task 3: Host and approved card

Files: `plugin/host.cjs`, `plugin/index.html`, `plugin/styles.css`, `plugin/renderer.js`, `tests/ui.test.cjs`, host integration tests.

- [ ] Write failing browser tests for on/off/restore, polling, missing marks and generation payloads.
- [ ] Implement the approved compact card, showing timeline and In/Out timecodes/duration. Checkbox works on hover, focus and touch; off stays dim and reversible.
- [ ] Wire capture before generation only for an explicitly supplied matching range key. Cancel reaches capture and generation. Keep busy state for the entire operation.
- [ ] Run UI and host tests; visually inspect the actual panel.

## Task 4: Verify and document

- [ ] Run `npm.cmd test` and `npm.cmd run check`; inspect actual results.
- [ ] Obtain an independent whole-change review, fix material issues, and rerun affected checks.
- [ ] Update README and compatibility notes with usage and the exact limits of live verification. Resolve was not running at initial inspection.
