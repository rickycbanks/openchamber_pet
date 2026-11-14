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
type Outcome = 'completed' | 'failed';
const lastOutcome = new Map<string, { gen: number; outcome: Outcome | null }>();
const gen = new Map<string, number>();                 // per-session turn generation, bumped on 'started' / active edge
type Flashed = { gen: number; outcome: Outcome };
const flashedOutcome = new Map<string, Flashed>();      // last outcome actually played per session
type QueuedOutcome = { sessionId: string; outcome: Outcome; at: number; gen: number };
let outcomeQueue: QueuedOutcome[] = []; // marked flashed only when its one-shot actually starts
let oneshotOrigin: { proj: string; agent: string } | null = null; // context of the playing one-shot
let openSession: SessionSnapshot | null = null;
let settings: PetSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false; // outcome playback waits for persisted settings (scope)
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

const animLog: string[] = []; // TEMP debug
function requestAnim(name: string, oneshot = false, baseline?: string) {
  if (!spec(name)) name = 'idle';
  animLog.push(`${oneshot ? '1shot:' : ''}${name} (was ${player.name}${player.oneshot ? '*' : ''})`);
  if (animLog.length > 60) animLog.shift();
  const wantBaseline = baseline ?? (oneshot ? player.desired : name);
  player.desired = spec(wantBaseline) ? wantBaseline : 'idle';
  if (oneshot) {
    if (player.oneshot && player.name === name) return;
    player.name = name;
    player.frame = 0;
    player.oneshot = true;
    player.lastSwitch = performance.now();
    return;
  }
  if (player.oneshot) return; // let the one-shot finish first
  if (player.name === name) return;
  const now = performance.now();
  if (now - player.lastSwitch >= MIN_DISPLAY_MS) {
    player.name = name;
    player.frame = 0;
    player.lastSwitch = now;
  }
  // else: tick() applies player.desired once the hold expires
}

let rafId = 0;
let lastTick = 0;

function tick(now: number) {
  rafId = requestAnimationFrame(tick);
  if (document.hidden || !settings.enabled || !sheet || !anims[player.name]) {
    lastTick = now;
    return;
  }
  // retry a deferred loop transition once the minimum display time has passed
  if (!player.oneshot && player.name !== player.desired && now - player.lastSwitch >= MIN_DISPLAY_MS) {
    player.name = player.desired;
    player.frame = 0;
    player.lastSwitch = now;
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
        oneshotOrigin = null;
        applyDerived(); // refresh the status line and pump any queued outcome
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

/**
 * Current tool of a running session. The `tool` field is present on hosts
 * newer than SDK 2.7.0 and absent on older ones — read it defensively and
 * fall back to a generic "working" animation when the host does not provide it.
 */
function extractTool(s: GuestSessionRecord): ToolRef | null {
  const anyS = s as unknown as { tool?: { name?: unknown; target?: unknown } | null };
  if (anyS.tool && typeof anyS.tool.name === 'string' && anyS.tool.name) {
    return { name: anyS.tool.name, target: anyS.tool.target == null ? '' : String(anyS.tool.target) };
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

/** True when this session has a turn outcome that has not been flashed yet. */
function pendingOutcome(s: GuestSessionRecord): boolean {
  if (s.outcome !== 'completed' && s.outcome !== 'failed') return false;
  if (outcomeQueue.some((q) => q.sessionId === s.id && Date.now() - q.at < OUTCOME_FLASH_MS)) return true;
  const fl = flashedOutcome.get(s.id);
  return !fl || fl.gen !== (gen.get(s.id) ?? 0) || fl.outcome !== s.outcome;
}

function animsReady(): boolean {
  return Object.keys(anims).length > 0;
}

function findSession(id: string): GuestSessionRecord | null {
  for (const list of sessionsByProject.values()) {
    const found = list.find((s) => s.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Queue a turn outcome for a one-shot. Deduped so lifecycle and snapshot signals for
 * the same turn can't celebrate twice; marked flashed only when playback starts
 * (applyDerived), so an outcome arriving during another one-shot or before the assets
 * load is queued, not lost.
 */
function queueOutcome(sessionId: string, outcome: Outcome, force = false) {
  const g = gen.get(sessionId) ?? 0;
  if (outcomeQueue.some((q) => q.sessionId === sessionId && q.outcome === outcome && q.gen === g)) return;
  const fl = flashedOutcome.get(sessionId);
  if (fl && fl.gen === g && fl.outcome === outcome) return; // already celebrated this turn
  const last = lastOutcome.get(sessionId);
  if (!force && last && last.gen === g && last.outcome === outcome) return; // stale: same turn, value already seen
  outcomeQueue.push({ sessionId, outcome, at: Date.now(), gen: g });
}

const activeSeen = new Map<string, boolean>();
function bumpGen(sessionId: string) {
  const next = (gen.get(sessionId) ?? 0) + 1;
  gen.set(sessionId, next);
  outcomeQueue = outcomeQueue.filter((q) => q.sessionId !== sessionId || q.gen >= next); // drop prior-turn queued outcomes
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
    if (open && (ACTIVITY_RANK[open.activity] ?? 0) >= ACTIVITY_RANK.retrying) return open; // active open session always wins
  }
  // otherwise the most active session wins; an uncelebrated turn outcome breaks idle/unknown ties
  const score = (s: GuestSessionRecord) => (ACTIVITY_RANK[s.activity] ?? 0) * 2 + (pendingOutcome(s) ? 1 : 0);
  return all.reduce((b, s) => (score(s) > score(b) ? s : b), all[0]);
}

type Derived = { anim: string; oneshot: boolean; baseline: string; status: string };

/**
 * While a one-shot (wave/happy/sad) is playing, keep it on screen but report its
 * own status text; the freshly derived loop becomes the baseline it returns to.
 */
function derive(): Derived {
  const d = deriveState();
  if (player.oneshot) {
    // keep the playing one-shot on screen; report its own status using the session
    // that triggered it (stable even after that session loses the pick)
    return { anim: player.name, oneshot: true, baseline: d.baseline, status: oneshotStatusText(d.status) };
  }
  return d;
}

function oneshotStatusText(fallback: string): string {
  const name = settings.name.trim() || DEFAULT_SETTINGS.name;
  const ctx = oneshotOrigin ? ` in ${oneshotOrigin.proj}` : '';
  if (player.name === 'happy') return `${name} is happy — turn done${ctx}`;
  if (player.name === 'worried') return `${name} is sad — the turn failed${ctx}`;
  if (player.name === 'wave') return `${name} waves${oneshotOrigin ? ` at ${oneshotOrigin.agent}${ctx}` : ''}`;
  return fallback;
}

function deriveState(): Derived {
  const name = settings.name.trim() || DEFAULT_SETTINGS.name;
  const s = pickSession();
  if (!s) {
    return { anim: 'idle', oneshot: false, baseline: 'idle', status: `${name} is idle` };
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
      return { anim, oneshot: false, baseline: anim, status: `${name} is watching ${agent} run${toolText} in ${proj}` };
    }
    case 'retrying':
      return { anim: 'worried', oneshot: false, baseline: 'worried', status: `${name} is worried — ${agent} is retrying in ${proj}` };
    case 'waiting-permission':
      return { anim: 'surprised', oneshot: false, baseline: 'surprised', status: `${name} needs you — permission request in ${proj}` };
    case 'waiting-question':
      return { anim: 'surprised', oneshot: false, baseline: 'surprised', status: `${name} has a question for you in ${proj}` };
    default: {
      // idle / unknown: the last turn outcome is queued by the snapshot/lifecycle
      // signals, never by derivation
      const watchingOther = settings.scope === 'all' && openSession && s.id !== openSession.id && s.activity === 'idle';
      const anim = watchingOther ? 'glance' : 'idle';
      return { anim, oneshot: false, baseline: anim, status: `${name} is watching ${proj}` };
    }
  }
}

function applyDerived() {
  if (!granted) return; // the permission empty state owns the UI until the capability is approved
  const d = derive();
  requestAnim(d.anim, d.oneshot, d.baseline);
  let status = player.oneshot ? oneshotStatusText(d.status) : d.status;
  // play the oldest queued turn outcome once no one-shot is in flight; only now is it
  // marked flashed, so it can't be consumed-and-lost while another one-shot plays
  if (!player.oneshot && animsReady() && settingsLoaded) {
    const now = Date.now();
    outcomeQueue = outcomeQueue.filter((q) => now - q.at < OUTCOME_FLASH_MS && q.gen === (gen.get(q.sessionId) ?? 0));
    const qi = outcomeQueue.findIndex((q) => settings.scope !== 'current' || (openSession && q.sessionId === openSession.id)); // FIX 3: respect watch scope
    const q = qi >= 0 ? outcomeQueue.splice(qi, 1)[0] : undefined;
    if (q) {
      flashedOutcome.set(q.sessionId, { gen: q.gen, outcome: q.outcome });
      const s = findSession(q.sessionId);
      oneshotOrigin = s ? { proj: projectName(s.projectId), agent: s.agent ?? 'agent' } : null;
      requestAnim(q.outcome === 'failed' ? 'worried' : 'happy', true, d.baseline);
      status = oneshotStatusText(d.status);
    }
  }
  statusEl.textContent = status;
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
const sessionStops = new Map<string, { token: number; stop: () => void }>();
let nextSubToken = 0;

function projectKnown(projectId: string): boolean {
  return projects.some((p) => p.id === projectId);
}

async function subscribeSessions(projectId: string, owner: number) {
  const token = ++nextSubToken;
  // reserve now so repeated snapshots can't double-subscribe; the token lets a
  // superseded registration detect that it lost the slot while its await was pending
  sessionStops.set(projectId, { token, stop: () => {} });
  const live = () => owner === generation && sessionStops.get(projectId)?.token === token && projectKnown(projectId);
  try {
    const stop = await host.onSessions(projectId, (snap) => {
      if (!live()) return;
      sessionsByProject.set(projectId, snap.sessions);
      for (const s of snap.sessions) {
        const active = (ACTIVITY_RANK[s.activity] ?? 0) >= ACTIVITY_RANK.retrying;
        const wasActive = activeSeen.get(s.id) ?? false;
        if (active && !wasActive) bumpGen(s.id); // inactive→active edge = new turn (lifecycle 'started' marks active, so no double bump)
        activeSeen.set(s.id, active);
        const out: Outcome | null = s.outcome === 'completed' || s.outcome === 'failed' ? s.outcome : null;
        if (out) queueOutcome(s.id, out); // queueOutcome's gen-tagged lastOutcome guard suppresses stale cached records
        lastOutcome.set(s.id, { gen: gen.get(s.id) ?? 0, outcome: out });
      }
      applyDerived();
    });
    if (!live()) {
      stop(); // superseded while pending — never leak the subscription
      // only drop the cache if we still own the slot; a replacement subscription may
      // already have delivered fresh sessions for this project
      if (sessionStops.get(projectId)?.token === token) {
        sessionStops.delete(projectId);
        sessionsByProject.delete(projectId);
      }
      return;
    }
    sessionStops.get(projectId)!.stop = stop;
  } catch (error) {
    const owned = sessionStops.get(projectId)?.token === token;
    if (owned) sessionStops.delete(projectId);
    if (owned && owner === generation && error instanceof HostRequestError && error.code === 'NOT_GRANTED') {
      granted = false;
      showPermissionEmpty();
    }
    // other subscription errors leave the panel running with what it has
  }
}

async function watchProjects(owner: number) {
  try {
    const stop = await host.onProjects((snap) => {
      if (owner !== generation) return;
      projects.length = 0;
      projects.push(...snap.projects);
      const ids = new Set(snap.projects.map((p) => p.id));
      for (const [pid, entry] of [...sessionStops]) {
        if (!ids.has(pid)) {
          entry.stop();
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
    if (owner === generation && error instanceof HostRequestError && error.code === 'NOT_GRANTED') {
      granted = false;
      showPermissionEmpty();
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
  const enabledSwitch = mountSwitch(settingsEl, {
    label: 'Pet enabled',
    description: 'Pause the animation (the panel still watches sessions).',
    checked: settings.enabled,
    onChange: (checked) => {
      settings.enabled = checked;
      enabledSwitch.update({ checked });
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
  player.lastSwitch = 0; // allow an immediate switch to whatever the state machine wants now
  applyDerived(); // don't pin to idle if a session snapshot arrived while assets loaded
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
    if (owner !== generation || !granted) return; // don't unhide settings over the permission empty state
    settingsLoaded = true;
    mountSettings();
    applyDerived();
  });

  void loadAssets(owner).then((ok) => {
    if (ok) draw();
  });

  host.onSession((session) => {
    openSession = session;
    applyDerived();
  });

  host.onSessionLifecycle((event: SessionLifecycleEvent) => {
    if (event.phase === 'started') {
      bumpGen(event.sessionId);
      activeSeen.set(event.sessionId, true);
      if (!player.oneshot && settingsLoaded && (settings.scope === 'all' || (openSession != null && event.sessionId === openSession.id)) && animsReady()) {
        const s = findSession(event.sessionId);
        oneshotOrigin = s ? { proj: projectName(s.projectId), agent: s.agent ?? 'agent' } : null;
        requestAnim('wave', true);
      }
    } else {
      const outcome: Outcome = event.phase === 'failure' ? 'failed' : 'completed';
      const g = gen.get(event.sessionId) ?? 0;
      const fl = flashedOutcome.get(event.sessionId);
      const already = (fl && fl.gen === g) || outcomeQueue.some((q) => q.sessionId === event.sessionId && q.gen === g);
      if (!already) {
        outcomeQueue = outcomeQueue.filter((q) => !(q.sessionId === event.sessionId && q.gen === g));
        lastOutcome.set(event.sessionId, { gen: g, outcome });
        queueOutcome(event.sessionId, outcome, true);
      }
    }
    applyDerived();
  });

  host.onConnection((connection) => {
    connected = connection.connected;
    showConnectionBanner(connected);
  });

  if (granted) void watchProjects(owner);

  startLoop();
});

// Debug/verification handle (the sandboxed panel exposes nothing otherwise).
(window as unknown as { __pet?: unknown }).__pet = {
  player,
  get settings() { return { ...settings }; },
  derive,
  get outcomeQueue() { return outcomeQueue.map((q) => ({ ...q })); },
  get flashed() { return [...flashedOutcome.entries()]; },
  get gen() { return [...gen.entries()]; },
  get lastOutcome() { return [...lastOutcome.entries()]; },
  get animLog() { return [...animLog]; },
};
