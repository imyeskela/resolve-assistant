# Preview and Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox syntax.

**Goal:** Close persisted-preview execution and replace outdated application runtimes before installer work.

**Architecture:** Rebuild preview from normalized scene data into a private temporary cache. Resolve all operational Node/FFmpeg binaries from a verified, pinned project-local installation.

**Tech Stack:** Windows x64, CommonJS Node.js, PowerShell/.NET ZIP extraction, existing Remotion/HyperFrames compilers.

**Spec:** `docs/superpowers/specs/2026-10-31-preview-runtime-design.md`

## Global Constraints

- Branch `security/preview-runtime-hardening`; no changes to `master`.
- Preserve user jobs, MOV paths, credentials and global tools.
- No executable binaries or user data in Git; no external AI requests in tests.
- No runtime fallback to system Node/FFmpeg or executable assets from saved jobs.

## Review Focus

- Tampered HTML/bundle/GSAP must never execute; original files remain intact.
- Legacy HyperFrames and saved Remotion plans must still preview correctly.
- Concurrent requests, changed revisions and server shutdown must not leak cache directories or serve unvalidated output.
- Failed download/checksum/extraction must preserve the installed runtime.
- Host, frame conversion, both renderers, helper children and npm entrypoints must use the pinned executables.

### Task 1: Trusted preview cache (preview agent)

**Files:** new `lib/preview-cache.cjs`, preview server in `lib/render.cjs`, preview security tests.
**Interface:** existing `startPreviewServer(getJob)` URL contract; cache consumes plan data only and returns rebuilt allowlisted files, with close cleanup.

- [x] Reproduce tampered saved HTML/bundle execution and missing-plan behavior with synthetic tests.
- [x] Implement bounded normalization, trusted compilation, revision cache and shutdown cleanup.
- [x] Verify malicious persisted content is absent, files preserved, both engines functional, changed plans rebuilt and concurrent requests bounded.
- [x] Extend the same trust boundary to `renderMotion` and `renderRemotion`: rebuild privately, validate numeric wrapper settings, publish only verified MOV without overwriting user source or deleting previous output on failure.

### Task 2: Verified local runtime (runtime agent)

**Files:** `runtime-manifest.json`, `lib/runtime.cjs`, `scripts/setup-runtime.cjs`, runtime tests.
**Interface:** synchronous `runtimeExecutable(name)`, `runtimePaths()`, `assertCurrentRuntime()`.

- [x] Verify supported patched Node and stable FFmpeg versions from primary upstream sources; pin URLs, checksums and provenance.
- [x] Write failing tests for missing/corrupt artifacts, unsafe extraction and failed replacement preserving existing files.
- [x] Implement staged installation, selective safe extraction and fail-closed executable resolution.
- [x] Install locally, verify versions/checksums and targeted tests; retain licensing materials.

### Task 3: Route application execution through local runtime (root)

**Files:** `scripts/run.cjs`, `scripts/install-plugin.ps1`, `plugin/host.cjs`, `lib/render.cjs`, `lib/remotion.cjs`, `lib/remotion-worker.cjs`, `lib/video-context.cjs`, package scripts/dependencies and affected tests.

- [x] Add failing launcher/caller checks proving system paths cannot substitute for pinned binaries.
- [x] Replace direct old-package imports and process launch choices; remove unused old binary packages.
- [x] Run all tests and check under the pinned Node; verify real alpha MOV outputs for both engines and new FFprobe metadata.
- [x] Preserve fractional FPS through CLI-compatible rational arguments; verify decimal and exact NTSC rates in real MOV streams without snapping their numeric values.

### Task 4: Independent review and publication (review agent/root)

- [x] Review cache trust boundaries, runtime completeness, upgrade failures and operational integration.
- [x] Resolve actionable review findings and rerun affected/full checks as needed.
- [x] Update privacy/audit/readme with exact outcomes and remaining installer-only validation.
- [x] Secret-scan staged changes.
- [ ] Commit and publish a draft PR against the audit branch; do not merge into master.
