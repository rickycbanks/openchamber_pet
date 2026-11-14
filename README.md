# OpenChamber Pet

An OpenChamber extension that puts an animated pet (a sprite-sheet fox) on the
right-hand rail. The pet watches every registered project's sessions and reacts
live to what the agents are doing: reading, editing, running shell commands,
waiting for your permission, finishing a turn, or failing.

## Install

1. OpenChamber → **Settings → Extensions → Add** and paste this folder's
   absolute path (`/var/home/ricky/Projects/openchamber_pet`), or zip the folder
   (without `node_modules/`) and install the zip.
2. Approve the **`sessions`** capability in the dialog.
3. Click the paw icon on the rail — the pet starts idling.

## Dev loop

```bash
cd /var/home/ricky/Projects/openchamber_pet
# edit panel/main.ts (assets/animations.json is regenerated/verified by tools/slice.py)
npx esbuild panel/main.ts --bundle --format=iife --platform=browser --outfile=panel/main.js
# in OpenChamber: reload the extension panel (folder installs run from this folder)
```

`panel/main.js` is a committed, pre-built classic IIFE script — OpenChamber never
compiles extension code. (`bunx openchamber-guest-bundle panel/main.ts panel/main.js`
works too when bun is available.)

## How it works

- `host.onProjects` + `host.onSessions(projectId)` (capability `sessions`) feed a
  state machine; `host.onSession` / `host.onSessionLifecycle` refine it for the
  open session. The most active session wins (open session preferred when active).
- Each snapshot maps to a sprite animation from `assets/animations.json`
  (8×11 grid of 192×208 frames in `assets/spritesheet.png`): idle, run, curious,
  excited, surprised, worried, plus one-shot wave/happy.
- Settings (pet name, speed, watch scope, on/off) persist in `host.storage`.
- `host.setBadge` shows waiting/running session counts on the rail icon.

## Files

```
package.json          # manifest under "openchamber" + devDependencies
icon.svg              # rail icon (paw)
assets/spritesheet.png
assets/animations.json  # name → { row, startCol, frames, fps, loop, flip? }
tools/slice.py        # verifies the 8×11 grid, occupancy, writes a contact sheet
tools/mock-host.html  # dev-only mock host + scenario harness (PASS/FAIL log)
panel/index.html      # canvas + status + settings shell
panel/main.ts         # source
panel/main.js         # built IIFE (committed)
```

## Verification (headless)

`tools/mock-host.html` emulates the OpenChamber host frame (the real SDK wire
protocol from `@openchamber/sdk`) inside an iframe that loads `panel/index.html`,
then drives scripted session scenarios and logs PASS/FAIL:

```bash
cd /var/home/ricky/Projects/openchamber_pet
python3 -m http.server 8734 --bind 127.0.0.1 &
# open http://127.0.0.1:8734/tools/mock-host.html in a browser and read the log
# (?grant=0 exercises the NOT_GRANTED empty state)
```

The panel exposes a `window.__pet` debug handle (player state, settings, derive,
animation request log) used by the harness assertions.

## Asset credit

Sprite sheet: `pet_6af74a9195b48191953e1d99805b9a60-spritesheet.png` (1536×2288
RGBA, 88 cells of 192×208) as provided with the project — see PLAN.md.
