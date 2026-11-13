import { connectHost, HostRequestError, GUEST_BADGE_MAX } from '@openchamber/sdk';
import type {
  GuestProject,
  GuestSessionRecord,
  HostReadyContext,
  SessionLifecycleEvent,
  SessionSnapshot,
} from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountEmpty,
  mountSelect,
  mountSwitch,
  mountTextField,
} from '@openchamber/sdk/ui';

/* ------------------------------------------------------------------ */
/* Sprite sheet                                                        */
/* ------------------------------------------------------------------ */

const FRAME_W = 192;
const FRAME_H = 208;
const SHEET_URL = '../assets/spritesheet.png';
const ANIMS_URL = '../assets/animations.json';

type AnimSpec = {
  row: number;
  startCol: number;
  frames: number;
  fps: number;
  loop: boolean;
  flip?: boolean;
};
type AnimMap = Record<string, AnimSpec>;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

type PetSettings = {
  name: string;
  speed: number; // animation speed multiplier
  scope: 'all' | 'current';
  enabled: boolean;
};
const DEFAULT_SETTINGS: PetSettings = { name: 'Fox', speed: 1, scope: 'all', enabled: true };
const STORAGE_KEY = 'pet-settings';

/* ------------------------------------------------------------------ */
/* Host                                                                */
/* ------------------------------------------------------------------ */

const host = connectHost();

const MIN_DISPLAY_MS = 1500; // don't strobe loop animations
const OUTCOME_FLASH_MS = 5000; // happy/sad one-shot window after a turn ends

const projects: GuestProject[] = [];
const sessionsByProject = new Map<string, GuestSessionRecord[]>();
const seenOutcome = new Map<string, string>();
let outcomeFlash: { sessionId: string; outcome: string; at: number } | null = null;
let openSession: SessionSnapshot | null = null;
let settings: PetSettings = { ...DEFAULT_SETTINGS };
let granted = true; // sessions capability available
let connected = true;
let generation = 0; // stale async responses must not paint over newer state

const ACTIVITY_RANK: Record<string, number> = {
  running: 5,
  'waiting-permission': 4,
  'waiting-question': 4,
  retrying: 3,
  idle: 2,
  unknown: 1,
};

/* ------------------------------------------------------------------ */
/* Panel DOM                                                           */
/* ------------------------------------------------------------------ */

const stage = document.querySelector('#stage') as HTMLElement;
const canvas = document.querySelector('#pet') as HTMLCanvasElement;
const statusEl = document.querySelector('#status') as HTMLElement;
const settingsEl = document.querySelector('#settings') as HTMLElement;
const emptyEl = document.querySelector('#empty') as HTMLElement;
const bannerSlot = document.querySelector('#banner-slot') as HTMLElement;
const ctx = canvas.getContext('2d')!;

let sheet: HTMLImageElement | null = null;
let anims: AnimMap = {};

/* ------------------------------------------------------------------ */
/* Animation player                                                    */
/* ------------------------------------------------------------------ */

const player = {
  name: 'idle',
  frame: 0,
  lastSwitch: 0, // performance.now() of the last animation switch
  oneshot: false, // current animation plays once, then returns to `desired`
  desired: 'idle', // loop animation the state machine wants
};

function spec(name: string): AnimSpec | null {
  return anims[name] ?? null;
}

function requestAnim(name: string, oneshot = false) {
  if (!spec(name)) name = 'idle';
  if (oneshot) {
    if (player.oneshot && player.name === name) return;
    player.name = name;
    player.frame = 0;
    player.oneshot = true;
    player.lastSwitch = performance.now();
    return;
  }
  player.desired = name;
  if (player.oneshot) return; // let the one-shot finish first
  if (player.name === name) return;
  const now = performance.now();
  if (now - player.lastSwitch < MIN_DISPLAY_MS) return; // hold the current loop a little longer
  player.name = name;
  player.frame = 0;
  player.lastSwitch = now;
}

let rafId = 0;
let lastTick = 0;

function tick(now: number) {
  rafId = requestAnimationFrame(tick);
  if (document.hidden || !settings.enabled || !sheet || !anims[player.name]) {
    lastTick = now;
    return;
  }
  const current = spec(player.name)!;
  const fps = Math.max(1, current.fps * settings.speed);
  const frameMs = 1000 / fps;
  if (now - lastTick >= frameMs) {
    lastTick = now;
    player.frame++;
    if (player.frame >= current.frames) {
      if (current.loop && !player.oneshot) {
        player.frame = 0;
      } else {
        // one-shot finished (or non-loop spec): back to the desired loop
        player.oneshot = false;
        player.name = player.desired;
        player.frame = 0;
        player.lastSwitch = now;
      }
    }
  }
  draw();
}

function draw() {
  if (!sheet) return;
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const current = spec(player.name);
  if (!current) return;
  const scale = Math.min((w * 0.92) / FRAME_W, (h * 0.94) / FRAME_H, 3);
  const dw = FRAME_W * scale;
  const dh = FRAME_H * scale;
  const dx = (w - dw) / 2;
  const dy = h - dh - Math.max(4, h * 0.03);
  const col = current.startCol + player.frame;
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  if (current.flip) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet, col * FRAME_W, current.row * FRAME_H, FRAME_W, FRAME_H, 0, 0, dw, dh);
  } else {
    ctx.drawImage(sheet, col * FRAME_W, current.row * FRAME_H, FRAME_W, FRAME_H, dx, dy, dw, dh);
  }
  ctx.restore();
}

function startLoop() {
  if (!rafId) {
    lastTick = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

new ResizeObserver(() => draw()).observe(stage);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  } else {
    startLoop();
  }
});

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

type ToolRef = { name: string; target: string };

/** Best-effort current tool of a running session (field may vary by host version). */
function extractTool(s: GuestSessionRecord): ToolRef | null {
  const anyS = s as unknown as { tool?: { name?: unknown; target?: unknown } };
  if (anyS.tool && typeof anyS.tool.name === 'string' && anyS.tool.name) {
    return { name: anyS.tool.name, target: String(anyS.tool.target ?? '') };
  }
  for (let i = s.items.length - 1; i >= 0; i--) {
    const d = s.items[i]?.data as Record<string, unknown> | undefined;
    if (!d || typeof d !== 'object') continue;
    if (typeof d.tool === 'string' && d.tool) {
      const call = d.toolCall as Record<string, unknown> | undefined;
      return { name: d.tool, target: String(call?.target ?? d.target ?? '') };
    }
    if (d.type === 'tool' && typeof d.name === 'string' && d.name) {
      return { name: d.name, target: String(d.target ?? '') };
    }
  }
  return null;
}

function shortTarget(target: string): string {
  const t = target.replace(/^.*[~\/]/, '');
  return t.length > 28 ? '…' + t.slice(-27) : t;
}

function projectName(projectId: string): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

function pickSession(): GuestSessionRecord | null {
  const all: GuestSessionRecord[] = [];
  for (const list of sessionsByProject.values()) all.push(...list);
  if (settings.scope === 'current') {
    if (!openSession) return null;
    return all.find((s) => s.id === openSession!.id) ?? null;
  }
  if (!all.length) return null;
  if (openSession) {
    const open = all.find((s) => s.id === openSession!.id);
    if (open && (ACTIVITY_RANK[open.activity] ?? 0) >= ACTIVITY_RANK.retrying) return open;
  }
  return all.reduce((best, s) => ((ACTIVITY_RANK[s.activity] ?? 0) > (ACTIVITY_RANK[best.activity] ?? 0) ? s : best), all[0]);
}

type Derived = { anim: string; oneshot: boolean; status: string };

function derive(): Derived {
  const name = settings.name.trim() || DEFAULT_SETTINGS.name;
  const s = pickSession();
  if (!s) {
    return { anim: 'idle', oneshot: false, status: `${name} is idle` };
  }
  const proj = projectName(s.projectId);
  const agent = s.agent ?? 'agent';
  const tool = extractTool(s);
  const toolText = tool ? ` ${tool.name}${tool.target ? ' ' + shortTarget(tool.target) : ''}` : '';

  switch (s.activity) {
    case 'running': {
      const n = (tool?.name ?? '').toLowerCase();
      let anim = 'excited';
      if (/(read|glob|grep|search|list|find|fetch|ls)\b/.test(n)) anim = 'curious';
      else if (/(edit|write|patch|apply|replace|multi)/.test(n)) anim = 'excited';
      else if (/(bash|shell|exec|terminal|command|run)/.test(n)) anim = 'run';
      return { anim, oneshot: false, status: `${name} is watching ${agent} run${toolText} in ${proj}` };
    }
    case 'retrying':
      return { anim: 'worried', oneshot: false, status: `${name} is worried — ${agent} is retrying in ${proj}` };
    case 'waiting-permission':
      return { anim: 'surprised', oneshot: false, status: `${name} needs you — permission request in ${proj}` };
    case 'waiting-question':
      return { anim: 'surprised', oneshot: false, status: `${name} has a question for you in ${proj}` };
    default: {
      // idle / unknown: flash the last turn outcome once, then relax
      const now = Date.now();
      if (outcomeFlash && outcomeFlash.sessionId === s.id && now - outcomeFlash.at < OUTCOME_FLASH_MS) {
        return outcomeFlash.outcome === 'failed'
          ? { anim: 'worried', oneshot: true, status: `${name} is sad — the turn failed in ${proj}` }
          : { anim: 'happy', oneshot: true, status: `${name} is happy — turn done in ${proj}` };
      }
      if (s.outcome === 'completed' || s.outcome === 'failed') {
        const seen = seenOutcome.get(s.id);
        if (seen !== s.outcome) {
          seenOutcome.set(s.id, s.outcome);
          outcomeFlash = { sessionId: s.id, outcome: s.outcome, at: now };
          return s.outcome === 'failed'
            ? { anim: 'worried', oneshot: true, status: `${name} is sad — the turn failed in ${proj}` }
            : { anim: 'happy', oneshot: true, status: `${name} is happy — turn done in ${proj}` };
        }
      }
      const watchingOther = settings.scope === 'all' && openSession && s.id !== openSession.id && s.activity === 'idle';
      return {
        anim: watchingOther ? 'glance' : 'idle',
        oneshot: false,
        status: `${name} is watching ${proj}`,
      };
    }
  }
}

function applyDerived() {
  const d = derive();
  requestAnim(d.anim, d.oneshot);
  statusEl.textContent = d.status;
  updateBadge();
}

function updateBadge() {
  let running = 0;
  let waiting = 0;
  for (const list of sessionsByProject.values()) {
    for (const s of list) {
      if (s.activity === 'running') running++;
      if (s.activity === 'waiting-permission' || s.activity === 'waiting-question') waiting++;
    }
  }
  const count = waiting > 0 ? waiting : running;
  void host.setBadge(count > 0 ? Math.min(count, GUEST_BADGE_MAX) : null).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

let stopProjects: (() => void) | null = null;
const sessionStops = new Map<string, () => void>();

async function subscribeSessions(projectId: string, owner: number) {
  try {
    const stop = await host.onSessions(projectId, (snap) => {
      if (owner !== generation) return;
      sessionsByProject.set(projectId, snap.sessions);
      applyDerived();
    });
    if (owner !== generation) {
      stop();
      return;
    }
    sessionStops.set(projectId, stop);
  } catch (error) {
    if (error instanceof HostRequestError && error.code === 'NOT_GRANTED') {
      granted = false;
      showPermissionEmpty();
    }
  }
}

async function watchProjects() {
  const owner = ++generation;
  try {
    const stop = await host.onProjects((snap) => {
      if (owner !== generation) return;
      projects.length = 0;
      projects.push(...snap.projects);
      const ids = new Set(snap.projects.map((p) => p.id));
      for (const [pid, stopOne] of [...sessionStops]) {
        if (!ids.has(pid)) {
          stopOne();
          sessionStops.delete(pid);
          sessionsByProject.delete(pid);
        }
      }
      for (const p of snap.projects) {
        if (!sessionStops.has(p.id)) void subscribeSessions(p.id, owner);
      }
      applyDerived();
    });
    if (owner !== generation) {
      stop();
      return;
    }
    stopProjects = stop;
  } catch (error) {
    if (error instanceof HostRequestError && error.code === 'NOT_GRANTED') {
      granted = false;
      showPermissionEmpty();
    } else {
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Empty / banner states                                               */
/* ------------------------------------------------------------------ */

let emptyHandle: ReturnType<typeof mountEmpty> | null = null;
let bannerHandle: ReturnType<typeof mountBanner> | null = null;

function showPermissionEmpty() {
  settingsEl.hidden = true;
  emptyEl.hidden = false;
  if (!emptyHandle) {
    emptyHandle = mountEmpty(emptyEl, {
      title: 'Sessions access needed',
      body: 'Enable the "sessions" capability for this extension in Settings → Extensions, then reload the panel.',
    });
  }
  statusEl.textContent = 'waiting for the sessions capability';
}

function showConnectionBanner(connectedNow: boolean) {
  if (!connectedNow) {
    bannerSlot.hidden = false;
    if (!bannerHandle) {
      bannerHandle = mountBanner(bannerSlot, { tone: 'warning', title: 'Disconnected from OpenChamber', body: 'Reconnecting…' });
    }
  } else if (bannerHandle) {
    bannerSlot.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

let saveTimer = 0;
function persistSettings() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void host.storage.set(STORAGE_KEY, settings).catch(() => {});
  }, 250);
}

function mountSettings() {
  settingsEl.hidden = false;
  const nameField = mountTextField(settingsEl, {
    label: 'Pet name',
    value: settings.name,
    placeholder: 'Fox',
    onChange: (value) => {
      settings.name = value;
      nameField.update({ value });
      persistSettings();
      applyDerived();
    },
  });
  const speedSelect = mountSelect(settingsEl, {
    label: 'Animation speed',
    value: String(settings.speed),
    options: [
      { id: '0.5', label: '0.5×' },
      { id: '1', label: '1×' },
      { id: '1.5', label: '1.5×' },
      { id: '2', label: '2×' },
    ],
    onChange: (id) => {
      settings.speed = Number(id) || 1;
      speedSelect.update({ value: id });
      persistSettings();
    },
  });
  const scopeSelect = mountSelect(settingsEl, {
    label: 'Watch scope',
    value: settings.scope,
    options: [
      { id: 'all', label: 'All projects', hint: 'follow the most active session' },
      { id: 'current', label: 'Current session only' },
    ],
    onChange: (id) => {
      settings.scope = id === 'current' ? 'current' : 'all';
      scopeSelect.update({ value: settings.scope });
      persistSettings();
      applyDerived();
    },
  });
  mountSwitch(settingsEl, {
    label: 'Pet enabled',
    description: 'Pause the animation (the panel still watches sessions).',
    checked: settings.enabled,
    onChange: (checked) => {
      settings.enabled = checked;
      persistSettings();
      applyDerived();
      if (!checked) {
        statusEl.textContent = `${settings.name.trim() || DEFAULT_SETTINGS.name} is taking a nap`;
      }
    },
  });
}

async function loadSettings() {
  try {
    const saved = await host.storage.get(STORAGE_KEY);
    if (saved && typeof saved === 'object') {
      const s = saved as Partial<PetSettings>;
      settings = {
        name: typeof s.name === 'string' ? s.name : DEFAULT_SETTINGS.name,
        speed: typeof s.speed === 'number' && s.speed > 0 ? s.speed : 1,
        scope: s.scope === 'current' ? 'current' : 'all',
        enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
      };
    }
  } catch {
    /* storage unavailable — keep defaults */
  }
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

async function loadAssets(owner: number): Promise<boolean> {
  const [img, res] = await Promise.all([
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('sprite sheet failed to load'));
      image.src = SHEET_URL;
    }),
    fetch(ANIMS_URL).then((r) => {
      if (!r.ok) throw new Error('animations.json failed to load');
      return r.json() as Promise<AnimMap>;
    }),
  ]);
  if (owner !== generation) return false; // stale load, a newer one is in flight
  sheet = img;
  anims = res;
  player.name = 'idle';
  player.desired = 'idle';
  player.frame = 0;
  draw();
  return true;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let mounted = false;

host.onReady((readyCtx: HostReadyContext) => {
  applyHostReady(readyCtx, document.documentElement);
  if (mounted) return;
  mounted = true;
  const owner = ++generation;

  void loadSettings().then(() => {
    if (owner !== generation) return;
    mountSettings();
    applyDerived();
  });

  void loadAssets(owner).then((ok) => {
    if (ok) statusEl.textContent = `${settings.name.trim() || DEFAULT_SETTINGS.name} is idle`;
  });

  host.onSession((session) => {
    openSession = session;
    applyDerived();
  });

  host.onSessionLifecycle((event: SessionLifecycleEvent) => {
    if (event.phase === 'started') {
      if (!openSession || event.sessionId === openSession.id) {
        outcomeFlash = null;
        requestAnim('wave', true);
      }
    } else {
      outcomeFlash = { sessionId: event.sessionId, outcome: event.phase === 'failure' ? 'failed' : 'completed', at: Date.now() };
      seenOutcome.set(event.sessionId, outcomeFlash.outcome);
      if (!openSession || event.sessionId === openSession.id) {
        requestAnim(event.phase === 'failure' ? 'worried' : 'happy', true);
      }
    }
    applyDerived();
  });

  host.onConnection((connection) => {
    connected = connection.connected;
    showConnectionBanner(connected);
  });

  if (granted) void watchProjects();

  startLoop();
});
