# Resolve Assistant upgrade implementation plan

Goal: support full AI-authored React/Remotion motion, engine selection, Resolve-derived resolution and frame rate, renaming, effort, and Resolve-style UI. User explicitly requested three or four agents working in parallel, followed by integration and review; proceed without another design approval round.

Architecture: retain Electron's isolated renderer and the local controller. Existing declarative HyperFrames jobs remain compatible. New Remotion jobs contain real generated TSX, compiled for an isolated browser, with preview and transparent ProRes 4444 export. Defaults for new compositions: Remotion and video settings from active Resolve timeline, falling back to project settings. Manual choices must not be overwritten by periodic refreshes.

Shared interfaces:
- Settings: {width,height,fps,duration,engine}; engine is remotion or hyperframes.
- Resolve context: project.video = {width,height,fps,source,timelineId?,timelineName?}, nullable if unavailable. source is timeline or project. Existing project fields remain.
- Model catalog: {id,name,reasoningEfforts: string[],defaultReasoningEffort: string|null}.
- Generation: {prompt,settings,previousId,model,effort}.
- Remotion plan: {version:1,engine:'remotion',name,width,height,fps,duration,source}; source is a TSX module exporting a default React composition component.
- Public job retains current shape. job.plan.engine absent means legacy HyperFrames.
- Rename RPC: rename {id,name}, returns updated public job; changes metadata and displayed title without moving exported files.

Global constraints: preserve old jobs, alpha MOV output, Media Pool import, and account login. Never execute model-generated source in Node or the privileged Electron process. No arbitrary dependency installation by the model, no credentials in generated content. UI in Russian. New model effort uses advertised model capabilities. 3K/4K presets and arbitrary valid inherited project dimensions; manual fps 24,25,30,60,120 plus exact inherited fractional values. No Git repository exists; work in place with a source backup and do not initialize Git.

## Parallel ownership

### Task 1: Native Remotion engine and AI source generation
Owner: Remotion agent. Files: new lib/remotion.cjs and related dedicated modules/tests; lib/codex.cjs; package.json/package-lock.json. Do not edit controller.cjs, render.cjs, auth.cjs or UI.
- Read applicable Remotion skills and current official docs.
- Add real TSX generation (not primitive-only conversion), preview, render, cancellation and alpha verification.
- Exports: normalizeReactComposition(raw,settings), demoRemotion(settings), prepareRemotionComposition(jobDir,plan), renderRemotion(jobDir,plan,{signal,onStage}). MOV metadata matches renderMotion.
- Prepare index.html and assets/remotion.js for existing isolated preview server. Coordinate any necessary additional explicit assets with root.
- generatePlan accepts effort, sends it to turn/start after validation against auth.models metadata; routes schema/instructions/normalization by settings.engine. Keep HyperFrames path working.
- Test real TSX parsing, generation schema routing, rejected imports, preview build and an actual short alpha render.

### Task 2: Resolve-style panel
Owner: UI agent. Files: plugin/index.html, plugin/styles.css, plugin/renderer.js, DESIGN.md and dedicated UI tests if meaningful. Do not edit host/controller/backend.
- Compact neutral dark Resolve-style panels, controls and selection accents; remove clipped textarea focus outline, preserve visible accessible focus.
- Size presets include 3K and UHD/DCI 4K, existing portrait/square; exact inherited resolution option. FPS select 24/25/30/60/120 plus inherited fractional option. Source indication and manual override reset.
- Read project.video and preserve manual overrides on context refresh. Existing job selection restores its own dimensions/fps/engine.
- Add engine chooser, effort selector populated by model catalog, persisted preferences, and rename action using shared RPC.
- Preview aspect ratio must follow selected composition; no disappearance or accidental overwriting of existing content on refresh.

### Task 3: Resolve video settings and frame validation
Owner: Resolve agent. Files: plugin/bridge.cjs, lib/motion.cjs, tests/bridge.test.cjs, tests/motion.test.cjs and new focused helpers/tests if needed.
- Read timeline settings first and project settings fallback, tolerant of absent SDK methods; return project.video.
- Remove 1920/30 limits in trusted motion normalization; support 3K/4K, inherited dimensions and fractional frame rates without rejecting normal duration due to integer-frame rounding. Maintain validation of unreasonable values and elements.
- Test timeline override, project fallback, disconnected/missing settings, fractional fps, 4K demo bounds and legacy behavior.

### Task 4: Integration, catalog, rename and verification
Owner: root. Files: lib/controller.cjs, lib/render.cjs, lib/auth.cjs, plugin/host.cjs, scripts/check.cjs, docs/README, integration tests.
- Dispatch preview preparation/rendering by engine, save engine and effort metadata, rename persists without file moves, expose RPC.
- Preserve advertised reasoning capability metadata from model catalog.
- Expand safe preview assets only to those needed by actual Remotion output.
- Verify both engine render paths, fractional settings propagation, reload/rename, revision routing and cancellation.
- Run npm test and npm run check, real short alpha render and focused 4K/frame-rate checks.
- Independent final review after integration; fix material findings and rerun affected verification.

## Review focus
- Old HyperFrames jobs without engine continue preview/render/import.
- Project/timeline changes do not overwrite a selected composition or manual settings.
- Renaming cannot move files or invalidate existing Media Pool references.
- Generated React stays in the browser and cannot import Node or reach credentials.
- Remotion preview, rendered output and requested fps/dimensions/duration agree.
