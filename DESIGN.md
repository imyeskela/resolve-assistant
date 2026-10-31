# Resolve Assistant

## Application interface
Compact dark utility in the visual language of DaVinci Resolve: neutral charcoal
panels, restrained borders, 11–12 px Segoe UI labels, small rectangular controls,
and a muted blue primary action. The preview is framed by a dark viewer and fits
its exact aspect ratio. The panels scroll internally where needed; the
application window has no global scrollbars at normal desktop sizes.

UI colors: background #202020, panels #292929, controls #363636, text #D6D6D6,
muted text #A1A1A1, primary action #4A6574, keyboard focus #8BC4E5. Focus on the
prompt belongs to the entire composer border, with no textarea outline to clip.

Each composition starts with logical V1 and a persistent chat per logical version.
The viewer has a version strip and a plus button below it; the chat stays to the
right even before a scene exists. There is no layout switch or bottom chat.
Only plus creates another visible version. reply appends text; revise creates an
immutable job inside the addressed logical version. Per-message result buttons
select their exact revision for preview, rendering and import.

Schema v2 embeds versions in project-owned jobs/.conversations documents. Each
version has own messages, draft, settings, manualDurationSeconds, context mode,
selectedRevisionId and revisionIds. A frozen baseSnapshot captures source,
history, assets and context IDs at branching; parent changes cannot mutate it.
Jobs retain their original paths/MOV/imports, logicalVersionId and durable turn
metadata. Recovery reconciles complete job metadata into an existing version,
restores its answer once, and never fabricates another visible version.

Migration backs up old metadata with a unique pre-v2 filename, retains each
old visible result and the full uncertain history, and repairs legacy context
references without moving originals. Corrupt compositions are isolated. Unscoped
legacy documents remain unbound on reads; explicit send/plus binds them to the
current project with a pre-bind backup. Their revisions inherit effective scope.

## Composition defaults
New drafts use Remotion unless the user has explicitly saved another engine
preference. Existing jobs without an engine are HyperFrames. Selecting a job
restores its exact width, height, FPS, duration and engine without changing the
user's new-draft engine preference. Resolution and FPS inherit the active Resolve
timeline (or project fallback) until individually changed. A visible source label
and “Из Resolve” action explain and restore inheritance. Context refreshes retain
manual settings, current selection and unfinished prompt text.

Resolution uses a named base landscape preset and a separate “Вертикальный”
checkbox that swaps dimensions. Square presets disable orientation and stay
unchecked. Exact inherited and saved custom dimensions are represented by a
matching base size plus orientation; they are never rounded to a preset. A
visible reduced aspect ratio describes the editable settings: 16:9, 9:16, 1:1,
or the exact custom/DCI ratio (4096 × 2160 is 256:135). An existing composition's
viewer and clip metadata continue to describe its saved plan while these controls
configure the next revision of the selected logical version. Transport uses a drawn two-bar pause icon and the
visible Russian label “Пауза”. The demo remains available without the local/AI
caption; the prototype/version footer is omitted.


## Generated graphics
The composition background is transparent unless explicitly selected otherwise.
The checkerboard belongs to preview chrome only. Graphics may retain the warm
editorial palette: foreground #F5F1E9, accent #F39B59, secondary ink #293F52.
Segoe UI is the default local font; Georgia is an optional serif. Cyrillic support
is required. Use 0.3–0.7 second eased entrances and finish exits before clip end.
Avoid continuous decorative movement unless requested.

## Constraints
No remote fonts, scripts, images or CDN dependencies. No gradients, glow or glass
in the application interface. No checkerboard in exported media. No generated
executable JavaScript in the privileged host. Model reasoning choices come only
from the actual account model catalog; unavailable capabilities stay disabled.

## Trusted video duration and speech
The renderer displays current range duration to one decimal and disables the
field only when a current valid range is enabled. Its focusable wrapper carries
the In/Out explanation. Manual seconds are stored separately, before quantizing
to output frames; disabling context restores them. Source settings keep exact
requestedDuration and durationMode, while frameCount=max(1,round(seconds*fps))
and duration=frameCount/fps. Host verifies the displayed range key; controller
derives duration from its captured range, stripping renderer/model mode claims.
Remotion and HyperFrames persist context timing through normalization and render.

Explicit message preparation reads existing Resolve transcription, including
nested transcripts; if needed it invokes native transcription with bounded
waiting, cancellation and project/range revalidation. It never runs from polls.
Source audio fallback maps trim/source timecode/FPS only for supported enabled
normal-speed clips. Unsupported timing and SDK errors stay distinct from silence.
Words intersect [In,Out+1), silence/doubles are removed. Frames survive unavailable
speech, but speechIncluded requires actual selected text. The playhead is restored
before slow speech preparation. Actual JavaScript SDK speech remains a live QA
requirement, separately from stubs and Python SDK availability.

Input snapshots persist in jobs/.contexts before model invocation, even for
text-only replies. Metadata correlates project/composition/version/message/range,
frame files and speech status/source/error. Inherited reference attachments carry
snapshot IDs; request budgets disclose omitted history, text and images. Files
are resolved from controller-owned manifests, never renderer-supplied paths.
Preview remains limited to exact correlated controller job URLs and runtime assets.

Headless tests run serially so real browser/render load does not starve the short
watchdog fixtures. HyperFrames CI mode suppresses detached warm-check daemons
that retain Windows job directories after check completion.
