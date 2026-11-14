# OpenChamber Pet — Implementation Checklist

An OpenChamber extension that puts an animated pet (sprite-sheet fox) on the right-hand
rail, reacting live to what the AI agents are doing. Simulating ChatGPT's pet feature.

- Docs: https://docs.openchamber.dev/sdk/ (Build an extension), https://docs.openchamber.dev/sdk/host/ (Host API), https://docs.openchamber.dev/sdk/ui/ (UI kit)
- SDK source/examples: https://github.com/openchamber/openchamber/tree/main/packages/sdk (incl. `examples/`)
- Project folder (install path in Settings → Extensions): `/var/home/ricky/Projects/openchamber_pet`

## Locked decisions

- [x] Watch **all registered projects** via `host.onProjects` + `host.onSessions(projectId)` (needs only the `sessions` capability)
- [x] **Panel-only in v1** — no `contributes.service` / `sessionEvents` background service (Phase 6)
- [x] Sprite sheet: `pet_6af74a9195b48191953e1d99805b9a60-spritesheet.png`, 1536×2288 RGBA = **8 columns × 11 rows of 192×208 frames (88 frames)**, one animation per row
- [x] Open session preferred when several sessions are active; otherwise the "most active" session wins

## Extension contract (facts to build against)

- Folder with three things OpenChamber reads directly: `package.json` (manifest under `"openchamber"`), `panel/index.html`, and a **pre-built** `panel/main.js` — a single classic IIFE script (panel loads in a sandboxed iframe; `<script src="main.js">`, no ES modules). OpenChamber never compiles; commit the built file.
- Build: `bunx openchamber-guest-bundle panel/main.ts panel/main.js` (or `esbuild panel/main.ts --bundle --format=iife --platform=browser --outfile=panel/main.js`).
- Manifest: `apiVersion: 1`, `engines.openchamber` (e.g. `">=2.7.0"`, current release is 2.7.0), kebab-case unique `id`, `contributes.panel { id, name, icon, entry }`. `icon` = Remixicon name or an SVG file in the folder.
- Dev install: OpenChamber → Settings → Extensions → Add → paste the absolute folder path → approve the capabilities dialog → icon appears on the rail. Folder installs run from the folder: edit → rebuild → reload.
- Host API (`import { connectHost, applyHostReady } from "@openchamber/sdk"`):
  - `const host = connectHost()`; call `applyHostReady(ctx, document.documentElement)` before mounting UI (applies theme tokens); `ctx.theme.tokens`, `ctx.locale`, `ctx.surface` (`"panel"`), `ctx.session` (`{ id, title, busy, model?, agent? } | null`), `ctx.directory`.
  - No-permission reads: `host.onSession(cb)`, `host.onSessionLifecycle(cb)` (`phase`: `started` | `completed` | `failure`). Late subscribers get the latest value replayed.
  - With `capabilities: ["sessions"]`: `host.onProjects(cb)`, `host.onSessions(projectId, cb)` → snapshot `{ sessions, state }`; session has `activity`: `unknown | idle | running | retrying | waiting-permission | waiting-question`, `outcome`: `completed | failed | null`, and while running a `tool` (`{ name, target }`, e.g. `read`/`edit`/`bash`). Max 32 subscriptions per iframe — fine. Also `host.listProjects()`.
  - `host.storage` — persistent JSON for this extension's settings. `host.setBadge(n | null)` — number on the rail icon. `host.toast({ kind, message })`.
  - Calls needing an unapproved capability fail with `NOT_GRANTED`.
- UI kit: `import { ... } from "@openchamber/sdk/ui"` — themed buttons/fields/tabs/lists matching the app; use it for settings, raw HTML/CSS only for the canvas.
- CSP/sandbox: no remote resources; the sprite must be a local file inside the extension folder, referenced relatively.

## File layout to create

```
openchamber_pet/
├── PLAN.md                  # this file
├── package.json             # manifest + devDependency @openchamber/sdk (pin to installed app version)
├── icon.svg                 # rail icon (paw)
├── README.md
├── .gitignore               # node_modules/
├── assets/
│   ├── spritesheet.png      # moved from pet_6af74a9195b48191953e1d99805b9a60-spritesheet.png
│   └── animations.json      # generated: name → { row, startCol, frames, fps, loop, flip? }
├── tools/
│   └── slice.py             # verifies 8×11 grid (192×208), regenerates animations.json
└── panel/
    ├── index.html           # canvas + status line + settings; loads main.js
    ├── main.ts              # source
    └── main.js              # built IIFE (committed)
```

## Phase 0 — Scaffold

- [x] `git init` in `/var/home/ricky/Projects/openchamber_pet`
- [x] `package.json`:
  - `"name": "@ricky/openchamber-pet"`, `"version": "0.1.0"`, `"private": true`
  - `"openchamber"`: `apiVersion: 1`, `engines: { "openchamber": ">=2.7.0" }`, `id: "ricky-pet"`, `name: "Pet"`, `icon: "icon.svg"`,
    `contributes: { panel: { id: "ricky-pet", name: "Pet", icon: "icon.svg", entry: "panel/index.html" }, capabilities: ["sessions"] }`
  - `devDependencies: { "@openchamber/sdk": "^2.7.0" }` (+ esbuild/typescript for the local build)
- [x] `icon.svg` (simple paw, themed neutrally)
- [x] `.gitignore` → `node_modules/` (+ generated contact sheet/zooms)
- [x] `README.md` — what it is, install steps, dev loop, asset credit
- [x] `npm install` (SDK for types only; it gets bundled into main.js)

## Phase 1 — Sprite pipeline

- [x] Moved spritesheet → `assets/spritesheet.png`
- [x] `tools/slice.py` (pillow+numpy): asserts 1536×2288, verifies empty gutters at multiples of 192/208, reports per-cell alpha occupancy, row-vs-row diffs, writes a labeled contact sheet
- [x] Contact sheet generated and all 11 rows labeled in `assets/animations.json` (idle, run, runLeft, wave, surprised, curious, excited, happy, blush, glance, worried); row diffs confirmed rows 1–2 are distinct run variants (runLeft kept as its own row)
- [x] `assets/animations.json` written and verified against measured occupancy (`slice.py --write-json`)
- [x] Sanity check: total occupied cells = 6+8+8+4+5+8+6+6+6+8+8 = 73 frames across 11 rows — matches

## Phase 2 — Renderer / panel shell

- [x] `panel/index.html`: full-height layout, `<canvas id="pet">`, status `<div id="status">`, settings container, `<script src="main.js">`; no remote anything
- [x] `panel/main.ts`:
  - [x] `const host = connectHost()`; `host.onReady(ctx => applyHostReady(ctx, document.documentElement))`
  - [x] Loads `../assets/spritesheet.png` as `Image`, `../assets/animations.json` via fetch
  - [x] Player: rAF loop, `ctx.drawImage(sheet, col*192, row*208, 192, 208, …)`; `imageSmoothingEnabled = false`; scales to panel; `flip` via `ctx.scale(-1,1)`
  - [x] `ResizeObserver` on the stage re-fits the canvas (devicePixelRatio-aware)
  - [x] Pauses when hidden (`document.visibilitychange` cancels rAF)
  - [x] Theme from `ctx.theme.tokens` CSS vars (`--oc-*`); idles immediately once assets load
- [x] Build: `npx esbuild panel/main.ts --bundle --format=iife --platform=browser --outfile=panel/main.js` (bun not installed; `openchamber-guest-bundle` needs bun — esbuild fallback used); `panel/main.js` committed
- [ ] Install: OpenChamber → Settings → Extensions → Add → `/var/home/ricky/Projects/openchamber_pet` → approve `sessions` → rail icon appears; click it, pet idles (in-app step, not yet done in this environment)
- [x] Verify: edit → rebuild → reload loop works from the folder install (via `tools/mock-host.html` headless harness)

## Phase 3 — Reactivity (state machine)

- [x] Subscribers: `host.onSession`, `host.onSessionLifecycle`, `host.onProjects` → per project `host.onSessions(projectId, …)` with token-guarded stop functions; re-subscribes on project list changes; generation counter guards stale async
- [x] Derive pet state each snapshot:
  - [x] Pick session: open session preferred when active; else most active by priority `running > waiting-permission/waiting-question > retrying > idle > unknown`, with an uncelebrated turn outcome breaking idle ties
  - [x] Map to animation (table below); `MIN_DISPLAY_MS ≈ 1500` anti-strobe; one-shots (wave/happy/sad) play once then return to the current loop; queued outcomes are marked consumed only when playback starts
  - [x] Status line text: `watching <agent> run bash <target> in <project>` / `is idle` / `needs you — permission request in <project>`, using `tool.name`/`tool.target`, `agent`, project name
- [x] `onSessionLifecycle` phases wired: `started` → wave one-shot + resets outcome memory; `completed`/`failure` → queued happy/sad one-shot (deduped against snapshot signals)

### State → animation mapping

| Agent state (host API) | Animation | Notes |
|---|---|---|
| no session / `activity: idle` | `idle` (row 0) | baseline, occasional blink |
| `running` + tool `read`/`glob`/`grep`/`search` | curious / look-around row | `session.tool.name` + `target` |
| `running` + tool `edit`/`write`/`patch` | working row | |
| `running` + tool `bash`/`shell` | `run` (rows 1–2, flip if needed) | loop |
| `running` + other tool | generic work row | |
| `retrying` | worried row | |
| `waiting-permission` / `waiting-question` | attention / question row | also `host.setBadge(1)` |
| `outcome: completed` (turn finished) | happy one-shot | then back to loop |
| `outcome: failed` | sad one-shot | then back to idle |

(Row numbers get filled in from Phase 1 labeling.)

## Phase 4 — Polish

- [x] Settings UI from `@openchamber/sdk/ui` (themed): pet name (shown in status line), animation speed multiplier, watch scope (all projects vs current session only), enabled on/off
- [x] Persist settings in `host.storage` (get/set JSON, debounced); applied on load
- [x] `host.setBadge(waiting ?? running count)` clamped to `GUEST_BADGE_MAX`; cleared when none
- [x] Guards: duplicate-mount protection, generation counter for stale async, per-subscription tokens so superseded registrations can't leak or clobber
- [x] Error handling: `NOT_GRANTED` → friendly "enable the sessions capability in Settings → Extensions" empty state (gated so late settings load can't undo it); `host.onConnection` → disconnected banner

## Phase 5 — Verification checklist

Automated via `tools/mock-host.html` (a mock host speaking the real SDK wire protocol, driven headless by playwright against `panel/main.js`): serve the folder (`python3 -m http.server`), open `/tools/mock-host.html`, read PASS/FAIL lines. `?grant=0` covers the NOT_GRANTED empty state.

- [x] Pet idles with no session open
- [x] Session running: switches animation by tool type (bash→run, read→curious, edit→excited)
- [x] Permission prompt → surprised animation + badge 1
- [x] Turn completes → happy one-shot → idle; failed turn → sad one-shot; duplicate signals for the same turn don't replay; a new turn celebrates again; an outcome arriving during another one-shot is queued, not lost
- [x] Second project with a running session while first is idle → pet follows the running one
- [x] Settings persist across reload (name change → save → iframe reload → restored); live status update
- [x] Disconnected → banner shown
- [x] NOT_GRANTED → empty state with instructions
- [ ] Light + dark theme both look right (theme tokens) — manual in-app check
- [x] Panel hidden → no rAF burn (visibilitychange cancels rAF; verified by code review)
- [ ] Fresh install path: zip the folder (without node_modules) → installs from zip too — manual in-app check

## Phase 6 — Later (not v1)

- [ ] `contributes.service` + `contributes.sessionEvents` (`turn-started`, `turn-finished`, `turn-failed`, `permission-asked`, `question-asked`) so the pet knows about agent activity even with no window open; service posts state to the panel
- [ ] `shells` capability + `host.onRunningShells({ kind: "project", projectId }, …)` for shell-level reactions
- [ ] More animations / more pets (multiple sheets selectable in settings)
- [ ] Distribution: push to a git repo, share the `https://…git` URL (updates via version bump in package.json); optional community-catalog listing on openchamber.dev/extensions

## Dev loop (repeat)

```bash
cd /var/home/ricky/Projects/openchamber_pet
# edit panel/main.ts (and assets/animations.json via tools/slice.py)
bunx openchamber-guest-bundle panel/main.ts panel/main.js
# in OpenChamber: reload the extension panel (or restart the app); folder install runs from this folder
```
