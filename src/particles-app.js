/**
 * STREAMS — particle sandbox (vanilla JS).
 * SVG equipment (free-placed tiles) + Canvas dots; fixed-timestep rAF physics.
 */
'use strict';

const DIR_RIGHT = 0;
const DIR_DOWN = 1;
const DIR_LEFT = 2;
const DIR_UP = 3;
const DIR_DX = [1, 0, -1, 0];
const DIR_DY = [0, 1, 0, -1];

const SPEED_STEPS = [1, 2, 3, 5, 8, 13, 21, 34, 55];
const SPEED_MULT = {
  1: 1, 2: 1.4, 3: 2, 5: 2.8, 8: 4, 13: 5.5, 21: 8, 34: 11, 55: 16,
};

const COLOR_IDS = ['black', 'red', 'yellow', 'blue', 'green'];
const COLOR_HEX = {
  black: '#111111',
  red: '#cc2222',
  yellow: '#ccaa00',
  blue: '#2266cc',
  green: '#228844',
};

const FIXED_DT = 1 / 120;
/** Interaction highlight: e-folding time (seconds); short so dense hits stay gentle. */
const INTERACT_GLOW_DECAY_S = 0.05;
const INTERACT_GLOW_DISCRETE = 0.2;
const INTERACT_GLOW_CONTINUOUS = 0.042;
const INTERACT_GLOW_EMIT = 0.034;
const MAX_PARTICLES = 4800;
const MAX_SUBSTEPS = 6;
/** Max particles released from one BUFFER in a single physics substep (Poisson cap). */
const MAX_BUFFER_RELEASE_PER_SUBSTEP = 4;
/** SOURCE `energyBudget` is in these units; each spawn costs speed² / this (≈ ke at m=2). */
const SOURCE_EMIT_ENERGY_DIV = 200;
const EPS = 1e-6;

const SANDBOX = {
  name: 'sandbox',
  gridW: 26,
  gridH: 18,
  cellPx: 36,
  palette: [
    'SOURCE', 'FOCUS', 'DIFFUSER', 'REFLECTOR', 'ABSORBER', 'GOAL',
    'SPLITTER', 'RECOLOR', 'SPEED_GATE', 'SWIRL', 'TELEPORT', 'MEMBRANE',
    'BEAM_SHAPER', 'RESONATOR', 'COLLIMATOR', 'BUFFER',
  ],
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function halfTile(cp) {
  return cp * 0.5;
}

/** Tile occupies a cp×cp axis-aligned square centered at (tile.x, tile.y). */
function pointInTileRect(px, py, tile, cp) {
  const h = halfTile(cp);
  return px >= tile.x - h && px <= tile.x + h && py >= tile.y - h && py <= tile.y + h;
}

function tilesOverlapCenters(ax, ay, bx, by, cp) {
  return Math.abs(ax - bx) < cp - EPS && Math.abs(ay - by) < cp - EPS;
}

/** Topmost tile at a point: highest id wins (matches SVG paint order). */
function tileAtPoint(state, wx, wy) {
  const cp = cellPx(state);
  let best = null;
  for (const t of state.tiles.values()) {
    if (!pointInTileRect(wx, wy, t, cp)) continue;
    if (!best || t.id > best.id) best = t;
  }
  return best;
}

function clampTileCenter(state, x, y) {
  const { w, h, cp } = worldSize(state);
  const half = halfTile(cp);
  return [clamp(x, half, w - half), clamp(y, half, h - half)];
}

function overlapsAnyTile(state, cx, cy, excludeId) {
  const cp = cellPx(state);
  for (const t of state.tiles.values()) {
    if (excludeId != null && t.id === excludeId) continue;
    if (tilesOverlapCenters(cx, cy, t.x, t.y, cp)) return true;
  }
  return false;
}

/** Returns { x, y } clamped world center, or null if overlapping another tile. */
function canPlaceTileCenter(state, wx, wy, excludeId) {
  const [x, y] = clampTileCenter(state, wx, wy);
  if (overlapsAnyTile(state, x, y, excludeId)) return null;
  return { x, y };
}

function tryMoveTileTo(state, tileId, nx, ny) {
  const tile = state.tiles.get(tileId);
  if (!tile) return false;
  const ok = canPlaceTileCenter(state, nx, ny, tileId);
  if (!ok) return false;
  tile.x = ok.x;
  tile.y = ok.y;
  return true;
}
function hypot(x, y) { return Math.sqrt(x * x + y * y); }
function norm(x, y) {
  const L = hypot(x, y);
  return L < EPS ? [0, 0] : [x / L, y / L];
}
function dot(ax, ay, bx, by) { return ax * bx + ay * by; }

/** Poisson count ~ Pois(lambda); mean lambda, good for sparse emissions (lambda < ~40/substep). */
function poissonSample(lambda) {
  if (!(lambda > 0)) return 0;
  const lam = Math.min(lambda, 80);
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L && k < 280);
  return k - 1;
}

function defaultParams(kind) {
  const p = {
    SOURCE: {
      rate: 120,
      speedMin: 80,
      speedMax: 140,
      sprayDeg: 28,
      colorId: 'red',
      burst: 0.12,
      timingNoise: 0.22,
      /** 0 = unlimited emission; >0 = initial energy pool (depleted by speed² per spawn). */
      energyBudget: 0,
    },
    FOCUS: { strength: 4, hitP: 0.9 },
    DIFFUSER: { spreadDeg: 22, spikeP: 0.09, spikeMul: 1.55 },
    REFLECTOR: { scatterDeg: 4, scatterP: 0.72 },
    ABSORBER: { absorbP: 0.35, absorbJitter: 0.18 },
    GOAL: { filterColor: 'any', capacity: 0, captureP: 0.93 },
    SPLITTER: { splitP: 1, childSpeed: 0.72, angleJitterDeg: 3 },
    RECOLOR: { recolorRate: 6, skipP: 0.06 },
    SPEED_GATE: { parallelGain: 1.35, tangentialGain: 1, engageP: 0.88 },
    SWIRL: { omega: 220, decay: 2.2, omegaJitter: 0.14 },
    TELEPORT: { linkId: 0, malfunctionP: 0, coneDeg: 12, exitJitterDeg: 4 },
    MEMBRANE: { leakP: 0.08, wobbleP: 0.06 },
    BEAM_SHAPER: {
      slitW: 0.22, slitOffset: 0, edgeSoft: 0.06, mode: 'bounce', absorbP: 0.4, bounceSoftP: 0.12,
    },
    RESONATOR: { amplitude: 420, freq: 3.5, ampJitter: 0.14 },
    COLLIMATOR: { divisions: 8, snapP: 0.85, jitterDeg: 4, microJitterDeg: 1.2 },
    BUFFER: { maxK: 40, releaseRate: 18, burstOnFull: 1, slipP: 0.022 },
  };
  return Object.assign({}, p[kind] || {});
}

const KIND_META = {
  SOURCE: { label: 'SRC', hasRotation: true },
  FOCUS: { label: 'FOC', hasRotation: true },
  DIFFUSER: { label: 'DIF', hasRotation: true },
  REFLECTOR: { label: 'REF', hasRotation: true },
  ABSORBER: { label: 'ABS', hasRotation: false },
  GOAL: { label: 'GOAL', hasRotation: false },
  SPLITTER: { label: 'SPL', hasRotation: true },
  RECOLOR: { label: 'CLR', hasRotation: false },
  SPEED_GATE: { label: 'SPD', hasRotation: true },
  SWIRL: { label: 'VOR', hasRotation: false },
  TELEPORT: { label: 'TEL', hasRotation: false },
  MEMBRANE: { label: 'MEM', hasRotation: true },
  BEAM_SHAPER: { label: 'SLT', hasRotation: true },
  RESONATOR: { label: 'RSN', hasRotation: true },
  COLLIMATOR: { label: 'COL', hasRotation: true },
  BUFFER: { label: 'BUF', hasRotation: true },
};

/* ---------- State ---------- */

function createState() {
  const level = SANDBOX;
  return {
    level,
    tiles: new Map(),
    nextTileId: 1,
    particles: [],
    nextParticleId: 1,
    sim: {
      running: false,
      time: 0,
      speed: 1,
      accumulator: 0,
      raf: null,
      lastFrame: 0,
      fpsAvg: 0,
      fpsFrames: 0,
    },
    ui: {
      brush: null,
      inspectorTileId: null,
      /** Pointer position in board SVG coords (pixels), or null. */
      hoverWorld: null,
    },
    history: { past: [], future: [] },
  };
}

function placeTile(state, kind, wx, wy, rotation, params) {
  const ok = canPlaceTileCenter(state, wx, wy, null);
  if (!ok) return null;
  const tile = {
    id: state.nextTileId++,
    kind,
    x: ok.x,
    y: ok.y,
    rotation: rotation || 0,
    params: Object.assign(defaultParams(kind), params || {}),
  };
  if (kind === 'BUFFER') tile._buf = [];
  if (kind === 'GOAL') tile._captured = 0;
  if (kind === 'SOURCE') {
    const cap = tile.params.energyBudget | 0;
    if (cap > 0) tile._energyLeft = cap;
  }
  state.tiles.set(tile.id, tile);
  return tile;
}

function deleteTile(state, tileId) {
  const tile = state.tiles.get(tileId);
  if (!tile) return false;
  state.tiles.delete(tileId);
  return true;
}

function rotateTile(state, tileId) {
  const tile = state.tiles.get(tileId);
  if (!tile || !KIND_META[tile.kind]?.hasRotation) return;
  tile.rotation = (tile.rotation + 1) % 4;
}

function snapshotBoard(state) {
  return [...state.tiles.values()]
    .sort((a, b) => a.id - b.id)
    .map(t => ({
      kind: t.kind,
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      params: { ...t.params },
    }));
}

function sameBoardSnapshot(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.kind === y.kind && x.x === y.x && x.y === y.y && x.rotation === y.rotation
      && JSON.stringify(x.params) === JSON.stringify(y.params);
  });
}

/** So reflector/splitter/teleport "entered" logic re-runs after board edits. */
function invalidateAllParticleTileEntry(state) {
  for (const p of state.particles) {
    p.lastTileId = undefined;
  }
}

/** Legacy saves stored integer grid cell indices; new saves use world pixel centers. */
function applyBoardSnapshot(state, board, legacyGridPositions) {
  const cp = cellPx(state);
  const { gridW, gridH } = state.level;
  for (const t of [...state.tiles.values()]) deleteTile(state, t.id);
  for (const ent of board) {
    let wx = ent.x;
    let wy = ent.y;
    if (legacyGridPositions) {
      if (Number.isFinite(wx) && Number.isFinite(wy)
        && (wx | 0) === wx && (wy | 0) === wy
        && wx >= 0 && wx < gridW && wy >= 0 && wy < gridH) {
        wx = wx * cp + cp / 2;
        wy = wy * cp + cp / 2;
      }
    }
    const pl = placeTile(state, ent.kind, wx, wy, ent.rotation, ent.params);
    if (!pl) console.error('[streams] Skipped invalid tile from snapshot', ent);
  }
}

function resetSim(state) {
  state.particles = [];
  state.nextParticleId = 1;
  state.sim.time = 0;
  state.sim.accumulator = 0;
  for (const t of state.tiles.values()) {
    if (t.kind === 'BUFFER') t._buf = [];
    if (t.kind === 'GOAL') t._captured = 0;
    if (t.kind === 'SOURCE') {
      const cap = t.params.energyBudget | 0;
      if (cap > 0) t._energyLeft = cap;
      else delete t._energyLeft;
    }
  }
}

/* ---------- Physics ---------- */

function worldSize(state) {
  const { gridW, gridH, cellPx } = state.level;
  return { w: gridW * cellPx, h: gridH * cellPx, cp: cellPx };
}

function bounceWalls(state, p) {
  const { w, h } = worldSize(state);
  const r = 1.2;
  if (p.x < r) { p.x = r; p.vx = Math.abs(p.vx); }
  if (p.x > w - r) { p.x = w - r; p.vx = -Math.abs(p.vx); }
  if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy); }
  if (p.y > h - r) { p.y = h - r; p.vy = -Math.abs(p.vy); }
}

function reflectMirror(vx, vy, rot) {
  const tx = DIR_DX[rot];
  const ty = DIR_DY[rot];
  const dp = dot(vx, vy, tx, ty);
  const vpx = dp * tx;
  const vpy = dp * ty;
  return [2 * vpx - vx, 2 * vpy - vy];
}

function buildTeleportPartners(state) {
  const byLink = new Map();
  for (const t of state.tiles.values()) {
    if (t.kind !== 'TELEPORT') continue;
    const lid = t.params.linkId | 0;
    if (!byLink.has(lid)) byLink.set(lid, []);
    byLink.get(lid).push(t);
  }
  const pair = new Map();
  for (const [, arr] of byLink) {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const a = arr[i];
      const b = arr[i + 1];
      pair.set(a.id, b);
      pair.set(b.id, a);
    }
  }
  return pair;
}

function sourceEmitEnergyCost(sp) {
  return (sp * sp) / SOURCE_EMIT_ENERGY_DIV;
}

function emitFromSources(state, dt) {
  const { cp } = worldSize(state);
  let budget = MAX_PARTICLES - state.particles.length;
  if (budget <= 0) return;

  for (const t of state.tiles.values()) {
    if (t.kind !== 'SOURCE' || budget <= 0) continue;
    const pr = t.params;
    const energyCap = pr.energyBudget | 0;
    if (energyCap <= 0) {
      delete t._energyLeft;
    } else {
      if (t._energyLeft === undefined) t._energyLeft = energyCap;
      if (t._energyLeft <= 0) continue;
    }
    const mean = (t.rotation * Math.PI) / 2;
    const spray = (pr.sprayDeg * Math.PI) / 180;
    const base = Math.max(0, pr.rate * dt);
    const tn = clamp(pr.timingNoise ?? 0.22, 0, 0.55);
    const burst = clamp(pr.burst ?? 0, 0, 1);
    const phase = state.sim.time * (1.05 + 0.11 * (t.id % 5)) + t.id * 0.31;
    const wander = 1 + burst * 0.5 * Math.sin(phase * 2.2) + burst * 0.28 * (Math.random() - 0.5);
    const shotNoise = 1 + (Math.random() + Math.random() + Math.random() - 1.5) * tn * 0.55;
    const lambda = base * wander * shotNoise;
    let n = poissonSample(lambda);
    n = Math.min(n, budget);
    const cx = t.x;
    const cy = t.y;
    for (let i = 0; i < n; i++) {
      const micro = (Math.random() + Math.random() - 1) * spray * 0.1;
      const ang = mean + (Math.random() * 2 - 1) * spray + micro;
      const lo = pr.speedMin;
      const hi = pr.speedMax;
      const mid = (lo + hi) * 0.5;
      const half = (hi - lo) * 0.5;
      const u = (Math.random() + Math.random()) / 2;
      const sp = clamp(mid + (u * 2 - 1) * half * 0.95 + (Math.random() - 0.5) * half * 0.18, lo, hi);
      if (energyCap > 0) {
        const cost = sourceEmitEnergyCost(sp);
        if ((t._energyLeft ?? 0) < cost) break;
        t._energyLeft -= cost;
      }
      const cid = pr.colorId in COLOR_HEX ? pr.colorId : 'red';
      state.particles.push({
        id: state.nextParticleId++,
        x: cx + (Math.random() - 0.5) * cp * 0.04,
        y: cy + (Math.random() - 0.5) * cp * 0.04,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        colorId: cid,
        lastTileId: t.id,
      });
      bumpTileInteractGlow(t, cid, INTERACT_GLOW_EMIT);
      budget--;
    }
  }
}

function randomColorId() {
  return COLOR_IDS[(Math.random() * COLOR_IDS.length) | 0];
}

function bumpTileInteractGlow(tile, colorId, delta) {
  if (!tile || !(delta > 0)) return;
  const cid = COLOR_HEX[colorId] ? colorId : 'black';
  const g = tile._interactGlow || (tile._interactGlow = { colorId: cid, level: 0 });
  g.colorId = cid;
  g.level = Math.min(0.93, g.level + delta);
}

function decayTileInteractGlows(state, dt) {
  const k = Math.exp(-dt / INTERACT_GLOW_DECAY_S);
  for (const t of state.tiles.values()) {
    if (!t._interactGlow) continue;
    t._interactGlow.level *= k;
    if (t._interactGlow.level < 0.006) delete t._interactGlow;
  }
}

function beamPasses(fx, fy, tile) {
  const pr = tile.params;
  const cy = 0.5 + (pr.slitOffset || 0);
  const hw = (pr.slitW || 0.2) / 2;
  const dist = Math.abs(fy - cy);
  if (dist < hw) return true;
  const soft = pr.edgeSoft || 0;
  if (soft > EPS && dist < hw + soft) {
    const t = (dist - hw) / soft;
    return Math.random() > t;
  }
  return false;
}

function applyCellForces(state, p, dt, tile, cp) {
  const tcx = tile.x;
  const tcy = tile.y;
  const rx = p.x - tcx;
  const ry = p.y - tcy;
  const k = tile.kind;

  if (k === 'FOCUS') {
    if (Math.random() > clamp(tile.params.hitP ?? 0.9, 0.4, 0.999)) return;
    const [tx, ty] = norm(DIR_DX[tile.rotation], DIR_DY[tile.rotation]);
    const sp = hypot(p.vx, p.vy);
    const s = clamp(tile.params.strength * dt * 3 * (0.88 + 0.24 * Math.random()), 0, 1);
    const nx = p.vx * (1 - s) + tx * sp * s;
    const ny = p.vy * (1 - s) + ty * sp * s;
    p.vx = nx; p.vy = ny;
    return;
  }
  if (k === 'DIFFUSER') {
    const spread = ((tile.params.spreadDeg || 10) * Math.PI) / 180;
    let mul = 1;
    if (Math.random() < clamp(tile.params.spikeP ?? 0.09, 0, 0.35)) {
      mul = clamp(tile.params.spikeMul ?? 1.55, 1.05, 2.2);
    }
    const da = (Math.random() * 2 - 1) * spread * dt * 4 * mul;
    const ang = Math.atan2(p.vy, p.vx) + da;
    const sp = hypot(p.vx, p.vy);
    p.vx = Math.cos(ang) * sp;
    p.vy = Math.sin(ang) * sp;
    return;
  }
  if (k === 'SPEED_GATE') {
    if (Math.random() > clamp(tile.params.engageP ?? 0.88, 0.35, 0.999)) return;
    const [nx, ny] = norm(DIR_DX[tile.rotation], DIR_DY[tile.rotation]);
    const para = dot(p.vx, p.vy, nx, ny);
    const vpx = para * nx;
    const vpy = para * ny;
    const vxperp = p.vx - vpx;
    const vyperp = p.vy - vpy;
    const pg = (tile.params.parallelGain ?? 1.2) * (0.94 + 0.12 * Math.random());
    const tg = (tile.params.tangentialGain ?? 1) * (0.94 + 0.12 * Math.random());
    p.vx = vpx * pg + vxperp * tg;
    p.vy = vpy * pg + vyperp * tg;
    return;
  }
  if (k === 'SWIRL') {
    const R = hypot(rx, ry) + EPS;
    const oj = clamp(tile.params.omegaJitter ?? 0.14, 0, 0.45);
    const om = ((tile.params.omega || 100) / R) * (1 + (Math.random() * 2 - 1) * oj);
    const dec = Math.exp(-R * (tile.params.decay || 1) / cp);
    p.vx += -ry * om * dec * dt;
    p.vy += rx * om * dec * dt;
    return;
  }
  if (k === 'MEMBRANE') {
    const [nx, ny] = norm(DIR_DX[tile.rotation], DIR_DY[tile.rotation]);
    const vn = dot(p.vx, p.vy, nx, ny);
    let leak = clamp(tile.params.leakP || 0, 0, 1);
    const wb = clamp(tile.params.wobbleP ?? 0.06, 0, 0.25);
    leak = clamp(leak * (1 + (Math.random() * 2 - 1) * wb), 0, 1);
    if (vn < 0 && Math.random() > leak) {
      p.vx -= 2 * vn * nx;
      p.vy -= 2 * vn * ny;
    }
    return;
  }
  if (k === 'RESONATOR') {
    const sp = hypot(p.vx, p.vy) + EPS;
    const px = -p.vy / sp;
    const py = p.vx / sp;
    const aj = clamp(tile.params.ampJitter ?? 0.14, 0, 0.4);
    const A = (tile.params.amplitude || 200) * (0.86 + 0.28 * Math.random());
    const f = tile.params.freq || 2;
    const ph = state.sim.time * f * Math.PI * 2;
    const kick = A * Math.sin(ph + (Math.random() * 2 - 1) * aj) * dt;
    p.vx += px * kick;
    p.vy += py * kick;
    return;
  }
  if (k === 'COLLIMATOR') {
    const div = Math.max(2, (tile.params.divisions | 0) || 8);
    const snapP = clamp(tile.params.snapP ?? 0.8, 0, 1);
    const micro = ((tile.params.microJitterDeg ?? 1.2) * Math.PI) / 180;
    if (Math.random() < snapP) {
      let ang = Math.atan2(p.vy, p.vx);
      const step = (Math.PI * 2) / div;
      const base = (tile.rotation * Math.PI) / 2;
      ang = base + Math.round((ang - base) / step) * step;
      ang += (Math.random() * 2 - 1) * micro;
      const spd = hypot(p.vx, p.vy);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
    } else {
      const jd = ((tile.params.jitterDeg || 3) * Math.PI) / 180;
      const ang = Math.atan2(p.vy, p.vx) + (Math.random() * 2 - 1) * jd;
      const spd = hypot(p.vx, p.vy);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
    }
    return;
  }
  if (k === 'BEAM_SHAPER') {
    const fx = (p.x - (tile.x - cp * 0.5)) / cp;
    const fy = (p.y - (tile.y - cp * 0.5)) / cp;
    if (!beamPasses(fx, fy, tile) && (tile.params.mode || 'bounce') === 'absorb') {
      const base = (tile.params.absorbP || 0.3) * dt * 45;
      if (Math.random() < clamp(base * (0.82 + 0.36 * Math.random()), 0, 0.98)) {
        p._dead = true;
        return;
      }
    }
    return;
  }
  if (k === 'RECOLOR') {
    if (Math.random() < clamp(tile.params.skipP ?? 0.06, 0, 0.35)) return;
    const rr = (tile.params.recolorRate || 4) * dt * (0.85 + 0.3 * Math.random());
    if (Math.random() < rr) p.colorId = randomColorId();
  }
}

function processBuffers(state, dt) {
  const { cp } = worldSize(state);
  for (const t of state.tiles.values()) {
    if (t.kind !== 'BUFFER') continue;
    const buf = t._buf || (t._buf = []);
    const pr = t.params;
    const maxK = Math.max(1, pr.maxK | 0);

    if ((pr.burstOnFull | 0) === 1 && buf.length >= maxK) {
      while (buf.length > 0 && state.particles.length < MAX_PARTICLES) {
        const b = buf.shift();
        const ang = (t.rotation * Math.PI) / 2 + (Math.random() * 0.2 - 0.1);
        const sp = hypot(b.vx, b.vy) || 80;
        state.particles.push({
          id: state.nextParticleId++,
          x: t.x,
          y: t.y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          colorId: b.colorId,
          lastTileId: t.id,
        });
        bumpTileInteractGlow(t, b.colorId, INTERACT_GLOW_EMIT);
      }
      continue;
    }

    if (buf.length > 0 && state.particles.length < MAX_PARTICLES) {
      const lam = (pr.releaseRate || 10) * dt;
      let k = poissonSample(lam);
      k = Math.min(k, buf.length, MAX_PARTICLES - state.particles.length, MAX_BUFFER_RELEASE_PER_SUBSTEP);
      for (let i = 0; i < k; i++) {
        const b = buf.shift();
        if (!b) break;
        const ang = (t.rotation * Math.PI) / 2 + (Math.random() * 2 - 1) * 0.18;
        const sp = hypot(b.vx, b.vy) || 80;
        state.particles.push({
          id: state.nextParticleId++,
          x: t.x + (Math.random() - 0.5) * cp * 0.05,
          y: t.y + (Math.random() - 0.5) * cp * 0.05,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          colorId: b.colorId,
          lastTileId: t.id,
        });
        bumpTileInteractGlow(t, b.colorId, INTERACT_GLOW_EMIT);
      }
    }
  }
}

function subStep(state, dt, telePairs) {
  const cp = cellPx(state);
  decayTileInteractGlows(state, dt);
  emitFromSources(state, dt);

  const splits = [];
  const out = [];

  for (const p of state.particles) {
    p._dead = false;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    bounceWalls(state, p);

    const t = tileAtPoint(state, p.x, p.y);
    const tid = t ? t.id : null;
    const entered = p.lastTileId === undefined || p.lastTileId !== tid;
    let skipForces = false;

    if (!t) {
      p.lastTileId = null;
      out.push(p);
      continue;
    }

    if (t.kind === 'BUFFER') {
      const buf = t._buf || (t._buf = []);
      const maxK = Math.max(1, t.params.maxK | 0);
      if (buf.length < maxK) {
        const slip = clamp(t.params.slipP ?? 0.022, 0, 0.22);
        if (Math.random() >= slip) {
          buf.push({ vx: p.vx, vy: p.vy, colorId: p.colorId });
          bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
          p.lastTileId = tid;
          continue;
        }
      }
      out.push(p);
      p.lastTileId = tid;
      continue;
    }

    if (t.kind === 'SPLITTER' && entered && Math.random() < clamp(t.params.splitP ?? 1, 0, 1)) {
      bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
      const f = t.params.childSpeed || 0.72;
      const sp0 = hypot(p.vx, p.vy) * f;
      const sp1 = hypot(p.vx, p.vy) * f;
      const jit = ((t.params.angleJitterDeg ?? 3) * Math.PI) / 180;
      const a0 = (t.rotation * Math.PI) / 2 + (Math.random() * 2 - 1) * jit;
      const a1 = ((t.rotation + 1) * Math.PI) / 2 + (Math.random() * 2 - 1) * jit;
      splits.push({
        id: state.nextParticleId++,
        x: p.x, y: p.y,
        vx: Math.cos(a0) * sp0, vy: Math.sin(a0) * sp0,
        colorId: p.colorId, lastTileId: tid,
      });
      splits.push({
        id: state.nextParticleId++,
        x: p.x, y: p.y,
        vx: Math.cos(a1) * sp1, vy: Math.sin(a1) * sp1,
        colorId: p.colorId, lastTileId: tid,
      });
      continue;
    }

    if (t.kind === 'TELEPORT' && entered) {
      const partner = telePairs.get(t.id);
      if (partner && Math.random() > clamp(t.params.malfunctionP || 0, 0, 1)) {
        bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
        bumpTileInteractGlow(partner, p.colorId, INTERACT_GLOW_DISCRETE * 0.85);
        const pcx = partner.x;
        const pcy = partner.y;
        p.x = pcx + (Math.random() * 0.2 - 0.1) * cp;
        p.y = pcy + (Math.random() * 0.2 - 0.1) * cp;
        const cone = ((t.params.coneDeg || 10) * Math.PI) / 180;
        const ej = ((t.params.exitJitterDeg ?? 4) * Math.PI) / 180;
        const base = (partner.rotation * Math.PI) / 2;
        const ang = base + (Math.random() * 2 - 1) * (cone + ej * 0.65);
        const sp = hypot(p.vx, p.vy) || 60;
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
        p.lastTileId = partner.id;
        skipForces = true;
      }
    }

    if (t.kind === 'ABSORBER') {
      const base = clamp(t.params.absorbP, 0, 1) * dt * 45;
      const j = clamp(t.params.absorbJitter ?? 0.18, 0, 0.45);
      const pTry = clamp(base * (0.84 + (Math.random() + Math.random() - 1) * j), 0, 0.98);
      if (Math.random() < pTry) {
        bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
        continue;
      }
    }

    if (t.kind === 'GOAL') {
      const filt = t.params.filterColor || 'any';
      const ok = filt === 'any' || filt === p.colorId;
      const cap = t.params.capacity | 0;
      const capP = clamp(t.params.captureP ?? 0.93, 0.02, 0.999);
      if (ok && (cap <= 0 || (t._captured | 0) < cap) && Math.random() < capP) {
        t._captured = (t._captured | 0) + 1;
        bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
        continue;
      }
    }

    if (t.kind === 'SOURCE') {
      p.lastTileId = tid;
      out.push(p);
      continue;
    }

    if (t.kind === 'REFLECTOR' && entered) {
      bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
      const [rx, ry] = reflectMirror(p.vx, p.vy, t.rotation);
      p.vx = rx;
      p.vy = ry;
      if (Math.random() < clamp(t.params.scatterP ?? 0.72, 0, 1)) {
        const jd = ((t.params.scatterDeg ?? 4) * Math.PI) / 180;
        const ang = Math.atan2(p.vy, p.vx) + (Math.random() * 2 - 1) * jd;
        const sp = hypot(p.vx, p.vy);
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
      }
    }

    if (t.kind === 'BEAM_SHAPER' && entered) {
      const fx = (p.x - (t.x - cp * 0.5)) / cp;
      const fy = (p.y - (t.y - cp * 0.5)) / cp;
      if (!beamPasses(fx, fy, t) && (t.params.mode || 'bounce') === 'bounce') {
        const soft = clamp(t.params.bounceSoftP ?? 0.12, 0, 0.4);
        if (Math.random() > soft) {
          p.vy = -p.vy;
          bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE * 0.75);
        }
      }
    }

    const glowColor = p.colorId;
    const vxa = p.vx, vya = p.vy, c0 = p.colorId;
    if (!skipForces) applyCellForces(state, p, dt, t, cp);
    if (!skipForces) {
      if (p._dead) bumpTileInteractGlow(t, glowColor, INTERACT_GLOW_DISCRETE);
      else if (p.vx !== vxa || p.vy !== vya || p.colorId !== c0) {
        bumpTileInteractGlow(t, glowColor, INTERACT_GLOW_CONTINUOUS);
      }
    }

    if (p._dead) continue;

    p.lastTileId = tid;
    out.push(p);
  }

  state.particles = out.concat(splits);
  if (state.particles.length > MAX_PARTICLES) {
    state.particles = state.particles.slice(-MAX_PARTICLES);
  }

  processBuffers(state, dt);
}

function physicsAccumulate(state, realDt) {
  const mult = SPEED_MULT[state.sim.speed] || 1;
  state.sim.accumulator += realDt * mult;
  const telePairs = buildTeleportPartners(state);
  let steps = 0;
  while (state.sim.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    state.sim.accumulator -= FIXED_DT;
    state.sim.time += FIXED_DT;
    subStep(state, FIXED_DT, telePairs);
    steps++;
  }
}

/* ---------- Render SVG ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(el, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, el);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function cellPx(state) { return state.level.cellPx; }

function drawArrow(tipX, tipY, rot, cx, cy, klass) {
  const sz = 5;
  const poly = svg('polygon', {
    points: `${tipX},${tipY} ${tipX - sz - 1},${tipY - sz} ${tipX - sz - 1},${tipY + sz}`,
    class: klass,
  });
  poly.setAttribute('transform', `rotate(${rot * 90} ${cx} ${cy})`);
  return poly;
}

function drawTileG(tile, ghost, cellSize) {
  const d = cellSize || 56;
  const scale = d / 56;
  const root = svg('g', { transform: `scale(${scale})` });
  const cp = 56;
  const cx = cp / 2;
  const cy = cp / 2;
  const frameC = ghost ? 'ghost-frame' : 'tile-frame';
  const arrowC = ghost ? 'ghost-arrow' : 'tile-arrow';
  const labelC = ghost ? 'tile-label ghost-label' : 'tile-label';
  const g = svg('g', null);
  g.appendChild(svg('rect', { x: 3, y: 3, width: cp - 6, height: cp - 6, class: frameC }));

  const meta = KIND_META[tile.kind];
  const lab = meta ? meta.label : tile.kind;

  const tip = cp / 2 - 3;
  const rot = tile.rotation;

  if (tile.kind === 'SOURCE') {
    const col = COLOR_HEX[tile.params.colorId] || '#000';
    g.appendChild(svg('circle', { cx, cy, r: 11, fill: col, stroke: '#000', 'stroke-width': 1 }));
    g.appendChild(drawArrow(cx + tip - 4, cy, rot, cx, cy, arrowC));
  } else if (tile.kind === 'FOCUS') {
    g.appendChild(svg('path', {
      d: `M ${cx} ${cy - 10} L ${cx + 12} ${cy} L ${cx} ${cy + 10} L ${cx - 12} ${cy} Z`,
      class: 'tile-stroke',
      transform: `rotate(${rot * 90} ${cx} ${cy})`,
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 16, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'DIFFUSER') {
    for (let i = -1; i <= 1; i++) {
      g.appendChild(svg('line', {
        x1: cx - 14, y1: cy + i * 5, x2: cx + 14, y2: cy + i * 5 + (i === 0 ? 0 : 4 * (i > 0 ? -1 : 1)),
        class: 'tile-stroke',
        transform: `rotate(${rot * 90} ${cx} ${cy})`,
      }));
    }
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'REFLECTOR') {
    g.appendChild(svg('line', {
      x1: cx, y1: 6, x2: cx, y2: cp - 6,
      class: 'tile-stroke',
      'stroke-width': 2,
      transform: `rotate(${rot * 90 + 45} ${cx} ${cy})`,
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'ABSORBER') {
    g.appendChild(svg('rect', { x: cx - 10, y: cy - 10, width: 20, height: 20, class: 'tile-stroke', 'stroke-dasharray': '2 2' }));
    g.appendChild(svg('text', { x: cx, y: cy + 3, class: labelC, 'font-size': '9' }, lab));
  } else if (tile.kind === 'GOAL') {
    g.appendChild(svg('circle', { cx, cy, r: 14, class: 'tile-stroke' }));
    g.appendChild(svg('circle', { cx, cy, r: 6, class: 'tile-stroke' }));
    g.appendChild(svg('text', { x: cx, y: cy + 20, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'SPLITTER') {
    g.appendChild(svg('path', {
      d: `M ${cx} ${cy} L ${cx + 14} ${cy - 10} M ${cx} ${cy} L ${cx + 14} ${cy + 10}`,
      class: 'tile-stroke',
      transform: `rotate(${rot * 90} ${cx} ${cy})`,
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'RECOLOR') {
    g.appendChild(svg('rect', { x: cx - 12, y: cy - 8, width: 24, height: 16, class: 'tile-stroke' }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'SPEED_GATE') {
    g.appendChild(svg('polygon', {
      points: `${cx - 12},${cy + 8} ${cx + 12},${cy + 8} ${cx},${cy - 10}`,
      class: 'tile-stroke',
      transform: `rotate(${rot * 90} ${cx} ${cy})`,
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 20, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'SWIRL') {
    g.appendChild(svg('path', {
      d: `M ${cx + 10} ${cy} A 10 10 0 1 1 ${cx} ${cy - 10}`,
      class: 'tile-stroke', fill: 'none',
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'TELEPORT') {
    g.appendChild(svg('rect', { x: cx - 12, y: cy - 12, width: 24, height: 24, class: 'tile-stroke', rx: 3 }));
    g.appendChild(svg('text', { x: cx, y: cy + 4, class: labelC, 'font-size': '10' }, String(tile.params.linkId | 0)));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '7' }, lab));
  } else if (tile.kind === 'MEMBRANE') {
    g.appendChild(svg('line', { x1: 6, y1: cy, x2: cp - 6, y2: cy, class: 'tile-stroke', 'stroke-width': 2 }));
    g.appendChild(drawArrow(cx + tip - 6, cy, rot, cx, cy, arrowC));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'BEAM_SHAPER') {
    g.appendChild(svg('rect', { x: cx - 14, y: cy - 4, width: 28, height: 8, class: 'tile-stroke' }));
    g.appendChild(svg('text', { x: cx, y: cy + 16, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'RESONATOR') {
    g.appendChild(svg('path', { d: `M ${cx - 12} ${cy} Q ${cx} ${cy - 14} ${cx + 12} ${cy}`, class: 'tile-stroke', fill: 'none' }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'COLLIMATOR') {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rot * (Math.PI / 2);
      g.appendChild(svg('line', {
        x1: cx, y1: cy, x2: cx + Math.cos(a) * 14, y2: cy + Math.sin(a) * 14,
        class: 'tile-stroke',
      }));
    }
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'BUFFER') {
    g.appendChild(svg('rect', { x: cx - 12, y: cy - 10, width: 24, height: 20, class: 'tile-stroke' }));
    g.appendChild(drawArrow(cx + tip - 4, cy, rot, cx, cy, arrowC));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else {
    g.appendChild(svg('text', { x: cx, y: cy, class: labelC, 'font-size': '9' }, lab));
  }

  root.appendChild(g);
  return root;
}

function svgClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderBoardSvg(state, host) {
  const cp = cellPx(state);
  const { gridW, gridH } = state.level;
  const w = gridW * cp;
  const h = gridH * cp;
  host.setAttribute('width', w);
  host.setAttribute('height', h);
  host.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svgClear(host);

  const layerTiles = svg('g', { id: 'layer-tiles' });
  const layerHover = svg('g', { id: 'layer-hover' });
  host.appendChild(layerTiles);
  host.appendChild(layerHover);

  const innerDesign = 56;
  for (const tile of state.tiles.values()) {
    const root = drawTileG(tile, false, cp);
    root.setAttribute('transform', `translate(${tile.x - cp / 2} ${tile.y - cp / 2})`);
    root.setAttribute('data-tile-id', String(tile.id));
    if (state.ui.inspectorTileId === tile.id) {
      const fr = root.querySelector('.tile-frame, .ghost-frame');
      if (fr) fr.classList.add('inspector-target');
    }
    if (tile._interactGlow && tile._interactGlow.level > 0.004) {
      const hex = COLOR_HEX[tile._interactGlow.colorId] || '#888888';
      const lv = tile._interactGlow.level;
      const op = Math.min(0.48, Math.pow(lv, 0.9) * 0.44);
      root.appendChild(svg('rect', {
        class: 'tile-interact-glow',
        x: 4,
        y: 4,
        width: innerDesign - 8,
        height: innerDesign - 8,
        rx: 2,
        fill: hex,
        opacity: String(op),
        'pointer-events': 'none',
      }));
    }
    layerTiles.appendChild(root);
  }

  const hw = state.ui.hoverWorld;
  if (hw) {
    const ex = tileAtPoint(state, hw.x, hw.y);
    if (state.ui.brush) {
      const ok = canPlaceTileCenter(state, hw.x, hw.y, null);
      if (ok && !ex) {
        const ghost = {
          kind: state.ui.brush.kind,
          rotation: state.ui.brush.rotation,
          params: state.ui.brush.params || defaultParams(state.ui.brush.kind),
        };
        const gg = drawTileG(ghost, true, cp);
        gg.setAttribute('transform', `translate(${ok.x - cp / 2} ${ok.y - cp / 2})`);
        layerHover.appendChild(gg);
      }
    } else if (ex) {
      layerHover.appendChild(svg('rect', {
        x: ex.x - cp / 2 + 2, y: ex.y - cp / 2 + 2, width: cp - 4, height: cp - 4,
        class: 'hover-occupied',
      }));
    }
  }
}

function renderParticlesCanvas(state) {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const cp = cellPx(state);
  const { gridW, gridH } = state.level;
  const w = gridW * cp;
  const h = gridH * cp;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = (w * dpr) | 0;
  const bh = (h * dpr) | 0;
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const r = 1.35;
  for (const p of state.particles) {
    ctx.fillStyle = COLOR_HEX[p.colorId] || '#000';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------- Storage ---------- */

const Storage = {
  KEY: 'streams.v1',
  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; }
    catch (e) { return {}; }
  },
  save(d) {
    try { localStorage.setItem(this.KEY, JSON.stringify(d)); }
    catch (e) { console.error(e); }
  },
  getBoard() {
    const d = this.load();
    return Array.isArray(d.board) ? d.board : null;
  },
  saveBoard(board) {
    const d = this.load();
    d.board = board;
    d.posPx = true;
    this.save(d);
  },
  getSpeed() {
    const d = this.load();
    const v = Number(d.speed);
    return Number.isFinite(v) ? v : 1;
  },
  saveSpeed(s) {
    const d = this.load();
    d.speed = s;
    this.save(d);
  },
};

/* ---------- Board edit / undo ---------- */

function commitBoardEdit(state, before) {
  const after = snapshotBoard(state);
  if (sameBoardSnapshot(before, after)) return false;
  state.history.past.push(before);
  state.history.future = [];
  Storage.saveBoard(after);
  invalidateAllParticleTileEntry(state);
  return true;
}

function withBoardEdit(state, fn) {
  const before = snapshotBoard(state);
  const ok = fn();
  if (!ok) return false;
  return commitBoardEdit(state, before);
}

function undoBoard(state) {
  if (state.history.past.length === 0) return false;
  const cur = snapshotBoard(state);
  const prev = state.history.past.pop();
  state.history.future.push(cur);
  applyBoardSnapshot(state, prev, false);
  Storage.saveBoard(prev);
  invalidateAllParticleTileEntry(state);
  return true;
}

function redoBoard(state) {
  if (state.history.future.length === 0) return false;
  const cur = snapshotBoard(state);
  const next = state.history.future.pop();
  state.history.past.push(cur);
  applyBoardSnapshot(state, next, false);
  Storage.saveBoard(next);
  invalidateAllParticleTileEntry(state);
  return true;
}

/* ---------- Popover params ---------- */

function bindParamSlider(row, label, min, max, step, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'insp-row';
  const lb = document.createElement('label');
  lb.textContent = label;
  const val = document.createElement('div');
  val.className = 'insp-val';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const sync = () => {
    val.textContent = input.value;
    onChange(parseFloat(input.value));
  };
  input.addEventListener('input', sync);
  val.textContent = input.value;
  wrap.appendChild(lb);
  wrap.appendChild(input);
  wrap.appendChild(val);
  row.appendChild(wrap);
}

function selectTileForInspector(tile) {
  APP.state.ui.inspectorTileId = tile.id;
  inspectorDomSig = '';
  APP.render();
}

function clearInspector() {
  if (!APP) return;
  APP.state.ui.inspectorTileId = null;
  inspectorDomSig = '';
  const host = document.getElementById('tile-inspector');
  if (host) {
    host.innerHTML = '<div class="inspector-empty">click a tile</div>';
  }
}

function renderTileInspector() {
  const host = document.getElementById('tile-inspector');
  if (!host) return;

  const id = APP.state.ui.inspectorTileId;
  const tile = id != null ? APP.state.tiles.get(id) : null;
  if (!tile) {
    if (id != null) APP.state.ui.inspectorTileId = null;
    inspectorDomSig = '';
    host.innerHTML = '<div class="inspector-empty">click a tile</div>';
    return;
  }

  const sig = `${tile.id}|${tile.x}|${tile.y}|${tile.rotation}|${tile.kind}|${JSON.stringify(tile.params)}`;
  if (sig === inspectorDomSig && host.querySelector('.inspector-params')) return;
  inspectorDomSig = sig;

  host.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'inspector-header';
  hdr.textContent = `${tile.kind}  ·  ${tile.x.toFixed(0)},${tile.y.toFixed(0)}`;
  host.appendChild(hdr);

  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  if (KIND_META[tile.kind]?.hasRotation) {
    const rotBtn = document.createElement('button');
    rotBtn.type = 'button';
    rotBtn.textContent = 'rotate';
    rotBtn.onclick = e => {
      e.preventDefault();
      withBoardEdit(APP.state, () => { rotateTile(APP.state, tile.id); return true; });
      inspectorDomSig = '';
      APP.render();
    };
    actions.appendChild(rotBtn);
  }
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.textContent = 'remove';
  delBtn.onclick = e => {
    e.preventDefault();
    withBoardEdit(APP.state, () => deleteTile(APP.state, tile.id));
    clearInspector();
    APP.render();
  };
  actions.appendChild(delBtn);
  host.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'inspector-params';
  const P = tile.params;

  const persistParams = () => {
    Storage.saveBoard(snapshotBoard(APP.state));
    invalidateAllParticleTileEntry(APP.state);
  };

  if (tile.kind === 'SOURCE') {
    bindParamSlider(body, 'rate / sec', 0, 600, 5, P.rate, v => { tile.params.rate = v; persistParams(); });
    bindParamSlider(body, 'speed min', 20, 400, 5, P.speedMin, v => { tile.params.speedMin = v; persistParams(); });
    bindParamSlider(body, 'speed max', 20, 500, 5, P.speedMax, v => { tile.params.speedMax = v; persistParams(); });
    bindParamSlider(body, 'spray °', 0, 85, 1, P.sprayDeg, v => { tile.params.sprayDeg = v; persistParams(); });
    bindParamSlider(body, 'timing noise', 0, 0.55, 0.02, P.timingNoise ?? 0.22, v => { tile.params.timingNoise = v; persistParams(); });
    bindParamSlider(body, 'slow wander', 0, 0.45, 0.02, P.burst, v => { tile.params.burst = v; persistParams(); });
    bindParamSlider(body, 'emit energy (0=∞)', 0, 2e6, 2500, P.energyBudget ?? 0, v => {
      tile.params.energyBudget = v | 0;
      const cap = tile.params.energyBudget | 0;
      if (cap > 0) tile._energyLeft = cap;
      else delete tile._energyLeft;
      persistParams();
    });
    const cr = document.createElement('div');
    cr.className = 'color-row';
    for (const c of COLOR_IDS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch' + (P.colorId === c ? ' active' : '');
      sw.style.background = COLOR_HEX[c];
      sw.title = c;
      sw.onclick = (e) => {
        e.stopPropagation();
        tile.params.colorId = c;
        persistParams();
        inspectorDomSig = '';
        APP.render();
      };
      cr.appendChild(sw);
    }
    body.appendChild(cr);
  } else if (tile.kind === 'FOCUS') {
    bindParamSlider(body, 'strength', 0.2, 12, 0.2, P.strength, v => { tile.params.strength = v; persistParams(); });
    bindParamSlider(body, 'pull applies p', 0.5, 0.999, 0.01, P.hitP ?? 0.9, v => { tile.params.hitP = v; persistParams(); });
  } else if (tile.kind === 'DIFFUSER') {
    bindParamSlider(body, 'spread °', 0, 70, 1, P.spreadDeg, v => { tile.params.spreadDeg = v; persistParams(); });
    bindParamSlider(body, 'spike chance', 0, 0.3, 0.02, P.spikeP ?? 0.09, v => { tile.params.spikeP = v; persistParams(); });
  } else if (tile.kind === 'REFLECTOR') {
    bindParamSlider(body, 'scatter apply p', 0, 1, 0.02, P.scatterP ?? 0.72, v => { tile.params.scatterP = v; persistParams(); });
    bindParamSlider(body, 'scatter °', 0, 18, 0.5, P.scatterDeg ?? 4, v => { tile.params.scatterDeg = v; persistParams(); });
  } else if (tile.kind === 'ABSORBER') {
    bindParamSlider(body, 'absorb p (×dt)', 0.02, 1, 0.02, P.absorbP, v => { tile.params.absorbP = v; persistParams(); });
    bindParamSlider(body, 'p jitter', 0, 0.45, 0.02, P.absorbJitter ?? 0.18, v => { tile.params.absorbJitter = v; persistParams(); });
  } else if (tile.kind === 'GOAL') {
    bindParamSlider(body, 'capture p', 0.5, 0.999, 0.01, P.captureP ?? 0.93, v => { tile.params.captureP = v; persistParams(); });
    bindParamSlider(body, 'capacity (0=∞)', 0, 500, 1, P.capacity | 0, v => { tile.params.capacity = v | 0; persistParams(); });
    const cr = document.createElement('div');
    cr.className = 'color-row';
    const opts = ['any', ...COLOR_IDS];
    for (const c of opts) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch' + ((P.filterColor || 'any') === c ? ' active' : '');
      sw.style.background = c === 'any' ? '#eee' : COLOR_HEX[c];
      sw.textContent = c === 'any' ? '∗' : '';
      sw.title = c;
      sw.onclick = (e) => {
        e.stopPropagation();
        tile.params.filterColor = c;
        persistParams();
        inspectorDomSig = '';
        APP.render();
      };
      cr.appendChild(sw);
    }
    body.appendChild(cr);
  } else if (tile.kind === 'SPLITTER') {
    bindParamSlider(body, 'split chance', 0, 1, 0.05, P.splitP, v => { tile.params.splitP = v; persistParams(); });
    bindParamSlider(body, 'child speed ×', 0.3, 1, 0.02, P.childSpeed, v => { tile.params.childSpeed = v; persistParams(); });
    bindParamSlider(body, 'angle jitter °', 0, 12, 0.5, P.angleJitterDeg ?? 3, v => { tile.params.angleJitterDeg = v; persistParams(); });
  } else if (tile.kind === 'RECOLOR') {
    bindParamSlider(body, 'recolor rate', 0.5, 30, 0.5, P.recolorRate, v => { tile.params.recolorRate = v; persistParams(); });
    bindParamSlider(body, 'quiet frames p', 0, 0.25, 0.02, P.skipP ?? 0.06, v => { tile.params.skipP = v; persistParams(); });
  } else if (tile.kind === 'SPEED_GATE') {
    bindParamSlider(body, '∥ gain', 0.2, 2.5, 0.05, P.parallelGain, v => { tile.params.parallelGain = v; persistParams(); });
    bindParamSlider(body, '⊥ gain', 0.2, 2.5, 0.05, P.tangentialGain, v => { tile.params.tangentialGain = v; persistParams(); });
    bindParamSlider(body, 'gate applies p', 0.4, 0.999, 0.02, P.engageP ?? 0.88, v => { tile.params.engageP = v; persistParams(); });
  } else if (tile.kind === 'SWIRL') {
    bindParamSlider(body, 'omega', 20, 500, 10, P.omega, v => { tile.params.omega = v; persistParams(); });
    bindParamSlider(body, 'decay', 0.2, 6, 0.1, P.decay, v => { tile.params.decay = v; persistParams(); });
    bindParamSlider(body, 'ω jitter', 0, 0.4, 0.02, P.omegaJitter ?? 0.14, v => { tile.params.omegaJitter = v; persistParams(); });
  } else if (tile.kind === 'TELEPORT') {
    bindParamSlider(body, 'link id', 0, 7, 1, P.linkId | 0, v => { tile.params.linkId = v | 0; persistParams(); });
    bindParamSlider(body, 'fail p', 0, 1, 0.02, P.malfunctionP, v => { tile.params.malfunctionP = v; persistParams(); });
    bindParamSlider(body, 'exit cone °', 0, 60, 1, P.coneDeg, v => { tile.params.coneDeg = v; persistParams(); });
    bindParamSlider(body, 'exit extra jitter °', 0, 22, 0.5, P.exitJitterDeg ?? 4, v => { tile.params.exitJitterDeg = v; persistParams(); });
  } else if (tile.kind === 'MEMBRANE') {
    bindParamSlider(body, 'leak p', 0, 1, 0.02, P.leakP, v => { tile.params.leakP = v; persistParams(); });
    bindParamSlider(body, 'leak wobble', 0, 0.28, 0.02, P.wobbleP ?? 0.06, v => { tile.params.wobbleP = v; persistParams(); });
  } else if (tile.kind === 'BEAM_SHAPER') {
    bindParamSlider(body, 'slit width', 0.06, 0.45, 0.01, P.slitW, v => { tile.params.slitW = v; persistParams(); });
    bindParamSlider(body, 'slit offset', -0.35, 0.35, 0.02, P.slitOffset, v => { tile.params.slitOffset = v; persistParams(); });
    bindParamSlider(body, 'edge soft', 0, 0.2, 0.01, P.edgeSoft, v => { tile.params.edgeSoft = v; persistParams(); });
    bindParamSlider(body, 'absorb p (abs mode)', 0, 1, 0.05, P.absorbP, v => { tile.params.absorbP = v; persistParams(); });
    bindParamSlider(body, 'bounce skip p', 0, 0.35, 0.02, P.bounceSoftP ?? 0.12, v => { tile.params.bounceSoftP = v; persistParams(); });
    const row = document.createElement('div');
    row.className = 'insp-select-row';
    const lab = document.createElement('label');
    lab.textContent = 'mode';
    const sel = document.createElement('select');
    for (const m of ['bounce', 'absorb']) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (P.mode === m) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { tile.params.mode = sel.value; persistParams(); };
    row.appendChild(lab);
    row.appendChild(sel);
    body.appendChild(row);
  } else if (tile.kind === 'RESONATOR') {
    bindParamSlider(body, 'amplitude', 50, 900, 10, P.amplitude, v => { tile.params.amplitude = v; persistParams(); });
    bindParamSlider(body, 'freq', 0.5, 10, 0.1, P.freq, v => { tile.params.freq = v; persistParams(); });
    bindParamSlider(body, 'amp jitter', 0, 0.35, 0.02, P.ampJitter ?? 0.14, v => { tile.params.ampJitter = v; persistParams(); });
  } else if (tile.kind === 'COLLIMATOR') {
    bindParamSlider(body, 'divisions', 2, 24, 1, P.divisions | 0, v => { tile.params.divisions = v | 0; persistParams(); });
    bindParamSlider(body, 'snap chance', 0, 1, 0.05, P.snapP, v => { tile.params.snapP = v; persistParams(); });
    bindParamSlider(body, 'jitter °', 0, 25, 1, P.jitterDeg, v => { tile.params.jitterDeg = v; persistParams(); });
    bindParamSlider(body, 'post-snap micro °', 0, 5, 0.1, P.microJitterDeg ?? 1.2, v => { tile.params.microJitterDeg = v; persistParams(); });
  } else if (tile.kind === 'BUFFER') {
    bindParamSlider(body, 'max hold', 1, 200, 1, P.maxK | 0, v => { tile.params.maxK = v | 0; persistParams(); });
    bindParamSlider(body, 'release / sec', 0.5, 80, 0.5, P.releaseRate, v => { tile.params.releaseRate = v; persistParams(); });
    bindParamSlider(body, 'slip past p', 0, 0.2, 0.005, P.slipP ?? 0.022, v => { tile.params.slipP = v; persistParams(); });
    bindParamSlider(body, 'burst when full', 0, 1, 1, P.burstOnFull | 0, v => { tile.params.burstOnFull = v | 0; persistParams(); });
  }

  host.appendChild(body);
}

/* ---------- Palette & HUD ---------- */

function renderPalette() {
  const host = document.getElementById('palette');
  host.innerHTML = '';
  const { level, ui } = APP.state;
  for (let i = 0; i < level.palette.length; i++) {
    const kind = level.palette[i];
    const entry = document.createElement('div');
    entry.className = 'palette-entry';
    if (ui.brush && ui.brush.kind === kind) entry.classList.add('active');
    const glyph = document.createElementNS(SVG_NS, 'svg');
    glyph.setAttribute('class', 'pe-glyph');
    glyph.setAttribute('viewBox', '0 0 56 56');
    const fake = {
      kind,
      rotation: ui.brush && ui.brush.kind === kind ? ui.brush.rotation : 0,
      params: defaultParams(kind),
    };
    const inner = drawTileG(fake, false, 56);
    inner.setAttribute('transform', 'translate(0 0)');
    glyph.appendChild(inner);
    entry.appendChild(glyph);
    const label = document.createElement('div');
    label.className = 'pe-label';
    label.textContent = `${kind}`;
    entry.appendChild(label);
    if (KIND_META[kind]?.hasRotation) {
      const rotBox = document.createElement('div');
      rotBox.className = 'pe-rot';
      const cur = ui.brush && ui.brush.kind === kind ? ui.brush.rotation : 0;
      const layout = [[null, 3, null], [2, null, 0], [null, 1, null]];
      for (const row of layout) {
        const r = document.createElement('div');
        r.className = 'pe-rot-row';
        for (const v of row) {
          const d = document.createElement('div');
          if (v === null) { d.style.width = '5px'; d.style.height = '5px'; }
          else {
            d.className = 'pe-dot' + (v === cur ? ' lit' : '');
          }
          r.appendChild(d);
        }
        rotBox.appendChild(r);
      }
      rotBox.addEventListener('click', e => {
        e.stopPropagation();
        if (!ui.brush || ui.brush.kind !== kind) {
          ui.brush = { kind, rotation: 0, params: defaultParams(kind) };
        }
        ui.brush.rotation = (ui.brush.rotation + 1) % 4;
        APP.render();
      });
      entry.appendChild(rotBox);
    }
    entry.addEventListener('click', () => {
      if (ui.brush && ui.brush.kind === kind) ui.brush = null;
      else ui.brush = { kind, rotation: 0, params: defaultParams(kind) };
      APP.render();
    });
    host.appendChild(entry);
  }
}

function renderGoals() {
  const host = document.getElementById('task');
  host.innerHTML = '';
  const goals = [...APP.state.tiles.values()].filter(t => t.kind === 'GOAL');
  if (goals.length === 0) {
    host.innerHTML = '<div class="tp-label">no goals placed</div>';
    return;
  }
  for (const g of goals) {
    const row = document.createElement('div');
    row.className = 'tp-row';
    const filt = g.params.filterColor || 'any';
    row.innerHTML = `<div class="tp-label">goal #${g.id} (${filt})</div>
      <div class="tp-str"><b>${g._captured ?? 0}</b> captured</div>`;
    host.appendChild(row);
  }
}

function renderHUD() {
  document.getElementById('m-time').textContent = APP.state.sim.time.toFixed(1);
  document.getElementById('m-dots').textContent = String(APP.state.particles.length);
  document.getElementById('m-fps').textContent = APP.state.sim.fpsAvg > 0 ? APP.state.sim.fpsAvg.toFixed(0) : '—';
  const host = document.getElementById('stats');
  let buf = 0;
  for (const t of APP.state.tiles.values()) {
    if (t.kind === 'BUFFER' && t._buf) buf += t._buf.length;
  }
  host.innerHTML = `
    <div class="sp-row"><span>buffered</span><b>${buf}</b></div>
    <div class="sp-row"><span>tiles</span><b>${APP.state.tiles.size}</b></div>
  `;
}

/* ---------- Input ---------- */

let APP = null;
let BOARD_INPUT_ATTACHED = false;
/** Avoid rebuilding tile inspector DOM when only unrelated UI (e.g. hover) changes. */
let inspectorDomSig = '';

function worldFromEvent(boardEl, ev) {
  const ctm = boardEl.getScreenCTM();
  if (!ctm) return null;
  const pt = boardEl.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const loc = pt.matrixTransform(ctm.inverse());
  const { w, h } = worldSize(APP.state);
  if (loc.x < 0 || loc.y < 0 || loc.x > w || loc.y > h) return null;
  return { x: loc.x, y: loc.y };
}

function attachBoardInput(boardEl) {
  boardEl.addEventListener('contextmenu', e => e.preventDefault());
  boardEl.addEventListener('mousedown', e => {
    const world = worldFromEvent(boardEl, e);
    if (!world) return;
    APP.state.ui.hoverWorld = world;
    const tile = tileAtPoint(APP.state, world.x, world.y);

    if (e.button === 2) {
      if (tile) {
        if (KIND_META[tile.kind]?.hasRotation) {
          withBoardEdit(APP.state, () => { rotateTile(APP.state, tile.id); return true; });
        }
        inspectorDomSig = '';
        APP.render();
      }
      return;
    }
    if (e.button !== 0) return;

    if (tile) {
      const startX = e.clientX, startY = e.clientY;
      let dragged = false;
      const dragStartSnap = snapshotBoard(APP.state);
      const grabDx = world.x - tile.x;
      const grabDy = world.y - tile.y;
      const onMove = ev => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
          dragged = true;
          document.getElementById('trash').classList.add('armed');
        }
        if (dragged) {
          const wloc = worldFromEvent(boardEl, ev);
          if (wloc) tryMoveTileTo(APP.state, tile.id, wloc.x - grabDx, wloc.y - grabDy);
          APP.render();
        }
      };
      const onUp = ev => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.getElementById('trash').classList.remove('armed');
        if (!dragged) selectTileForInspector(tile);
        else {
          const trash = document.getElementById('trash').getBoundingClientRect();
          const overTrash = ev.clientX >= trash.left && ev.clientX <= trash.right
            && ev.clientY >= trash.top && ev.clientY <= trash.bottom;
          if (overTrash) {
            withBoardEdit(APP.state, () => {
              const tid = tile.id;
              const ok = deleteTile(APP.state, tid);
              if (ok && APP.state.ui.inspectorTileId === tid) clearInspector();
              return ok;
            });
          } else {
            commitBoardEdit(APP.state, dragStartSnap);
            inspectorDomSig = '';
          }
          APP.render();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    if (APP.state.ui.brush) {
      const b = APP.state.ui.brush;
      if (canPlaceTileCenter(APP.state, world.x, world.y, null)) {
        withBoardEdit(APP.state, () => !!placeTile(APP.state, b.kind, world.x, world.y, b.rotation, b.params));
      }
      APP.render();
    }
  });

  boardEl.addEventListener('mousemove', e => {
    const wloc = worldFromEvent(boardEl, e);
    const prev = APP.state.ui.hoverWorld;
    const ch = (!prev && wloc) || (prev && !wloc)
      || (prev && wloc && (prev.x !== wloc.x || prev.y !== wloc.y));
    APP.state.ui.hoverWorld = wloc;
    if (ch) APP.render();
  });
  boardEl.addEventListener('mouseleave', () => {
    APP.state.ui.hoverWorld = null;
    APP.render();
  });
}

function hotkeyPaletteIndexFromEvent(e) {
  if (!e.code || !e.code.startsWith('Digit')) return -1;
  const digit = e.code.slice(5);
  if (!/^\d$/.test(digit)) return -1;
  const base = digit === '0' ? 9 : parseInt(digit, 10) - 1;
  return base + (e.shiftKey ? 10 : 0);
}

function cycleBrush(reverse) {
  const pal = APP.state.level.palette;
  const cur = APP.state.ui.brush ? APP.state.ui.brush.kind : null;
  const idx = cur ? pal.indexOf(cur) : -1;
  const next = idx < 0 ? (reverse ? pal.length - 1 : 0)
    : (idx + (reverse ? pal.length - 1 : 1)) % pal.length;
  const kind = pal[next];
  APP.state.ui.brush = { kind, rotation: 0, params: defaultParams(kind) };
}

function attachUI() {
  document.getElementById('btn-reset').onclick = () => {
    resetSim(APP.state);
    setPlayIdle();
    APP.render();
  };
  document.getElementById('btn-play').onclick = () => togglePlay();
  document.getElementById('btn-rotate').onclick = () => {
    const h = APP.state.ui.hoverWorld;
    if (h) {
      const t = tileAtPoint(APP.state, h.x, h.y);
      if (t && KIND_META[t.kind]?.hasRotation) {
        withBoardEdit(APP.state, () => { rotateTile(APP.state, t.id); return true; });
        APP.render();
        return;
      }
    }
    if (APP.state.ui.brush && KIND_META[APP.state.ui.brush.kind]?.hasRotation) {
      APP.state.ui.brush.rotation = (APP.state.ui.brush.rotation + 1) % 4;
      APP.render();
    }
  };
  document.getElementById('btn-delete').onclick = () => {
    const h = APP.state.ui.hoverWorld;
    if (!h) return;
    const t = tileAtPoint(APP.state, h.x, h.y);
    if (t) {
      const tid = t.id;
      withBoardEdit(APP.state, () => deleteTile(APP.state, tid));
      if (APP.state.ui.inspectorTileId === tid) clearInspector();
    }
    APP.render();
  };
  document.getElementById('btn-clear').onclick = () => {
    withBoardEdit(APP.state, () => {
      for (const x of [...APP.state.tiles.values()]) deleteTile(APP.state, x.id);
      return true;
    });
    clearInspector();
    APP.render();
  };
  document.getElementById('btn-undo').onclick = () => { if (undoBoard(APP.state)) APP.render(); };
  document.getElementById('btn-redo').onclick = () => { if (redoBoard(APP.state)) APP.render(); };

  for (const b of document.querySelectorAll('.spd-btn')) {
    b.addEventListener('click', () => {
      const s = parseInt(b.dataset.speed, 10);
      APP.state.sim.speed = s;
      for (const x of document.querySelectorAll('.spd-btn')) x.classList.remove('active');
      b.classList.add('active');
      Storage.saveSpeed(s);
    });
  }

  document.addEventListener('mousedown', e => {
    if (APP) {
      // Include .sidebar (left + right): capture-phase runs before click; re-rendering
      // the palette here would replace DOM under the pointer and swallow palette clicks.
      const keepInspector = e.target.closest('.sidebar')
        || e.target.closest('[data-tile-id]')
        || e.target.closest('.topbar')
        || e.target.closest('.bottombar');
      if (!keepInspector) {
        clearInspector();
        APP.render();
      }
    }
  }, true);

  document.addEventListener('keydown', e => {
    if (!APP) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleBrush(e.shiftKey);
      APP.render();
      return;
    }
    const pi = hotkeyPaletteIndexFromEvent(e);
    if (pi >= 0) {
      const kind = APP.state.level.palette[pi];
      if (kind) {
        e.preventDefault();
        APP.state.ui.brush = { kind, rotation: 0, params: defaultParams(kind) };
        const hw = APP.state.ui.hoverWorld;
        if (hw && canPlaceTileCenter(APP.state, hw.x, hw.y, null)) {
          const b = APP.state.ui.brush;
          withBoardEdit(APP.state, () => !!placeTile(APP.state, b.kind, hw.x, hw.y, b.rotation, b.params));
        }
        APP.render();
      }
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      resetSim(APP.state);
      setPlayIdle();
      APP.render();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      document.getElementById('btn-clear').click();
      return;
    }
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (undoBoard(APP.state)) APP.render();
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      if (redoBoard(APP.state)) APP.render();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      bumpSpeed(1);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      bumpSpeed(-1);
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      document.getElementById('btn-rotate').click();
    }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      document.getElementById('btn-delete').click();
    }
  });
}

function bumpSpeed(dir) {
  const i = SPEED_STEPS.indexOf(APP.state.sim.speed);
  const ni = clamp((i < 0 ? 0 : i) + dir, 0, SPEED_STEPS.length - 1);
  APP.state.sim.speed = SPEED_STEPS[ni];
  for (const b of document.querySelectorAll('.spd-btn')) {
    b.classList.toggle('active', parseInt(b.dataset.speed, 10) === APP.state.sim.speed);
  }
  Storage.saveSpeed(APP.state.sim.speed);
}

function setPlayIdle() {
  const btn = document.getElementById('btn-play');
  if (btn) btn.textContent = '▶ play [space]';
}

function setPlayRunning() {
  const btn = document.getElementById('btn-play');
  if (btn) btn.textContent = 'pause [space]';
}

function togglePlay() {
  const sim = APP.state.sim;
  sim.running = !sim.running;
  if (sim.running) {
    setPlayRunning();
    sim.lastFrame = performance.now();
    const loop = now => {
      if (!APP || !APP.state.sim.running) return;
      const dt = Math.min(0.1, (now - APP.state.sim.lastFrame) / 1000);
      APP.state.sim.lastFrame = now;
      physicsAccumulate(APP.state, dt);
      APP.state.sim.fpsFrames++;
      if (APP.state.sim.fpsFrames >= 20) {
        APP.state.sim.fpsAvg = 1 / (dt || 0.016);
        APP.state.sim.fpsFrames = 0;
      }
      const anyGlow = [...APP.state.tiles.values()].some(x => x._interactGlow);
      if (anyGlow) renderBoardSvg(APP.state, document.getElementById('board'));
      renderParticlesCanvas(APP.state);
      renderHUD();
      renderGoals();
      sim.raf = requestAnimationFrame(loop);
    };
    sim.raf = requestAnimationFrame(loop);
  } else {
    if (sim.raf) cancelAnimationFrame(sim.raf);
    sim.raf = null;
    setPlayIdle();
    renderAll();
  }
}

function renderAll() {
  renderBoardSvg(APP.state, document.getElementById('board'));
  renderParticlesCanvas(APP.state);
  renderPalette();
  renderTileInspector();
  renderGoals();
  renderHUD();
  document.getElementById('btn-undo').disabled = APP.state.history.past.length === 0;
  document.getElementById('btn-redo').disabled = APP.state.history.future.length === 0;
}

function bootstrap() {
  const state = createState();
  const saved = Storage.getBoard();
  const meta = Storage.load();
  if (saved) applyBoardSnapshot(state, saved, !meta.posPx);
  const sp = Storage.getSpeed();
  if (SPEED_STEPS.includes(sp)) state.sim.speed = sp;
  APP = { state, render: renderAll };
  document.querySelectorAll('.spd-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.speed, 10) === state.sim.speed);
  });
  attachUI();
  if (!BOARD_INPUT_ATTACHED) {
    attachBoardInput(document.getElementById('board'));
    BOARD_INPUT_ATTACHED = true;
  }
  renderAll();
}

window.addEventListener('DOMContentLoaded', () => {
  bootstrap();
});
