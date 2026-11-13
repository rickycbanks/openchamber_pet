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

- [ ] `git init` in `/var/home/ricky/Projects/openchamber_pet` (not a repo yet)
- [ ] `package.json`:
  - `"name": "@ricky/openchamber-pet"`, `"version": "0.1.0"`, `"private": true`
  - `"openchamber"`: `apiVersion: 1`, `engines: { "openchamber": ">=2.7.0" }`, `id: "ricky-pet"`, `name: "Pet"`, `icon: "icon.svg"`,
    `contributes: { panel: { id: "ricky-pet", name: "Pet", icon: "icon.svg", entry: "panel/index.html" }, capabilities: ["sessions"] }`
  - `devDependencies: { "@openchamber/sdk": "^2.7.0" }` (version matches the installed app; check Settings → About)
- [ ] `icon.svg` (simple paw, themed neutrally)
- [ ] `.gitignore` → `node_modules/`
- [ ] `README.md` — what it is, install steps, dev loop, asset credit
- [ ] `npm install` (SDK for types only; it gets bundled into main.js)

## Phase 1 — Sprite pipeline

- [ ] Move `pet_6af74a9195b48191953e1d99805b9a60-spritesheet.png` → `assets/spritesheet.png`
- [ ] Write `tools/slice.py` (pillow+numpy): load PNG, assert size 1536×2288, verify empty gutters at multiples of 192 (cols) and 208 (rows), report per-cell alpha occupancy
- [ ] Generate a downscaled contact sheet (like the one used in planning) and **label each of the 11 rows** with an animation name by looking at it. Known so far: row 0 = idle/blink (6 frames, cols 6–7 empty), rows 1–2 = run cycle (8 frames; row 2 occupancy identical to row 1 — diff frames to see if it's a variant or duplicate; use canvas flip if duplicate)
- [ ] Write `assets/animations.json`, e.g. `"idle": { "row": 0, "startCol": 0, "frames": 6, "fps": 6, "loop": true }`, `"run": { "row": 1, ... "fps": 10 }`, …
- [ ] Sanity check: total occupied cells = 6+8+8+4+5+8+6+6+6+8+8 = 73 frames across 11 rows

## Phase 2 — Renderer / panel shell

- [ ] `panel/index.html`: full-height layout, `<canvas id="pet">`, status `<div id="status">`, settings container, `<script src="main.js">`; no remote anything
- [ ] `panel/main.ts`:
  - [ ] `const host = connectHost()`; `Ready(ctx => applyHostReady(ctx, document.documentElement))` (SDK's ready helper — check `packages/sdk/examples` for exact export name)
  - [ ] Load `../assets/spritesheet.png` as `Image`, load `../assets/animations.json` via fetch
  - [ ] Player: `requestAnimationFrame` loop, current animation from `animations.json`, `ctx.drawImage(sheet, col*192, row*208, 192, 208, dx, dy, dw, dh)`; `imageSmoothingEnabled = false`; scale to panel width; flip via `ctx.save(); ctx.scale(-1,1)` when `flip`
  - [ ] `ResizeObserver` on the panel to re-fit canvas (devicePixelRatio-aware)
  - [ ] Pause when hidden (`document.visibilitychange`) — no CPU burn with the rail closed
  - [ ] Theme: background/text from `ctx.theme.tokens` CSS vars; default to idle animation so the panel is alive immediately
- [ ] Build: `bunx openchamber-guest-bundle panel/main.ts panel/main.js` (install bun if missing; fallback esbuild command above)
- [ ] Install: OpenChamber → Settings → Extensions → Add → `/var/home/ricky/Projects/openchamber_pet` → approve `sessions` → rail icon appears; click it, pet idles
- [ ] Verify: edit → rebuild → reload loop works from the folder install

## Phase 3 — Reactivity (state machine)

- [ ] Subscribers: `host.onSession`, `host.onSessionLifecycle`, `host.onProjects` → for each project `host.onSessions(projectId, snap => …)` (store stop functions; re-subscribe on project list changes)
- [ ] Derive pet state each snapshot:
  - [ ] Pick session: prefer `ctx.session.id` if it's active; else most active by priority `running > waiting-permission/waiting-question > retrying > idle > unknown`
  - [ ] Map to animation (see table below); keep `minDisplayMs ≈ 1500` per animation so it doesn't strobe; one-shot animations (happy/sad) play once then return to the current loop state
  - [ ] Status line text: e.g. `watching <agent> run bash in <project>` / `idle` / `waiting for your permission`, using session `tool.name`/`tool.target`, `agent`, project directory
- [ ] Wire `onSessionLifecycle` phases (`started`/`completed`/`failure`) as extra signals for one-shot happy/sad on the open session

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

- [ ] Settings UI from `@openchamber/sdk/ui` (themed): pet name (shown in status line), animation speed multiplier, watch scope (all projects vs current session only), enabled on/off
- [ ] Persist settings in `host.storage` (get/set JSON); re-apply on `host.onSettings`/storage change
- [ ] `host.setBadge(count of running sessions)`; cleared when panel opens (host does this) / when none running
- [ ] Guard: duplicate mount protection (mount once, then only update), generation counter so stale async responses don't paint over newer state (pattern from SDK example)
- [ ] Error handling: `NOT_GRANTED` → friendly "enable the sessions capability in Settings → Extensions" empty state; `host.onConnection` to show disconnected state

## Phase 5 — Verification checklist

- [ ] Pet idles with no session open
- [ ] Start a session and send a prompt: pet reacts while `busy`/`activity: running`, switches animation by tool type (read vs edit vs bash)
- [ ] Permission/question prompt → attention animation + badge 1
- [ ] Turn completes → happy one-shot → idle; failed turn → sad one-shot
- [ ] Second project with a running session while first is idle → pet follows the running one
- [ ] Settings persist across reload; speed/name/scope changes take effect live
- [ ] Light + dark theme both look right (theme tokens)
- [ ] Panel hidden → no rAF burn (check via devtools perf or just visibilitychange log)
- [ ] Fresh install path: zip the folder (without node_modules) → installs from zip too

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
