# Composition Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persistent per-composition chat with real conversational answers and branched versions in the existing Resolve integration.

**Architecture:** Keep immutable job folders as versions; add project-scoped conversation documents under jobs/.conversations. Reuse the existing isolated app-server request with structured reply-or-revision output and explicit local conversation history. Extend the host allowlist and preview registration without widening renderer privileges.

**Tech Stack:** Existing CommonJS Node, vanilla renderer, Electron, Codex app-server, Remotion/HyperFrames.

**Spec:** ../specs/2026-10-30-composition-chat-design.md

## Global Constraints

- Fixed chat to the right of preview; versions below preview; clip inspector far right.
- No new dependencies, alternate billing, tools or privileges for generated content.
- Preserve legacy jobs, output paths and imports.
- All chat state is scoped to the Resolve project and workspace roots.

## Review Focus

- A late response or refresh after switching project must not attach to another chat.
- Questions, cancellation and malformed responses must not create versions.
- Old-version edits preserve the actual selected source, video settings and parent ID.
- Restart and folder changes must preserve history without duplicate legacy migrations.
- Preview policy must authorize only controller-validated nested job responses.

### Task 1: Persist conversations and version references

Files: lib/conversations.cjs, lib/controller.cjs, tests/conversations.test.cjs, tests/chat-controller.test.cjs.

- [x] Add failing behavior tests for legacy migration, restart, project isolation, branched edits, errors and preserved media.
- [x] Implement ConversationStore load/create/get/save and controller conversation.create/get/update plus chat.send.
- [x] Test real file persistence and controller using a stub only at the external model request boundary.

### Task 2: Real model dialogue

Files: lib/codex.cjs, tests/chat-generation.test.cjs.

- [x] Test structured text-only/revision replies, current version plus bounded history and malformed output.
- [x] Add buildChatRequest and normalizeChatResult; share the existing RPC runner between generatePlan and generateChatTurn.
- [x] Keep the original generate method compatible; exercise existing generation/watchdog/session tests.

### Task 3: Wire host and implement the selected interface

Files: plugin/host.cjs, plugin/preview-policy.cjs, plugin/index.html, plugin/styles.css, plugin/renderer.js; tests/ui.test.cjs and host/preview policy tests.

- [x] Add tests for chat IPC stripping untrusted attachments and trusted nested preview registration.
- [x] Add UI behavior tests for independent chats, versions, questions, draft preservation, pending/error states and fixed right-hand layout.
- [x] Implement persisted composition list, version strip, conversation log and send; preserve inspector/export/account behavior.
- [x] Verify the renderer at 1380×900, 1024×640 and 800×600; chat must stay beside the viewer.

### Task 4: Verification and delivery

- [x] Run npm test and npm run check; fix failures by diagnosis and targeted regression tests.
- [x] Smoke-render supported compositions; inspect live UI and optionally a minimal real question/revision through the existing signed-in account.
- [x] Run one independent whole-change review, address important findings, update README and DESIGN.md.
- [x] Confirm the installed loader points to this workspace; leave a concrete report with any manual restart needed.

No git repository exists here; use the source backup at .superpowers/chat-versions-backup instead of worktree/commit steps. Work natively in this session; the approved product layout is the authority.
