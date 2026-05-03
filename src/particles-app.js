/**
 * MCE — Moebius Construction Environment (vanilla JS).
 * SVG equipment (free-placed tiles) + Canvas alphanumeric glyphs; fixed-timestep rAF physics.
 *
 * File layout (search for section headers):
 *   1. Sim & palette constants
 *   2. Particles (glyphs, energy, color)
 *   3. Level & tile definitions (kinds, params, meta, costs)
 *   4. Vectors, colliders, placement & gizmo math
 *   5. Tile lifecycle & board snapshots
 *   6. Physics (sources, forces, substep, accumulate)
 *   7. SVG + canvas rendering
 *   8. Persistence & undo history
 *   9. DOM UI (inspector, palette, stats)
 *  10. Board pointer input & global hotkeys
 *  11. App bootstrap
 */
'use strict';

/* =============================================================================
 *  1. Sim & palette constants
 * ============================================================================= */

const SPEED_STEPS = [0.1, 1, 10, 100];

/** Wall-clock scale for the fixed timestep (larger = faster sim). */
function simTimeScale(speed) {
  return SPEED_STEPS.includes(speed) ? speed : 1;
}

const COLOR_IDS = ['black', 'red', 'yellow', 'blue', 'green'];
const COLOR_HEX = {
  black: '#111111',
  red: '#cc2222',
  yellow: '#ccaa00',
  blue: '#2266cc',
  green: '#228844',
};

/** CSS `conic-gradient` stops for the five channels (used by random swatches). */
function colorWheelConicStopsCss() {
  const n = COLOR_IDS.length;
  return COLOR_IDS.map((c, i) => {
    const a0 = (i / n) * 360;
    const a1 = ((i + 1) / n) * 360;
    return `${COLOR_HEX[c]} ${a0}deg ${a1}deg`;
  }).join(', ');
}

/** Inspector swatch: full channel wheel for “random” spawn / assign. */
function styleSwatchRandomChannels(el) {
  el.style.background = `conic-gradient(${colorWheelConicStopsCss()})`;
}

const FIXED_DT = 1 / 120;
/**
 * VELOCITY builds a target speed scale from ∥/⊥ gains; without dt limiting, values near 0.9/1.1
 * compound ~120×/simulated second and feel extreme. This rate pulls actual scale toward that target per substep
 * (higher = snappier; ~3–4 is a workable play range vs imperceptible at ~1).
 */
const VELOCITY_TOWARD_TARGET_HZ = 3.35;
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
/** Remove particle when energy ≤ this fraction of its personal max (spawn value). */
const PARTICLE_ENERGY_REMOVE_FRAC = 0.012;

function drainParticleEnergy(p, amount) {
  if (p._dead || !(amount > 0)) return;
  const maxE = Math.max(1e-6, p.energyMax ?? p.energy ?? 1);
  if (!Number.isFinite(p.energy)) p.energy = maxE;
  p.energy -= amount;
  if (p.energy <= maxE * PARTICLE_ENERGY_REMOVE_FRAC) p._dead = true;
}

function applyTileEnergyDrain(tile, p) {
  if (!tile || tile.kind === 'SOURCE') return;
  const d = Number(tile.params.energyDrain);
  if (!(d > 0)) return;
  drainParticleEnergy(p, d);
}

function ensureParticleEnergyFields(p) {
  if (!Number.isFinite(p.energy) || !Number.isFinite(p.energyMax)) {
    p.energy = 100;
    p.energyMax = 100;
  }
}

const PARTICLE_GLYPH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomParticleGlyph() {
  const s = PARTICLE_GLYPH_ALPHABET;
  return s[(Math.random() * s.length) | 0];
}

function ensureParticleGlyph(p) {
  const g = p.glyph;
  if (typeof g !== 'string' || g.length !== 1 || !/[A-Z0-9]/i.test(g)) {
    p.glyph = randomParticleGlyph();
  } else {
    p.glyph = g.toUpperCase();
  }
}

function hexToRgba(hex, alpha) {
  const h = (hex || '#000').replace('#', '');
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const SANDBOX = {
  name: 'mce',
  gridW: 26,
  gridH: 18,
  cellPx: 36,
  palette: [
    'SOURCE', 'GOAL', 'VELOCITY', 'RECOLOR', 'ABSORBER', 'BUFFER',
    'REFLECTOR', 'MEMBRANE', 'DIFFUSER', 'SPLITTER', 'TELEPORT', 'RESONATOR', 'SWIRL',
  ],
};

/** Design-space tile art is authored in this square (px); scaled to `cellPx` on the board. */
const INNER_DESIGN_PX = 56;

/**
 * Half-extent as fraction of board `cp` for the outer `tile-frame` in drawTileG (`x/y = 3`,
 * `width/height = INNER − 6`), i.e. (INNER/2 − 3) / INNER. Matches glow + hitbox to that square.
 */
const COLLIDER_FRAME_HALF = (INNER_DESIGN_PX / 2 - 3) / INNER_DESIGN_PX;

/** Unity-style transform tools (toolbar + W/E/R). */
const TOOL_MODES = /** @type {const} */ (['move', 'rotate', 'scale']);

/** One palette / toolbar / legacy quarter-turn step. */
const ROTATION_QUARTER_TURN = Math.PI / 2;

/** Transform gizmo: move hull padding beyond tile hitbox (px per side). */
const GIZMO_MOVE_PADDING_PX = 18;
/** Rotate ring radius = max(hw,hh) + this (px). */
const GIZMO_ROTATE_RING_OUTSET_PX = 22;
/** Half-thickness of the rotate ring hit band (px); wide for “near” grabs. */
const GIZMO_ROTATE_HIT_HALF_THICK_PX = 34;
/** Scale line extends past bbox by this (px). */
const GIZMO_SCALE_LINE_OUTSET_PX = 32;
/** Half-width of the hit corridor along the scale line (px). */
const GIZMO_SCALE_HIT_HALF_WIDTH_PX = 30;
/** Ignore pointer very close to tile center on scale ray (px). */
const GIZMO_SCALE_HUB_MIN_PX = 10;
/** Visible knob radius at end of scale line (px). */
const GIZMO_SCALE_KNOB_R_PX = 14;
/** Extra invisible padding around knob for hits (px). */
const GIZMO_SCALE_KNOB_HIT_PAD_PX = 14;

function cellPx(state) {
  return state.level.cellPx;
}

function worldSize(state) {
  const { gridW, gridH, cellPx: cp } = state.level;
  return { w: gridW * cp, h: gridH * cp, cp };
}

/* =============================================================================
 *  4. Vectors, colliders, placement & gizmo math
 * ============================================================================= */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

function norm(x, y) {
  const L = hypot(x, y);
  return L < EPS ? [0, 0] : [x / L, y / L];
}

function dot(ax, ay, bx, by) {
  return ax * bx + ay * by;
}

const SCALE_MIN = 0.25;
const SCALE_MAX = 3;

/**
 * Collider shapes vs `drawTileG` (design cell `INNER_DESIGN_PX`):
 * fractions are of **board** `cp` — same ratios as author px / `INNER_DESIGN_PX` when art uses that cell.
 * Keep circle only where the ink is actually circular; otherwise use KIND_BOX to match strokes/frames.
 */
const KIND_CIRCLE = {
  /** Only true circular ink (concentric rings); outer ring r = 13 author px. */
  GOAL: { r: 13 / INNER_DESIGN_PX },
};

/** Box colliders in tile-local axes at rotationRad=0; hw, hh = half extents as fractions of cp. */
const KIND_BOX = {
  /** Central 20×20 chrome in author px. */
  SOURCE: { hw: 12 / INNER_DESIGN_PX, hh: 12 / INNER_DESIGN_PX },
  /** Same outer frame square as the sprite (`!compactChrome` branch). */
  DIFFUSER: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
  REFLECTOR: { hw: 0.48, hh: 0.09 },
  ABSORBER: { hw: 0.16, hh: 0.16 },
  SPLITTER: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
  /** Stroke rect ~26×16 centered (matches draw chrome). */
  RECOLOR: { hw: 13 / INNER_DESIGN_PX, hh: 8 / INNER_DESIGN_PX },
  VELOCITY: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
  SWIRL: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
  TELEPORT: { hw: 11 / INNER_DESIGN_PX, hh: 11 / INNER_DESIGN_PX },
  MEMBRANE: { hw: 0.08, hh: 0.48 },
  RESONATOR: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
  BUFFER: { hw: COLLIDER_FRAME_HALF, hh: COLLIDER_FRAME_HALF },
};

function tileShape(kind) {
  if (KIND_CIRCLE[kind]) return { kind: 'circle', r: KIND_CIRCLE[kind].r };
  if (KIND_BOX[kind]) return { kind: 'box', hw: KIND_BOX[kind].hw, hh: KIND_BOX[kind].hh };
  return { kind: 'box', hw: 0.495, hh: 0.495 };
}

function scaledShape(tileLike) {
  const k = tileLike.kind;
  const s = Number.isFinite(tileLike.scale) ? clamp(tileLike.scale, SCALE_MIN, SCALE_MAX) : 1;
  const sh = tileShape(k);
  return sh.kind === 'circle' ? { kind: 'circle', r: sh.r * s }
    : { kind: 'box', hw: sh.hw * s, hh: sh.hh * s };
}

function tileRotationRad(tile) {
  return Number.isFinite(tile.rotationRad) ? tile.rotationRad : 0;
}

function tileAxes(tile) {
  const th = tileRotationRad(tile);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return { fx: c, fy: s, rx: -s, ry: c };
}

/** World (wx,wy) → local (lx,ly): lx along forward, ly along right. */
function localFromWorld(tile, wx, wy) {
  const rx = wx - tile.x;
  const ry = wy - tile.y;
  const { fx, fy, rx: rxv, ry: ryv } = tileAxes(tile);
  const lx = rx * fx + ry * fy;
  const ly = rx * rxv + ry * ryv;
  return { lx, ly };
}

function localToWorldOffset(tile, lx, ly) {
  const { fx, fy, rx: rxv, ry: ryv } = tileAxes(tile);
  return { x: lx * fx + ly * rxv, y: lx * fy + ly * ryv };
}

function pointInTile(px, py, tile, cp) {
  const sh = scaledShape(tile);
  const dx = px - tile.x;
  const dy = py - tile.y;
  if (sh.kind === 'circle') {
    const rp = sh.r * cp + EPS;
    return dx * dx + dy * dy <= rp * rp;
  }
  const th = -tileRotationRad(tile);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= sh.hw * cp + EPS && Math.abs(ly) <= sh.hh * cp + EPS;
}

/** Conservative circle radius for placement overlap and board clamping. */
function boundingRadiusPx(tileLike, cp) {
  const sh = scaledShape(tileLike);
  if (sh.kind === 'circle') return sh.r * cp + EPS * 8;
  return hypot(sh.hw, sh.hh) * cp + EPS * 8;
}

function placementProbe(state, excludeId, placeKind) {
  if (excludeId != null) {
    const t = state.tiles.get(excludeId);
    return t || { kind: placeKind, scale: 1, rotationRad: 0 };
  }
  const b = state.ui.brush;
  const scale = b && b.kind === placeKind && Number.isFinite(b.scale)
    ? clamp(b.scale, SCALE_MIN, SCALE_MAX) : 1;
  return {
    kind: placeKind,
    scale,
    rotationRad: b?.rotationRad ?? 0,
  };
}

function tilesOverlapCenters(ax, ay, probeA, tileB, cp) {
  const ra = boundingRadiusPx(probeA, cp);
  const rb = boundingRadiusPx(tileB, cp);
  return hypot(ax - tileB.x, ay - tileB.y) < ra + rb - EPS * 4;
}

/** Topmost tile at a point: highest id wins (matches SVG paint order). */
function tileAtPoint(state, wx, wy) {
  const cp = cellPx(state);
  let best = null;
  for (const t of state.tiles.values()) {
    if (!pointInTile(wx, wy, t, cp)) continue;
    if (!best || t.id > best.id) best = t;
  }
  return best;
}

function clampTileCenter(state, x, y, probe) {
  const { w, h, cp } = worldSize(state);
  const margin = boundingRadiusPx(probe, cp);
  return [clamp(x, margin, w - margin), clamp(y, margin, h - margin)];
}

function overlapsAnyTile(state, cx, cy, excludeId, probe) {
  const cp = cellPx(state);
  for (const t of state.tiles.values()) {
    if (excludeId != null && t.id === excludeId) continue;
    if (tilesOverlapCenters(cx, cy, probe, t, cp)) return true;
  }
  return false;
}

/** Uniform random offset inside a disc of radius `r` (area-uniform). */
function randomDiscOffsetPx(r) {
  const u = Math.random();
  const v = Math.random();
  const rho = Math.sqrt(u) * r;
  const th = v * Math.PI * 2;
  return { x: Math.cos(th) * rho, y: Math.sin(th) * rho };
}

/** Returns { x, y } clamped world center, or null if overlapping another tile. */
function canPlaceTileCenter(state, wx, wy, excludeId, placeKind) {
  const probe = placementProbe(state, excludeId, placeKind);
  const [x, y] = clampTileCenter(state, wx, wy, probe);
  if (overlapsAnyTile(state, x, y, excludeId, probe)) return null;
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
      rate: 40,
      speedMin: 80,
      speedMax: 120,
      sprayDeg: 8,
      colorId: 'black',
      burst: 0.12,
      timingNoise: 0.22,
      /** 0 = unlimited emission; >0 = initial energy pool (depleted by speed² per spawn). */
      energyBudget: 0,
      /** Initial kinetic budget for each spawned dot (size/brightness scale to this max). */
      spawnParticleEnergy: 100,
      energyDrain: 0,
    },
    DIFFUSER: { spreadDeg: 22, spikeP: 0.09, spikeMul: 1.55, energyDrain: 0.28 },
    REFLECTOR: { scatterDeg: 4, scatterP: 0.72, energyDrain: 0.22 },
    ABSORBER: { absorbP: 0.35, absorbJitter: 0.18, energyDrain: 1.1 },
    GOAL: { filterColor: 'any', capacity: 0, captureP: 0.93, energyDrain: 0.16 },
    SPLITTER: { splitP: 1, childSpeed: 0.72, splitAngleDeg: 30, angleJitterDeg: 3, energyDrain: 0.42 },
    RECOLOR: { recolorRate: 6, skipP: 0.06, assignColorId: 'red', energyDrain: 0.18 },
    VELOCITY: { parallelGain: 1.05, tangentialGain: 1, engageP: 0.88, energyDrain: 0.28 },
    SWIRL: { omega: 520, decay: 1.25, omegaJitter: 0.14, energyDrain: 0.22 },
    TELEPORT: { linkId: 0, malfunctionP: 0, coneDeg: 12, exitJitterDeg: 4, energyDrain: 0.35 },
    MEMBRANE: { leakP: 0.08, wobbleP: 0.06, energyDrain: 0.26 },
    RESONATOR: { amplitude: 540, freq: 4.2, ampJitter: 0.14, energyDrain: 0.26 },
    BUFFER: { maxK: 40, releaseRate: 18, burstOnFull: 1, slipP: 0.022, energyDrain: 0.32 },
  };
  return Object.assign({}, p[kind] || {});
}

/** Default placement rotation (radians): horizontal local ink reads vertical on the board. */
function defaultBrushRotationRad(kind) {
  if (kind === 'REFLECTOR') return ROTATION_QUARTER_TURN;
  return 0;
}

function makeDefaultBrush(kind) {
  return { kind, rotationRad: defaultBrushRotationRad(kind), scale: 1, params: defaultParams(kind) };
}

/** Labels only; every kind supports move / rotate / scale (same hitbox + draw path as the board). */
const KIND_META = {
  SOURCE: { label: 'SRC' },
  DIFFUSER: { label: 'DIF' },
  REFLECTOR: { label: 'REF' },
  ABSORBER: { label: 'ABS' },
  GOAL: { label: 'GOAL' },
  SPLITTER: { label: 'SPL' },
  RECOLOR: { label: 'CLR' },
  VELOCITY: { label: 'VEL' },
  SWIRL: { label: 'VOR' },
  TELEPORT: { label: 'TEL' },
  MEMBRANE: { label: 'SLT' },
  RESONATOR: { label: 'RSN' },
  BUFFER: { label: 'BUF' },
};

/**
 * Player-facing: what the tile is for in a build, and the main rule for how it acts.
 * Used at the top of each palette row and in the kind-details panel.
 */
const KIND_PLAYER_HELP = {
  SOURCE:
    'Adds particles. Fires on a timer into the aim direction; tune rate, spray, speeds, color, and optional total spawn budget.',
  DIFFUSER:
    'Adds noise. On each crossing it re-rolls exit angle inside a cone; rarely throws a much wider “spike” turn.',
  REFLECTOR:
    'Redirects motion. Mostly a tight bounce off the face, but sometimes applies a wider random scatter instead.',
  ABSORBER:
    'Deletes particles by attrition. Every tick inside it shaves energy by chance; at zero energy the particle is removed.',
  GOAL:
    'Scores catches. Grabs particles that match its color filter (or any); optional capacity caps how many count.',
  SPLITTER:
    'Multiplies flow. On a hit, can duplicate into two slower children aimed symmetrically ±split angle from the tile forward axis (default ±30°), plus small jitter.',
  RECOLOR:
    'Sets channel. While overlapping, periodically assigns the chosen particle color (or a random channel when set to random).',
  VELOCITY:
    'Tunes speed only (bearing unchanged). ∥ and ⊥ gains set a target scale from your motion mix; the sim eases |v| toward that target each tick so extremes do not compound instantly, but strong gains still read clearly.',
  SWIRL:
    'Curves paths. Applies twist around the tile while inside; strength falls off with distance from the center.',
  TELEPORT:
    'Moves position. Match link IDs in pairs; entering one exits the other aiming within a cone (can misfire).',
  MEMBRANE:
    'Leaky wall. Mostly blocks, but some crossings leak straight through or wobble along the slit instead of reflecting.',
  RESONATOR:
    'Pumps rhythm. While in range, adds an in/out radial shove that oscillates—timing matters for how you cross.',
  BUFFER:
    'Queues particles. Holds up to maxK inside the tile, then releases at a set rate (optional burst when full).',
};

/** Tile-inspector control explanations (hover the ⓘ next to each label). */
const INSPECTOR_PARAM_HINTS = {
  ALL: {
    energyDrain:
      'Each tick while a particle overlaps this tile, this much energy is removed. At zero energy the particle is deleted. SOURCE tiles do not use this.',
  },
  SOURCE: {
    rate: 'How many particles this source tries to spawn per second on average (timing noise still jitters the clock).',
    speedMin: 'Minimum launch speed for new particles (simulation units per second).',
    speedMax: 'Maximum launch speed; each spawn picks uniformly between min and max.',
    sprayDeg: 'Half-angle of the spray cone: new velocity is aimed at a random bearing within ±this many degrees of the tile forward axis.',
    timingNoise: 'Randomizes when the next spawn fires so identical sources do not pulse in perfect sync.',
    burst: 'Adds a slow wandering offset to aim between spawns so the stream gently steers over time.',
    energyBudget: 'Total energy budget for spawning; at 0 the source never runs out. When spent, this source stops creating particles.',
    spawnParticleEnergy: 'Energy each newborn particle starts with (affects how long it survives under drain elsewhere).',
    spawnColor: 'Color channel for new particles; “random” picks a channel per spawn. Used by goals and filters.',
  },
  DIFFUSER: {
    spreadDeg: 'Half-width of the cone used to re-roll direction when a particle crosses.',
    spikeP: 'Chance to use a much wider one-off angle instead of the normal cone—spiky exits.',
  },
  REFLECTOR: {
    scatterP: 'Each bounce, probability to use a wide random scatter instead of a near-specular reflection.',
    scatterDeg: 'When scatter triggers, how wide the random deflection can be (degrees).',
  },
  ABSORBER: {
    absorbP: 'Per tick while overlapping, chance to apply an energy bite scaled by the sim timestep.',
    absorbJitter: 'Randomizes absorb strength so identical particles do not decay identically.',
  },
  GOAL: {
    captureP: 'Per tick while overlapping a matching particle, chance to register a catch toward this goal’s score.',
    capacity: 'Maximum catches this goal will count; 0 means unlimited.',
    catchFilter: 'Which particle color counts as a catch; “any” accepts all channels.',
  },
  SPLITTER: {
    splitP: 'On interaction, chance to duplicate the particle into an extra child.',
    childSpeed: 'Speed multiplier applied to the child particle relative to the parent.',
    splitAngleDeg: 'Each child is aimed this many degrees away from the forward axis on opposite sides (+ and −), following tile rotation.',
    angleJitterDeg: 'Random ±degrees added to each child’s exit direction after the split angle.',
  },
  RECOLOR: {
    recolorRate: 'How often (per second) this tile tries to assign its output color to overlapping particles.',
    skipP: 'Chance each tick to skip recoloring so streams do not strobe every frame.',
    assignColorId: 'Particle color to apply: a fixed channel or “random” for a random channel each time it fires.',
  },
  VELOCITY: {
    parallelGain: 'Target scale for motion along the aim axis. Combined with ⊥ gain; |v| moves toward that target each substep without instant runaway.',
    tangentialGain: 'Target scale for motion across the aim. Weighted with ∥ by speed components; direction stays fixed while speed scales.',
    engageP: 'Per substep, chance to apply one easing step toward the target speed scale.',
  },
  SWIRL: {
    omega: 'Angular “spin” strength applied to velocity while inside (higher = tighter curving).',
    decay: 'How quickly swirl influence falls off with distance from the tile center.',
    omegaJitter: 'Randomizes effective spin strength tick to tick.',
  },
  TELEPORT: {
    linkId: 'Portals with the same link id are paired; exiting one sends you to the other.',
    malfunctionP: 'Chance a teleport attempt fails and the particle is not moved.',
    coneDeg: 'After a successful teleport, new aim is picked uniformly within this half-cone around the exit forward axis.',
    exitJitterDeg: 'Extra small random angle added on top of the cone draw.',
  },
  MEMBRANE: {
    leakP: 'Chance per crossing that the particle slips straight through instead of interacting with the barrier.',
    wobbleP: 'Chance to skim along the membrane with a perturbed path instead of a clean reflect or leak.',
  },
  RESONATOR: {
    amplitude: 'Peak strength of the oscillating radial push/pull while particles are in range.',
    freq: 'Oscillation frequency in Hz-ish units—how fast the shove reverses.',
    ampJitter: 'Randomizes amplitude per tick so the wave is not perfectly periodic.',
  },
  BUFFER: {
    maxK: 'Maximum number of particles this buffer can hold at once.',
    releaseRate: 'How many buffered particles per second are released back to the board on average.',
    slipP: 'Chance an incoming particle bypasses the buffer instead of entering the queue.',
    burstOnFull: 'Non-zero enables an extra release burst when the buffer hits max hold; 0 uses steady release only.',
  },
};

function inspHint(kind, key) {
  const m = INSPECTOR_PARAM_HINTS[kind];
  if (m && m[key]) return m[key];
  return INSPECTOR_PARAM_HINTS.ALL[key] || '';
}

/** Run counters (since last particle reset) most relevant to each kind. */
const KIND_RUN_ROWS = {
  SOURCE: [['spawns', 'spawnSource']],
  BUFFER: [['buffer in', 'bufferIn'], ['buffer out', 'bufferOut']],
  GOAL: [['goal catch', 'goalCatch']],
  SPLITTER: [['split births', 'splitBirths']],
  TELEPORT: [['teleports', 'teleports']],
  ABSORBER: [['absorbed', 'absorber']],
  REFLECTOR: [['reflect hits', 'reflectorHit']],
};

/** Nominal material cost per tile kind (Zachtronics-style “optimize cost”). */
const TILE_MATERIAL_COST = {
  SOURCE: 42,
  DIFFUSER: 16,
  REFLECTOR: 12,
  ABSORBER: 11,
  GOAL: 24,
  SPLITTER: 22,
  RECOLOR: 13,
  VELOCITY: 15,
  SWIRL: 18,
  TELEPORT: 26,
  MEMBRANE: 14,
  RESONATOR: 20,
  BUFFER: 28,
};

/* ---------- State ---------- */

function emptyRunStats() {
  return {
    spawnSource: 0,
    bufferIn: 0,
    bufferOut: 0,
    splitBirths: 0,
    teleports: 0,
    absorber: 0,
    goalCatch: 0,
    reflectorHit: 0,
    edgeCull: 0,
  };
}

function createState() {
  const level = SANDBOX;
  return {
    level,
    tiles: new Map(),
    nextTileId: 1,
    particles: [],
    nextParticleId: 1,
    /** Cumulative interaction counts since last reset particles (q). */
    runStats: emptyRunStats(),
    sim: {
      running: false,
      time: 0,
      speed: 1,
      accumulator: 0,
      raf: null,
      lastFrame: 0,
      fpsAvg: 0,
      fpsFrames: 0,
      /** Physics substeps executed in the most recent `physicsAccumulate` call. */
      substepsLastFrame: 0,
    },
    ui: {
      brush: null,
      inspectorTileId: null,
      /** Unity-style: move | rotate | scale */
      tool: 'move',
      /** Optional label during gizmo drag `{ text, x, y }` world px. */
      gizmoHud: null,
      /** Pointer position in board SVG coords (pixels), or null. */
      hoverWorld: null,
    },
    history: { past: [], future: [] },
  };
}

/** Persisted boards may use retired kind names; normalize before sim / palette. */
function migrateTileKind(kind) {
  if (kind === 'SPEED_GATE') return 'VELOCITY';
  return kind;
}

function placeTile(state, kind, wx, wy, rotationRad, scale, params) {
  kind = migrateTileKind(kind);
  const ok = canPlaceTileCenter(state, wx, wy, null, kind);
  if (!ok) return null;
  const tile = {
    id: state.nextTileId++,
    kind,
    x: ok.x,
    y: ok.y,
    rotationRad: Number.isFinite(rotationRad) ? rotationRad : 0,
    scale: Number.isFinite(scale) ? clamp(scale, SCALE_MIN, SCALE_MAX) : 1,
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

/** Snap rotate +90° (legacy toolbar / right-click). */
function rotateTile(state, tileId) {
  const tile = state.tiles.get(tileId);
  if (!tile) return;
  tile.rotationRad = tileRotationRad(tile) + ROTATION_QUARTER_TURN;
}

function rotationRadFromSnapshot(ent) {
  if (Number.isFinite(ent.rotationRad)) return ent.rotationRad;
  if (Number.isFinite(ent.rotation)) return (ent.rotation | 0) * ROTATION_QUARTER_TURN;
  return 0;
}

function scaleFromSnapshot(ent) {
  const s = ent.scale;
  return Number.isFinite(s) ? clamp(s, SCALE_MIN, SCALE_MAX) : 1;
}

function snapshotBoard(state) {
  return [...state.tiles.values()]
    .sort((a, b) => a.id - b.id)
    .map(t => ({
      kind: t.kind,
      x: t.x,
      y: t.y,
      rotationRad: t.rotationRad ?? 0,
      scale: t.scale ?? 1,
      params: { ...t.params },
    }));
}

function sameBoardSnapshot(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.kind === y.kind && x.x === y.x && x.y === y.y
      && (x.rotationRad ?? 0) === (y.rotationRad ?? 0) && (x.scale ?? 1) === (y.scale ?? 1)
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
    const pl = placeTile(
      state, ent.kind, wx, wy,
      rotationRadFromSnapshot(ent),
      scaleFromSnapshot(ent),
      ent.params,
    );
    if (!pl) console.error('[mce] Skipped invalid tile from snapshot', ent);
  }
}

function resetSim(state) {
  state.particles = [];
  state.nextParticleId = 1;
  state.sim.time = 0;
  state.sim.accumulator = 0;
  state.runStats = emptyRunStats();
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

/** Particles despawn when center leaves the board (no wall reflection). */
function cullParticlesOutside(state, p) {
  const { w, h } = worldSize(state);
  if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
    p._dead = true;
    state.runStats.edgeCull++;
    return true;
  }
  return false;
}

/** Reflect velocity across mirror line; tangent = tile forward axis. */
function reflectMirror(vx, vy, tile) {
  const { fx, fy } = tileAxes(tile);
  const dp = dot(vx, vy, fx, fy);
  const vpx = dp * fx;
  const vpy = dp * fy;
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
    const mean = tileRotationRad(t);
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
      const rawC = pr.colorId;
      const cid = rawC === 'random' ? randomColorId() : (rawC in COLOR_HEX ? rawC : 'black');
      const sh = scaledShape(t);
      const spawnR = (sh.kind === 'circle' ? sh.r : hypot(sh.hw, sh.hh)) * cp * 0.92;
      const { x: jx, y: jy } = randomDiscOffsetPx(spawnR);
      const spawnE = clamp(Number(pr.spawnParticleEnergy) || 100, 1, 1e5);
      state.particles.push({
        id: state.nextParticleId++,
        x: cx + jx,
        y: cy + jy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        colorId: cid,
        lastTileId: t.id,
        energy: spawnE,
        energyMax: spawnE,
        glyph: randomParticleGlyph(),
      });
      state.runStats.spawnSource++;
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

/** Tile hit flash fill: raw `black` matches tile ink so use a visible grey; chromatic colors read as-is. */
function interactGlowDisplayHex(colorId) {
  if (!colorId || colorId === 'black') return '#888888';
  return COLOR_HEX[colorId] || '#888888';
}

/**
 * Hit-flash in **board/world pixels**: same `scaledShape` + `tileAxes` as `pointInTile` (no author-space
 * or `innerPx` mapping), so size, shape, and orientation match the collider exactly.
 */
function appendInteractGlowWorld(layer, tile, cp, hex, opacityStr) {
  const sh = scaledShape(tile);
  const common = {
    class: 'tile-interact-glow',
    fill: hex,
    opacity: opacityStr,
    'pointer-events': 'none',
  };
  if (sh.kind === 'circle') {
    const r = sh.r * cp;
    layer.appendChild(svg('circle', {
      ...common,
      cx: tile.x,
      cy: tile.y,
      r: Math.max(0.05, r),
    }));
    return;
  }
  const hw = sh.hw * cp;
  const hh = sh.hh * cp;
  const { fx, fy, rx: rxv, ry: ryv } = tileAxes(tile);
  const cx = tile.x;
  const cy = tile.y;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const pts = corners.map(([lx, ly]) => {
    const wx = cx + lx * fx + ly * rxv;
    const wy = cy + lx * fy + ly * ryv;
    return `${wx},${wy}`;
  }).join(' ');
  layer.appendChild(svg('polygon', { ...common, points: pts }));
}

function decayTileInteractGlows(state, dt) {
  const k = Math.exp(-dt / INTERACT_GLOW_DECAY_S);
  for (const t of state.tiles.values()) {
    if (!t._interactGlow) continue;
    t._interactGlow.level *= k;
    if (t._interactGlow.level < 0.006) delete t._interactGlow;
  }
}

function applyCellForces(state, p, dt, tile, cp) {
  const tcx = tile.x;
  const tcy = tile.y;
  const rx = p.x - tcx;
  const ry = p.y - tcy;
  const k = tile.kind;

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
  if (k === 'VELOCITY') {
    if (Math.random() > clamp(tile.params.engageP ?? 0.88, 0.35, 0.999)) return;
    const ax = tileAxes(tile);
    const [nx, ny] = norm(ax.fx, ax.fy);
    const para = dot(p.vx, p.vy, nx, ny);
    const vpx = para * nx;
    const vpy = para * ny;
    const vxperp = p.vx - vpx;
    const vyperp = p.vy - vpy;
    const spd = hypot(p.vx, p.vy);
    if (spd < EPS) return;
    const paraMag = Math.abs(para);
    const perpLen = hypot(vxperp, vyperp);
    const j = 0.04;
    const pg = (tile.params.parallelGain ?? 1.05) * (1 + (Math.random() * 2 - 1) * j);
    const tg = (tile.params.tangentialGain ?? 1) * (1 + (Math.random() * 2 - 1) * j);
    const rawTarget = (paraMag * pg + perpLen * tg) / spd;
    const alpha = 1 - Math.exp(-VELOCITY_TOWARD_TARGET_HZ * dt);
    const blend = 1 + (rawTarget - 1) * alpha;
    p.vx *= blend;
    p.vy *= blend;
    return;
  }
  if (k === 'SWIRL') {
    const R = hypot(rx, ry) + EPS;
    const oj = clamp(tile.params.omegaJitter ?? 0.14, 0, 0.45);
    const om = ((tile.params.omega ?? 520) / R) * (1 + (Math.random() * 2 - 1) * oj);
    const dec = Math.exp(-R * (tile.params.decay ?? 1.25) / cp);
    p.vx += -ry * om * dec * dt;
    p.vy += rx * om * dec * dt;
    return;
  }
  if (k === 'MEMBRANE') {
    const ax = tileAxes(tile);
    const [nx, ny] = norm(ax.fx, ax.fy);
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
    const A = (tile.params.amplitude ?? 540) * (0.86 + 0.28 * Math.random());
    const f = tile.params.freq ?? 4.2;
    const ph = state.sim.time * f * Math.PI * 2;
    const kick = A * Math.sin(ph + (Math.random() * 2 - 1) * aj) * dt;
    p.vx += px * kick;
    p.vy += py * kick;
    return;
  }
  if (k === 'RECOLOR') {
    if (Math.random() < clamp(tile.params.skipP ?? 0.06, 0, 0.35)) return;
    const rr = (tile.params.recolorRate || 4) * dt * (0.85 + 0.3 * Math.random());
    if (Math.random() < rr) {
      const ac = tile.params.assignColorId ?? 'red';
      p.colorId = ac === 'random' ? randomColorId() : (ac in COLOR_HEX ? ac : 'red');
    }
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
        const ang = tileRotationRad(t) + (Math.random() * 0.2 - 0.1);
        const sp = hypot(b.vx, b.vy) || 80;
        const em = b.energyMax != null ? b.energyMax : (b.energy != null ? b.energy : 100);
        const e0 = b.energy != null ? b.energy : em;
        state.particles.push({
          id: state.nextParticleId++,
          x: t.x,
          y: t.y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          colorId: b.colorId,
          lastTileId: t.id,
          energy: e0,
          energyMax: em,
          glyph: b.glyph || randomParticleGlyph(),
        });
        state.runStats.bufferOut++;
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
        const ang = tileRotationRad(t) + (Math.random() * 2 - 1) * 0.18;
        const sp = hypot(b.vx, b.vy) || 80;
        const em = b.energyMax != null ? b.energyMax : (b.energy != null ? b.energy : 100);
        const e0 = b.energy != null ? b.energy : em;
        state.particles.push({
          id: state.nextParticleId++,
          x: t.x + (Math.random() - 0.5) * cp * 0.05,
          y: t.y + (Math.random() - 0.5) * cp * 0.05,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          colorId: b.colorId,
          lastTileId: t.id,
          energy: e0,
          energyMax: em,
          glyph: b.glyph || randomParticleGlyph(),
        });
        state.runStats.bufferOut++;
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
    ensureParticleEnergyFields(p);
    ensureParticleGlyph(p);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (cullParticlesOutside(state, p)) continue;

    const t = tileAtPoint(state, p.x, p.y);
    const tid = t ? t.id : null;
    const entered = p.lastTileId === undefined || p.lastTileId !== tid;
    let skipForces = false;

    if (!t) {
      p.lastTileId = null;
      out.push(p);
      continue;
    }

    applyTileEnergyDrain(t, p);
    if (p._dead) continue;

    if (t.kind === 'BUFFER') {
      const buf = t._buf || (t._buf = []);
      const maxK = Math.max(1, t.params.maxK | 0);
      if (buf.length < maxK) {
        const slip = clamp(t.params.slipP ?? 0.022, 0, 0.22);
        if (Math.random() >= slip) {
          buf.push({
            vx: p.vx, vy: p.vy, colorId: p.colorId,
            energy: p.energy, energyMax: p.energyMax ?? p.energy,
            glyph: p.glyph,
          });
          state.runStats.bufferIn++;
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
      ensureParticleGlyph(p);
      bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
      const f = t.params.childSpeed || 0.72;
      const sp0 = hypot(p.vx, p.vy) * f;
      const sp1 = hypot(p.vx, p.vy) * f;
      const jit = ((t.params.angleJitterDeg ?? 3) * Math.PI) / 180;
      const half = ((t.params.splitAngleDeg ?? 30) * Math.PI) / 180;
      const ax = tileAxes(t);
      const base = Math.atan2(ax.fy, ax.fx);
      const a0 = base + half + (Math.random() * 2 - 1) * jit;
      const a1 = base - half + (Math.random() * 2 - 1) * jit;
      const em = p.energyMax ?? p.energy ?? 100;
      const floorE = em * PARTICLE_ENERGY_REMOVE_FRAC;
      const e0 = Math.max(0, (p.energy ?? em) * 0.46);
      const e1 = Math.max(0, (p.energy ?? em) * 0.46);
      const gSplit = p.glyph;
      if (e0 > floorE) {
        splits.push({
          id: state.nextParticleId++,
          x: p.x, y: p.y,
          vx: Math.cos(a0) * sp0, vy: Math.sin(a0) * sp0,
          colorId: p.colorId, lastTileId: tid,
          energy: e0, energyMax: em,
          glyph: gSplit,
        });
        state.runStats.splitBirths++;
      }
      if (e1 > floorE) {
        splits.push({
          id: state.nextParticleId++,
          x: p.x, y: p.y,
          vx: Math.cos(a1) * sp1, vy: Math.sin(a1) * sp1,
          colorId: p.colorId, lastTileId: tid,
          energy: e1, energyMax: em,
          glyph: gSplit,
        });
        state.runStats.splitBirths++;
      }
      continue;
    }

    if (t.kind === 'TELEPORT' && entered) {
      const partner = telePairs.get(t.id);
      if (partner && Math.random() > clamp(t.params.malfunctionP || 0, 0, 1)) {
        state.runStats.teleports++;
        bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
        bumpTileInteractGlow(partner, p.colorId, INTERACT_GLOW_DISCRETE * 0.85);
        const pcx = partner.x;
        const pcy = partner.y;
        const shP = scaledShape(partner);
        const spawnR = (shP.kind === 'circle' ? shP.r : Math.max(shP.hw, shP.hh)) * cp * 0.88;
        const off = randomDiscOffsetPx(spawnR);
        p.x = pcx + off.x;
        p.y = pcy + off.y;
        const cone = ((t.params.coneDeg || 10) * Math.PI) / 180;
        const ej = ((t.params.exitJitterDeg ?? 4) * Math.PI) / 180;
        const base = tileRotationRad(partner);
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
        state.runStats.absorber++;
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
        state.runStats.goalCatch++;
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
      state.runStats.reflectorHit++;
      bumpTileInteractGlow(t, p.colorId, INTERACT_GLOW_DISCRETE);
      const [rx, ry] = reflectMirror(p.vx, p.vy, t);
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
  const mult = simTimeScale(state.sim.speed);
  state.sim.accumulator += realDt * mult;
  const telePairs = buildTeleportPartners(state);
  let steps = 0;
  while (state.sim.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    state.sim.accumulator -= FIXED_DT;
    state.sim.time += FIXED_DT;
    subStep(state, FIXED_DT, telePairs);
    steps++;
  }
  state.sim.substepsLastFrame = steps;
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

function drawArrow(tipX, tipY, cx, cy, klass) {
  const sz = 5;
  return svg('polygon', {
    points: `${tipX},${tipY} ${tipX - sz - 1},${tipY - sz} ${tipX - sz - 1},${tipY + sz}`,
    class: klass,
  });
}

/** Pie wedges for “random channel” in SOURCE / RECOLOR tile glyphs. */
function appendSvgColorWheelDisc(parent, cx, cy, r) {
  const n = COLOR_IDS.length;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    parent.appendChild(svg('path', {
      d: `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`,
      fill: COLOR_HEX[COLOR_IDS[i]],
      stroke: '#111',
      'stroke-width': 0.35,
    }));
  }
}

/** Keep short palette label upright while the tile body rotates (REF, SLT / membrane). */
function appendLabelUpright(g, tile, cx, labY, labelC, fontSize, lab) {
  const deg = -((tile.rotationRad ?? 0) * 180) / Math.PI;
  const wrap = svg('g', { transform: `rotate(${deg} ${cx} ${labY})` });
  wrap.appendChild(svg('text', { x: cx, y: labY, class: labelC, 'font-size': String(fontSize) }, lab));
  g.appendChild(wrap);
}

function drawTileG(tile, ghost) {
  const root = svg('g', null);
  const cp = INNER_DESIGN_PX;
  const cx = cp / 2;
  const cy = cp / 2;
  const frameC = ghost ? 'ghost-frame' : 'tile-frame';
  const arrowC = ghost ? 'ghost-arrow' : 'tile-arrow';
  const labelC = ghost ? 'tile-label ghost-label' : 'tile-label';
  const g = svg('g', null);
  const compactChrome = tile.kind === 'SOURCE' || tile.kind === 'REFLECTOR' || tile.kind === 'MEMBRANE'
    || tile.kind === 'ABSORBER' || tile.kind === 'GOAL'
    || tile.kind === 'RECOLOR' || tile.kind === 'TELEPORT';
  if (!compactChrome) {
    g.appendChild(svg('rect', { x: 3, y: 3, width: cp - 6, height: cp - 6, class: frameC }));
  }

  const meta = KIND_META[tile.kind];
  const lab = meta ? meta.label : tile.kind;

  const tip = cp / 2 - 3;

  if (tile.kind === 'SOURCE') {
    const raw = tile.params.colorId;
    g.appendChild(svg('rect', { x: cx - 12, y: cy - 12, width: 24, height: 24, class: frameC, rx: 2 }));
    if (raw === 'random') {
      const wg = svg('g', null);
      appendSvgColorWheelDisc(wg, cx, cy, 7.5);
      g.appendChild(wg);
    } else {
      const key = raw in COLOR_HEX ? raw : 'black';
      g.appendChild(svg('circle', { cx, cy, r: 7.8, fill: COLOR_HEX[key], stroke: '#000', 'stroke-width': 1 }));
    }
    g.appendChild(drawArrow(cx + 13, cy, cx, cy, arrowC));
    g.appendChild(svg('text', { x: cx, y: cy + 19, class: labelC, 'font-size': '11' }, lab));
  } else if (tile.kind === 'DIFFUSER') {
    for (let i = -1; i <= 1; i++) {
      g.appendChild(svg('line', {
        x1: cx - 14, y1: cy + i * 5, x2: cx + 14, y2: cy + i * 5 + (i === 0 ? 0 : 4 * (i > 0 ? -1 : 1)),
        class: 'tile-stroke',
      }));
    }
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'REFLECTOR') {
    g.appendChild(svg('line', {
      x1: cx - 25, y1: cy, x2: cx + 25, y2: cy,
      class: 'tile-stroke',
      'stroke-width': 2.5,
    }));
    appendLabelUpright(g, tile, cx, cy + 18, labelC, 8, lab);
  } else if (tile.kind === 'ABSORBER') {
    g.appendChild(svg('rect', { x: cx - 8, y: cy - 8, width: 16, height: 16, class: 'tile-stroke', 'stroke-dasharray': '2 2' }));
    g.appendChild(svg('text', { x: cx, y: cy + 3, class: labelC, 'font-size': '9' }, lab));
  } else if (tile.kind === 'GOAL') {
    g.appendChild(svg('circle', { cx, cy, r: 13, class: 'tile-stroke' }));
    g.appendChild(svg('circle', { cx, cy, r: 5.5, class: 'tile-stroke' }));
    g.appendChild(svg('text', { x: cx, y: cy + 20, class: labelC, 'font-size': '11' }, lab));
  } else if (tile.kind === 'SPLITTER') {
    const L = 16;
    const sr = ((tile.params.splitAngleDeg ?? 30) * Math.PI) / 180;
    const xu = L * Math.cos(sr);
    const yu = L * Math.sin(sr);
    g.appendChild(svg('path', {
      d: `M ${cx} ${cy} L ${cx + xu} ${cy - yu} M ${cx} ${cy} L ${cx + xu} ${cy + yu}`,
      class: 'tile-stroke',
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'RECOLOR') {
    g.appendChild(svg('rect', { x: cx - 13, y: cy - 8, width: 26, height: 16, class: 'tile-stroke' }));
    const ac = tile.params.assignColorId ?? 'red';
    if (ac === 'random') {
      const wg = svg('g', null);
      appendSvgColorWheelDisc(wg, cx, cy - 0.5, 6.2);
      g.appendChild(wg);
    } else {
      const key = ac in COLOR_HEX ? ac : 'red';
      g.appendChild(svg('rect', {
        x: cx - 9.5, y: cy - 5, width: 19, height: 10, fill: COLOR_HEX[key], stroke: '#111', 'stroke-width': 0.5,
      }));
    }
    g.appendChild(svg('text', { x: cx, y: cy + 19, class: labelC, 'font-size': '11' }, lab));
  } else if (tile.kind === 'VELOCITY') {
    g.appendChild(svg('polygon', {
      points: `${cx - 12},${cy + 8} ${cx + 12},${cy + 8} ${cx},${cy - 10}`,
      class: 'tile-stroke',
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 20, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'SWIRL') {
    g.appendChild(svg('path', {
      d: `M ${cx + 10} ${cy} A 10 10 0 1 1 ${cx} ${cy - 10}`,
      class: 'tile-stroke', fill: 'none',
    }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'TELEPORT') {
    g.appendChild(svg('rect', { x: cx - 11, y: cy - 11, width: 22, height: 22, class: 'tile-stroke', rx: 2 }));
    g.appendChild(svg('text', { x: cx, y: cy + 1, class: labelC, 'font-size': '12' }, String(tile.params.linkId | 0)));
    g.appendChild(svg('text', { x: cx, y: cy + 16, class: labelC, 'font-size': '11' }, lab));
  } else if (tile.kind === 'MEMBRANE') {
    g.appendChild(svg('line', {
      x1: cx, y1: 5, x2: cx, y2: cp - 5,
      class: 'tile-stroke',
      'stroke-width': 2.5,
    }));
    g.appendChild(drawArrow(cx + tip - 6, cy, cx, cy, arrowC));
    appendLabelUpright(g, tile, cx, cy + 18, labelC, 8, lab);
  } else if (tile.kind === 'RESONATOR') {
    g.appendChild(svg('path', { d: `M ${cx - 12} ${cy} Q ${cx} ${cy - 14} ${cx + 12} ${cy}`, class: 'tile-stroke', fill: 'none' }));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else if (tile.kind === 'BUFFER') {
    g.appendChild(svg('rect', { x: cx - 12, y: cy - 10, width: 24, height: 20, class: 'tile-stroke' }));
    g.appendChild(drawArrow(cx + tip - 4, cy, cx, cy, arrowC));
    g.appendChild(svg('text', { x: cx, y: cy + 18, class: labelC, 'font-size': '8' }, lab));
  } else {
    g.appendChild(svg('rect', { x: 3, y: 3, width: cp - 6, height: cp - 6, class: frameC }));
    g.appendChild(svg('text', { x: cx, y: cy, class: labelC, 'font-size': '9' }, lab));
  }

  root.appendChild(g);
  return root;
}

function svgClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function gizmoExtents(tile, cp) {
  const sh = scaledShape(tile);
  if (sh.kind === 'circle') return { hw: sh.r * cp, hh: sh.r * cp };
  return { hw: sh.hw * cp, hh: sh.hh * cp };
}

/** Inflated half-extents for move affordance (larger than sprite footprint). */
function gizmoMoveHalfExtents(tile, cp) {
  const { hw, hh } = gizmoExtents(tile, cp);
  const p = GIZMO_MOVE_PADDING_PX;
  return { hw: hw + p, hh: hh + p };
}

function gizmoRotateRingRadius(tile, cp) {
  const { hw, hh } = gizmoExtents(tile, cp);
  return Math.max(hw, hh) + GIZMO_ROTATE_RING_OUTSET_PX;
}

function gizmoScaleLineLength(tile, cp) {
  const { hw, hh } = gizmoExtents(tile, cp);
  return Math.max(hw, hh) + GIZMO_SCALE_LINE_OUTSET_PX;
}

/** Pointer inside inflated move OBB (world px). */
function hitTestMoveNear(wx, wy, tile, cp) {
  const { hw, hh } = gizmoMoveHalfExtents(tile, cp);
  const { lx, ly } = localFromWorld(tile, wx, wy);
  return Math.abs(lx) <= hw + EPS && Math.abs(ly) <= hh + EPS;
}

/** Projection of (wx,wy) onto the tile forward axis from center; `t` = signed distance along forward. */
function gizmoScaleRayProjection(wx, wy, tile, cp) {
  const { fx, fy } = tileAxes(tile);
  const dx = wx - tile.x;
  const dy = wy - tile.y;
  const t = dx * fx + dy * fy;
  const perpX = dx - fx * t;
  const perpY = dy - fy * t;
  return {
    t,
    perpDist: hypot(perpX, perpY),
    fx,
    fy,
    len: gizmoScaleLineLength(tile, cp),
  };
}

/** Scale: thick corridor along the ray plus a padded disc at the knob (world px). */
function hitTestScaleHandle(wx, wy, tile, cp) {
  const { t, perpDist, fx, fy, len } = gizmoScaleRayProjection(wx, wy, tile, cp);
  const kx = tile.x + fx * len;
  const ky = tile.y + fy * len;
  const knobHitR = GIZMO_SCALE_KNOB_R_PX + GIZMO_SCALE_KNOB_HIT_PAD_PX;
  if (hypot(wx - kx, wy - ky) <= knobHitR) return true;
  if (perpDist > GIZMO_SCALE_HIT_HALF_WIDTH_PX) return false;
  if (t < GIZMO_SCALE_HUB_MIN_PX - 10) return false;
  if (t > len + GIZMO_SCALE_KNOB_R_PX + 32) return false;
  return true;
}

/**
 * Rotate: annulus around the ring radius. Inner edge stays outside the tile body so a thick
 * band does not eat the center pivot on small tiles.
 */
function hitTestRotateRing(wx, wy, tile, cp) {
  const { hw, hh } = gizmoExtents(tile, cp);
  const bodyClear = hypot(hw, hh) + 8;
  const R = gizmoRotateRingRadius(tile, cp);
  const T = GIZMO_ROTATE_HIT_HALF_THICK_PX;
  const inner = Math.max(bodyClear, R - T);
  const outer = R + T;
  const d = hypot(wx - tile.x, wy - tile.y);
  return d >= inner && d <= outer;
}

function snapRotationRadVal(rad, shift, alt) {
  if (alt) {
    const step = ROTATION_QUARTER_TURN;
    return Math.round(rad / step) * step;
  }
  if (shift) {
    const step = (15 * Math.PI) / 180;
    return Math.round(rad / step) * step;
  }
  return rad;
}

function snapScaleNum(s, shift, alt) {
  const step = alt ? 0.25 : (shift ? 0.1 : 0);
  if (!step) return clamp(s, SCALE_MIN, SCALE_MAX);
  return clamp(Math.round(s / step) * step, SCALE_MIN, SCALE_MAX);
}

function brushRotationQuadrant(rotationRad) {
  const q = Math.round((rotationRad ?? 0) / ROTATION_QUARTER_TURN);
  return ((q % 4) + 4) % 4;
}

function unwrapDeltaAngle(delta) {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Modal transform gizmo for the inspected tile (exactly one tool mode drawn + hit-tested). */
function appendTransformGizmo(state, host, cp) {
  const id = state.ui.inspectorTileId;
  if (id == null) return;
  const tile = state.tiles.get(id);
  if (!tile) return;
  const tool = state.ui.tool || 'move';
  const cx = tile.x;
  const cy = tile.y;
  const layer = svg('g', { id: 'layer-gizmo', class: 'gizmo-layer' });

  if (tool === 'move') {
    const { hw: mhw, hh: mhh } = gizmoMoveHalfExtents(tile, cp);
    const deg = (tileRotationRad(tile) * 180) / Math.PI;
    const hitG = svg('g', {
      transform: `translate(${cx} ${cy}) rotate(${deg}) translate(${-mhw} ${-mhh})`,
    });
    hitG.appendChild(svg('rect', {
      x: 0,
      y: 0,
      width: mhw * 2,
      height: mhh * 2,
      rx: 4,
      class: 'gizmo-move-hit',
    }));
    layer.appendChild(hitG);
  } else if (tool === 'rotate') {
    const R = gizmoRotateRingRadius(tile, cp);
    layer.appendChild(svg('circle', {
      cx,
      cy,
      r: R,
      class: 'gizmo-ring gizmo-ring-inner',
    }));
    layer.appendChild(svg('circle', {
      cx,
      cy,
      r: R,
      class: 'gizmo-rotate-hit',
    }));
    const ta = tileRotationRad(tile);
    const tx = cx + Math.cos(ta) * R * 0.78;
    const ty = cy + Math.sin(ta) * R * 0.78;
    layer.appendChild(svg('line', { x1: cx, y1: cy, x2: tx, y2: ty, class: 'gizmo-tick' }));
  } else if (tool === 'scale') {
    const { fx, fy } = tileAxes(tile);
    const len = gizmoScaleLineLength(tile, cp);
    const x2 = cx + fx * len;
    const y2 = cy + fy * len;
    layer.appendChild(svg('line', {
      x1: cx + fx * GIZMO_SCALE_HUB_MIN_PX,
      y1: cy + fy * GIZMO_SCALE_HUB_MIN_PX,
      x2,
      y2,
      class: 'gizmo-scale-hit',
    }));
    layer.appendChild(svg('line', {
      x1: cx + fx * GIZMO_SCALE_HUB_MIN_PX,
      y1: cy + fy * GIZMO_SCALE_HUB_MIN_PX,
      x2,
      y2,
      class: 'gizmo-scale-axis',
    }));
    layer.appendChild(svg('circle', {
      cx: x2,
      cy: y2,
      r: GIZMO_SCALE_KNOB_R_PX + GIZMO_SCALE_KNOB_HIT_PAD_PX,
      class: 'gizmo-scale-knob-hit',
    }));
    layer.appendChild(svg('circle', {
      cx: x2,
      cy: y2,
      r: GIZMO_SCALE_KNOB_R_PX,
      class: 'gizmo-scale-knob',
    }));
  }

  const gh = state.ui.gizmoHud;
  if (gh && gh.text) {
    layer.appendChild(svg('text', {
      x: gh.x,
      y: gh.y,
      class: 'gizmo-hud',
    }, gh.text));
  }

  host.appendChild(layer);
}

/** Root `<g>` transform: tile center + rotation + scale from design space to board pixels. */
function tileRootSvgTransform(tile, boardCellPx, innerPx = INNER_DESIGN_PX) {
  const sc = (boardCellPx / innerPx) * (tile.scale ?? 1);
  const deg = ((tile.rotationRad ?? 0) * 180) / Math.PI;
  return `translate(${tile.x} ${tile.y}) rotate(${deg}) scale(${sc}) translate(${-innerPx / 2} ${-innerPx / 2})`;
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

  const hoverW = state.ui.hoverWorld;
  let hoverTileId = null;
  if (hoverW && !state.ui.brush) {
    const hit = tileAtPoint(state, hoverW.x, hoverW.y);
    if (hit) hoverTileId = hit.id;
  }

  const innerDesign = INNER_DESIGN_PX;
  for (const tile of state.tiles.values()) {
    const root = drawTileG(tile, false);
    root.setAttribute('transform', tileRootSvgTransform(tile, cp, innerDesign));
    root.setAttribute('data-tile-id', String(tile.id));
    const rootClasses = [];
    if (hoverTileId === tile.id) rootClasses.push('board-tile-hover');
    if (state.ui.inspectorTileId === tile.id) rootClasses.push('board-tile-selected');
    if (rootClasses.length) root.setAttribute('class', rootClasses.join(' '));
    if (state.ui.inspectorTileId === tile.id) {
      const fr = root.querySelector('.tile-frame, .ghost-frame');
      if (fr) fr.classList.add('inspector-target');
    }
    layerTiles.appendChild(root);
    if (tile._interactGlow && tile._interactGlow.level > 0.004) {
      const hex = interactGlowDisplayHex(tile._interactGlow.colorId);
      const lv = tile._interactGlow.level;
      const op = Math.min(0.72, 0.12 + Math.pow(lv, 0.85) * 0.62);
      appendInteractGlowWorld(layerTiles, tile, cp, hex, String(op));
    }
  }

  if (hoverW) {
    const ex = tileAtPoint(state, hoverW.x, hoverW.y);
    if (state.ui.brush) {
      const ok = canPlaceTileCenter(state, hoverW.x, hoverW.y, null, state.ui.brush.kind);
      if (ok && !ex) {
        const ghost = {
          kind: state.ui.brush.kind,
          rotationRad: state.ui.brush.rotationRad ?? 0,
          scale: state.ui.brush.scale ?? 1,
          params: state.ui.brush.params || defaultParams(state.ui.brush.kind),
        };
        const gg = drawTileG(ghost, true);
        gg.setAttribute('transform', tileRootSvgTransform(
          { ...ghost, x: ok.x, y: ok.y },
          cp,
          innerDesign,
        ));
        layerHover.appendChild(gg);
      }
    } else if (ex) {
      layerHover.appendChild(svg('rect', {
        x: ex.x - cp / 2 + 2, y: ex.y - cp / 2 + 2, width: cp - 4, height: cp - 4,
        class: 'hover-occupied',
      }));
    }
  }

  appendTransformGizmo(state, host, cp);
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of state.particles) {
    ensureParticleEnergyFields(p);
    ensureParticleGlyph(p);
    const maxE = Math.max(1e-6, p.energyMax || 1);
    const tNorm = clamp((p.energy != null ? p.energy : maxE) / maxE, 0, 1);
    const fontPx = 5 + tNorm * 9.5;
    const alpha = 0.14 + tNorm * 0.88;
    ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.fillStyle = hexToRgba(COLOR_HEX[p.colorId] || '#111111', alpha);
    ctx.fillText(p.glyph, p.x, p.y);
  }
}

/* ---------- Storage ---------- */

const Storage = {
  KEY: 'mce.v1',
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

let inspFieldSeq = 0;

function appendInspHintButton(container, hintText) {
  if (!hintText) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'insp-hint';
  b.title = hintText;
  b.setAttribute('aria-label', hintText);
  b.innerHTML = '<svg class="insp-hint-svg" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4.75" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="5.5" cy="3.15" r="0.85" fill="currentColor"/><path d="M5.5 4.9v3.35" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" fill="none"/></svg>';
  b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  container.appendChild(b);
}

/** Label row + swatch strip (SOURCE color, GOAL filter, etc.). */
function appendInspectorLabeledColors(body, labelText, hint, colorRowEl) {
  const wrap = document.createElement('div');
  wrap.className = 'insp-row insp-row--colors';
  const labelRow = document.createElement('div');
  labelRow.className = 'insp-label-row';
  const lab = document.createElement('span');
  lab.className = 'insp-color-label';
  lab.textContent = labelText;
  labelRow.appendChild(lab);
  appendInspHintButton(labelRow, hint);
  wrap.appendChild(labelRow);
  wrap.appendChild(colorRowEl);
  body.appendChild(wrap);
}

/**
 * One row of inspector color swatches (SOURCE / GOAL / RECOLOR).
 * @param {string[]} choiceIds
 * @param {(id: string) => boolean} isActive
 * @param {(id: string, sw: HTMLButtonElement) => void} styleSwatch
 * @param {(id: string) => void} onPick — persist + re-render handled by caller inside this
 */
function buildInspectorSwatchRow(choiceIds, isActive, styleSwatch, onPick) {
  const cr = document.createElement('div');
  cr.className = 'color-row';
  for (const id of choiceIds) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (isActive(id) ? ' active' : '');
    styleSwatch(id, sw);
    sw.onclick = (e) => {
      e.stopPropagation();
      onPick(id);
    };
    cr.appendChild(sw);
  }
  return cr;
}

function bindParamSlider(row, label, min, max, step, value, onChange, hint) {
  inspFieldSeq += 1;
  const wrap = document.createElement('div');
  wrap.className = 'insp-row';
  const labelRow = document.createElement('div');
  labelRow.className = 'insp-label-row';
  const lb = document.createElement('label');
  lb.textContent = label;
  const fid = `insp-f-${inspFieldSeq}`;
  lb.setAttribute('for', fid);
  const val = document.createElement('div');
  val.className = 'insp-val';
  const input = document.createElement('input');
  input.type = 'range';
  input.id = fid;
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
  labelRow.appendChild(lb);
  appendInspHintButton(labelRow, hint);
  wrap.appendChild(labelRow);
  wrap.appendChild(input);
  wrap.appendChild(val);
  row.appendChild(wrap);
}

function selectTileForInspector(tile) {
  APP.state.ui.inspectorTileId = tile.id;
  APP.state.ui.gizmoHud = null;
  inspectorDomSig = '';
  APP.render();
}

function clearInspector() {
  if (!APP) return;
  APP.state.ui.inspectorTileId = null;
  APP.state.ui.gizmoHud = null;
  inspectorDomSig = '';
  document.querySelector('.sidebar-right')?.classList.remove('sidebar-right--tile-selected');
  const host = document.getElementById('tile-inspector');
  if (host) host.innerHTML = '';
}

/** Per-instance snapshot rows for the inspector tail (below sliders). */
function collectTileInstanceStatPairs(tile) {
  const r = [];
  if (tile.kind === 'GOAL') {
    r.push(['captured (this tile)', String(tile._captured | 0)]);
    const cap = tile.params.capacity | 0;
    r.push(['capacity (this tile)', cap > 0 ? String(cap) : '∞']);
  } else if (tile.kind === 'BUFFER') {
    const k = Math.max(1, tile.params.maxK | 0);
    r.push(['queued (this tile)', `${(tile._buf || []).length}/${k}`]);
  } else if (tile.kind === 'SOURCE') {
    const b = tile.params.energyBudget | 0;
    if (b > 0) {
      const left = tile._energyLeft != null ? tile._energyLeft : b;
      r.push(['emit budget (this)', `${((100 * left) / b).toFixed(0)}%`]);
    } else {
      r.push(['emit budget (this)', '∞']);
    }
  }
  return r;
}

function formatPairRowsHtml(pairs) {
  return pairs.map(([k, v]) =>
    `<div class="pkd-row"><span>${k}</span><b>${v}</b></div>`).join('');
}

function formatKindStatRowsHtml(state, kind) {
  return formatPairRowsHtml(collectKindDetailStatPairs(state, kind));
}

function renderTileInspector() {
  const host = document.getElementById('tile-inspector');
  if (!host) return;

  const id = APP.state.ui.inspectorTileId;
  const tile = id != null ? APP.state.tiles.get(id) : null;
  if (!tile) {
    if (id != null) APP.state.ui.inspectorTileId = null;
    inspectorDomSig = '';
    document.querySelector('.sidebar-right')?.classList.remove('sidebar-right--tile-selected');
    host.innerHTML = '';
    return;
  }

  const instRows = collectTileInstanceStatPairs(tile);
  const kindRows = collectKindDetailStatPairs(APP.state, tile.kind);
  const liveSig = [...instRows, ...kindRows].map(([a, b]) => `${a}=${b}`).join('|');
  const sig = `${tile.id}|${tile.x}|${tile.y}|${tile.rotationRad}|${tile.scale}|${tile.kind}|${JSON.stringify(tile.params)}|${liveSig}`;
  if (sig === inspectorDomSig && host.querySelector('.inspector-params')) {
    document.querySelector('.sidebar-right')?.classList.add('sidebar-right--tile-selected');
    return;
  }
  inspectorDomSig = sig;

  host.innerHTML = '';
  document.querySelector('.sidebar-right')?.classList.add('sidebar-right--tile-selected');

  const hdrRow = document.createElement('div');
  hdrRow.className = 'inspector-header-row';
  const hdr = document.createElement('div');
  hdr.className = 'inspector-header';
  hdr.textContent = `${tile.kind}  ·  ${tile.x.toFixed(0)},${tile.y.toFixed(0)}`;
  const pill = document.createElement('span');
  pill.className = 'inspector-sel-pill';
  pill.textContent = 'selected';
  hdrRow.appendChild(hdr);
  hdrRow.appendChild(pill);
  host.appendChild(hdrRow);

  const help = document.createElement('div');
  help.className = 'insp-kind-help';
  help.textContent = KIND_PLAYER_HELP[tile.kind] || '';
  host.appendChild(help);

  const body = document.createElement('div');
  body.className = 'inspector-params';
  inspFieldSeq = 0;
  const P = tile.params;

  const persistParams = () => {
    Storage.saveBoard(snapshotBoard(APP.state));
    invalidateAllParticleTileEntry(APP.state);
  };

  if (tile.kind === 'SOURCE') {
    bindParamSlider(body, 'rate / sec', 0, 600, 5, P.rate, v => { tile.params.rate = v; persistParams(); }, inspHint('SOURCE', 'rate'));
    bindParamSlider(body, 'speed min', 20, 400, 5, P.speedMin, v => { tile.params.speedMin = v; persistParams(); }, inspHint('SOURCE', 'speedMin'));
    bindParamSlider(body, 'speed max', 20, 500, 5, P.speedMax, v => { tile.params.speedMax = v; persistParams(); }, inspHint('SOURCE', 'speedMax'));
    bindParamSlider(body, 'spray °', 0, 85, 1, P.sprayDeg, v => { tile.params.sprayDeg = v; persistParams(); }, inspHint('SOURCE', 'sprayDeg'));
    bindParamSlider(body, 'timing noise', 0, 0.55, 0.02, P.timingNoise ?? 0.22, v => { tile.params.timingNoise = v; persistParams(); }, inspHint('SOURCE', 'timingNoise'));
    bindParamSlider(body, 'slow wander', 0, 0.45, 0.02, P.burst, v => { tile.params.burst = v; persistParams(); }, inspHint('SOURCE', 'burst'));
    bindParamSlider(body, 'emit energy (0=∞)', 0, 2e6, 2500, P.energyBudget ?? 0, v => {
      tile.params.energyBudget = v | 0;
      const cap = tile.params.energyBudget | 0;
      if (cap > 0) tile._energyLeft = cap;
      else delete tile._energyLeft;
      persistParams();
    }, inspHint('SOURCE', 'energyBudget'));
    bindParamSlider(body, 'spawn particle energy', 1, 800, 1, P.spawnParticleEnergy ?? 100, v => {
      tile.params.spawnParticleEnergy = Math.max(1, v | 0);
      persistParams();
    }, inspHint('SOURCE', 'spawnParticleEnergy'));
    const cr = buildInspectorSwatchRow(
      [...COLOR_IDS, 'random'],
      c => (P.colorId ?? 'black') === c,
      (c, sw) => {
        if (c === 'random') {
          styleSwatchRandomChannels(sw);
          sw.title = 'random (per spawn)';
        } else {
          sw.style.background = COLOR_HEX[c];
          sw.title = c;
        }
      },
      (c) => {
        tile.params.colorId = c;
        persistParams();
        inspectorDomSig = '';
        APP.render();
      },
    );
    appendInspectorLabeledColors(body, 'spawn color', inspHint('SOURCE', 'spawnColor'), cr);
  } else if (tile.kind === 'DIFFUSER') {
    bindParamSlider(body, 'spread °', 0, 70, 1, P.spreadDeg, v => { tile.params.spreadDeg = v; persistParams(); }, inspHint('DIFFUSER', 'spreadDeg'));
    bindParamSlider(body, 'spike chance', 0, 0.3, 0.02, P.spikeP ?? 0.09, v => { tile.params.spikeP = v; persistParams(); }, inspHint('DIFFUSER', 'spikeP'));
  } else if (tile.kind === 'REFLECTOR') {
    bindParamSlider(body, 'scatter apply p', 0, 1, 0.02, P.scatterP ?? 0.72, v => { tile.params.scatterP = v; persistParams(); }, inspHint('REFLECTOR', 'scatterP'));
    bindParamSlider(body, 'scatter °', 0, 18, 0.5, P.scatterDeg ?? 4, v => { tile.params.scatterDeg = v; persistParams(); }, inspHint('REFLECTOR', 'scatterDeg'));
  } else if (tile.kind === 'ABSORBER') {
    bindParamSlider(body, 'absorb p (×dt)', 0.02, 1, 0.02, P.absorbP, v => { tile.params.absorbP = v; persistParams(); }, inspHint('ABSORBER', 'absorbP'));
    bindParamSlider(body, 'p jitter', 0, 0.45, 0.02, P.absorbJitter ?? 0.18, v => { tile.params.absorbJitter = v; persistParams(); }, inspHint('ABSORBER', 'absorbJitter'));
  } else if (tile.kind === 'GOAL') {
    bindParamSlider(body, 'capture p', 0.5, 0.999, 0.01, P.captureP ?? 0.93, v => { tile.params.captureP = v; persistParams(); }, inspHint('GOAL', 'captureP'));
    bindParamSlider(body, 'capacity (0=∞)', 0, 500, 1, P.capacity | 0, v => { tile.params.capacity = v | 0; persistParams(); }, inspHint('GOAL', 'capacity'));
    const cr = buildInspectorSwatchRow(
      [...COLOR_IDS, 'any'],
      c => (P.filterColor || 'any') === c,
      (c, sw) => {
        if (c === 'any') {
          sw.style.background = '#eee';
          sw.textContent = '∗';
          sw.title = 'ANY — accept all channels';
        } else {
          sw.style.background = COLOR_HEX[c];
          sw.textContent = '';
          sw.title = c;
        }
      },
      (c) => {
        tile.params.filterColor = c;
        persistParams();
        inspectorDomSig = '';
        APP.render();
      },
    );
    appendInspectorLabeledColors(body, 'catch filter', inspHint('GOAL', 'catchFilter'), cr);
  } else if (tile.kind === 'SPLITTER') {
    bindParamSlider(body, 'split chance', 0, 1, 0.05, P.splitP, v => { tile.params.splitP = v; persistParams(); }, inspHint('SPLITTER', 'splitP'));
    bindParamSlider(body, 'child speed ×', 0.3, 1, 0.02, P.childSpeed, v => { tile.params.childSpeed = v; persistParams(); }, inspHint('SPLITTER', 'childSpeed'));
    bindParamSlider(body, 'split angle °', 0, 85, 1, P.splitAngleDeg ?? 30, v => { tile.params.splitAngleDeg = v; persistParams(); }, inspHint('SPLITTER', 'splitAngleDeg'));
    bindParamSlider(body, 'angle jitter °', 0, 12, 0.5, P.angleJitterDeg ?? 3, v => { tile.params.angleJitterDeg = v; persistParams(); }, inspHint('SPLITTER', 'angleJitterDeg'));
  } else if (tile.kind === 'RECOLOR') {
    bindParamSlider(body, 'recolor rate', 0.5, 30, 0.5, P.recolorRate, v => { tile.params.recolorRate = v; persistParams(); }, inspHint('RECOLOR', 'recolorRate'));
    bindParamSlider(body, 'quiet frames p', 0, 0.25, 0.02, P.skipP ?? 0.06, v => { tile.params.skipP = v; persistParams(); }, inspHint('RECOLOR', 'skipP'));
    const cr = buildInspectorSwatchRow(
      [...COLOR_IDS, 'random'],
      c => (P.assignColorId ?? 'red') === c,
      (c, sw) => {
        if (c === 'random') {
          styleSwatchRandomChannels(sw);
          sw.title = 'random (per tick that fires)';
        } else {
          sw.style.background = COLOR_HEX[c];
          sw.title = c;
        }
      },
      (c) => {
        tile.params.assignColorId = c;
        persistParams();
        inspectorDomSig = '';
        APP.render();
      },
    );
    appendInspectorLabeledColors(body, 'assign color', inspHint('RECOLOR', 'assignColorId'), cr);
  } else if (tile.kind === 'VELOCITY') {
    bindParamSlider(body, '∥ gain (aim)', 0.05, 2.5, 0.05, P.parallelGain, v => { tile.params.parallelGain = v; persistParams(); }, inspHint('VELOCITY', 'parallelGain'));
    bindParamSlider(body, '⊥ gain', 0.05, 2.5, 0.05, P.tangentialGain, v => { tile.params.tangentialGain = v; persistParams(); }, inspHint('VELOCITY', 'tangentialGain'));
    bindParamSlider(body, 'applies p', 0.4, 0.999, 0.02, P.engageP ?? 0.88, v => { tile.params.engageP = v; persistParams(); }, inspHint('VELOCITY', 'engageP'));
  } else if (tile.kind === 'SWIRL') {
    bindParamSlider(body, 'omega', 20, 900, 10, P.omega, v => { tile.params.omega = v; persistParams(); }, inspHint('SWIRL', 'omega'));
    bindParamSlider(body, 'decay', 0.2, 6, 0.1, P.decay, v => { tile.params.decay = v; persistParams(); }, inspHint('SWIRL', 'decay'));
    bindParamSlider(body, 'ω jitter', 0, 0.4, 0.02, P.omegaJitter ?? 0.14, v => { tile.params.omegaJitter = v; persistParams(); }, inspHint('SWIRL', 'omegaJitter'));
  } else if (tile.kind === 'TELEPORT') {
    bindParamSlider(body, 'link id', 0, 7, 1, P.linkId | 0, v => { tile.params.linkId = v | 0; persistParams(); }, inspHint('TELEPORT', 'linkId'));
    bindParamSlider(body, 'fail p', 0, 1, 0.02, P.malfunctionP, v => { tile.params.malfunctionP = v; persistParams(); }, inspHint('TELEPORT', 'malfunctionP'));
    bindParamSlider(body, 'exit cone °', 0, 60, 1, P.coneDeg, v => { tile.params.coneDeg = v; persistParams(); }, inspHint('TELEPORT', 'coneDeg'));
    bindParamSlider(body, 'exit extra jitter °', 0, 22, 0.5, P.exitJitterDeg ?? 4, v => { tile.params.exitJitterDeg = v; persistParams(); }, inspHint('TELEPORT', 'exitJitterDeg'));
  } else if (tile.kind === 'MEMBRANE') {
    bindParamSlider(body, 'leak p', 0, 1, 0.02, P.leakP, v => { tile.params.leakP = v; persistParams(); }, inspHint('MEMBRANE', 'leakP'));
    bindParamSlider(body, 'leak wobble', 0, 0.28, 0.02, P.wobbleP ?? 0.06, v => { tile.params.wobbleP = v; persistParams(); }, inspHint('MEMBRANE', 'wobbleP'));
  } else if (tile.kind === 'RESONATOR') {
    bindParamSlider(body, 'amplitude', 50, 900, 10, P.amplitude, v => { tile.params.amplitude = v; persistParams(); }, inspHint('RESONATOR', 'amplitude'));
    bindParamSlider(body, 'freq', 0.5, 10, 0.1, P.freq, v => { tile.params.freq = v; persistParams(); }, inspHint('RESONATOR', 'freq'));
    bindParamSlider(body, 'amp jitter', 0, 0.35, 0.02, P.ampJitter ?? 0.14, v => { tile.params.ampJitter = v; persistParams(); }, inspHint('RESONATOR', 'ampJitter'));
  } else if (tile.kind === 'BUFFER') {
    bindParamSlider(body, 'max hold', 1, 200, 1, P.maxK | 0, v => { tile.params.maxK = v | 0; persistParams(); }, inspHint('BUFFER', 'maxK'));
    bindParamSlider(body, 'release / sec', 0.5, 80, 0.5, P.releaseRate, v => { tile.params.releaseRate = v; persistParams(); }, inspHint('BUFFER', 'releaseRate'));
    bindParamSlider(body, 'slip past p', 0, 0.2, 0.005, P.slipP ?? 0.022, v => { tile.params.slipP = v; persistParams(); }, inspHint('BUFFER', 'slipP'));
    bindParamSlider(body, 'burst when full', 0, 1, 1, P.burstOnFull | 0, v => { tile.params.burstOnFull = v | 0; persistParams(); }, inspHint('BUFFER', 'burstOnFull'));
  }

  if (tile.kind !== 'SOURCE') {
    const defDrain = defaultParams(tile.kind).energyDrain ?? 0;
    bindParamSlider(body, 'energy drain / tick', 0, 12, 0.02, P.energyDrain ?? defDrain, v => {
      tile.params.energyDrain = Math.max(0, v);
      persistParams();
    }, inspHint('ALL', 'energyDrain'));
  }

  host.appendChild(body);

  const tail = document.createElement('div');
  tail.className = 'insp-tail-stats';
  tail.innerHTML = '<div class="insp-stats-label">stats</div>'
    + formatPairRowsHtml([...instRows, ...kindRows]);
  host.appendChild(tail);
}

function countTilesOfKind(state, kind) {
  let n = 0;
  for (const t of state.tiles.values()) {
    if (t.kind === kind) n++;
  }
  return n;
}

function layoutCostForKind(state, kind) {
  const unit = TILE_MATERIAL_COST[kind] ?? 12;
  return countTilesOfKind(state, kind) * unit;
}

function collectKindDetailStatPairs(state, kind) {
  const rows = [];
  const nPlaced = countTilesOfKind(state, kind);
  rows.push(['placed', String(nPlaced)]);
  rows.push(['layout cost', String(layoutCostForKind(state, kind))]);

  if (kind === 'GOAL') {
    let cap = 0;
    let captured = 0;
    for (const t of state.tiles.values()) {
      if (t.kind !== 'GOAL') continue;
      captured += t._captured | 0;
      cap += t.params.capacity | 0;
    }
    rows.push(['Σ captured', String(captured)]);
    rows.push(['capacity Σ', cap > 0 ? String(cap) : '∞']);
  } else if (kind === 'BUFFER') {
    let used = 0;
    let cap = 0;
    for (const t of state.tiles.values()) {
      if (t.kind !== 'BUFFER') continue;
      const maxK = Math.max(1, t.params.maxK | 0);
      cap += maxK;
      used += (t._buf || []).length;
    }
    rows.push(['buffer slots', cap > 0 ? `${used}/${cap}` : '—']);
  } else if (kind === 'SOURCE') {
    let withBudget = 0;
    let left = 0;
    let cap = 0;
    for (const t of state.tiles.values()) {
      if (t.kind !== 'SOURCE') continue;
      const b = t.params.energyBudget | 0;
      if (b > 0) {
        withBudget++;
        cap += b;
        left += t._energyLeft != null ? t._energyLeft : b;
      }
    }
    rows.push(['SRC with budget', String(withBudget)]);
    rows.push(['SRC budget left', cap > 0 ? `${((100 * left) / cap).toFixed(0)}%` : '—']);
  } else if (kind === 'TELEPORT') {
    const byLink = new Map();
    for (const t of state.tiles.values()) {
      if (t.kind !== 'TELEPORT') continue;
      const lid = t.params.linkId | 0;
      byLink.set(lid, (byLink.get(lid) || 0) + 1);
    }
    const parts = [...byLink.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`);
    rows.push(['by link id', parts.length ? parts.join(' ') : '—']);
  }

  const runPairs = KIND_RUN_ROWS[kind];
  const rs = state.runStats;
  if (runPairs) {
    for (const [label, key] of runPairs) {
      rows.push([`${label} (q)`, String(rs[key] ?? 0)]);
    }
  }

  return rows;
}

/* ---------- Palette & HUD ---------- */

/** Hotkey label for palette index 0–19 (digits 1–9,0 then Shift+digits). */
function paletteHotkeyLabel(index) {
  if (index < 0 || index >= 20) return '';
  const n = index % 10;
  const ch = n === 9 ? '0' : String(n + 1);
  return index < 10 ? ch : `⇧${ch}`;
}

function renderPalette() {
  const host = document.getElementById('palette');
  host.innerHTML = '';
  const { level, ui } = APP.state;
  for (let i = 0; i < level.palette.length; i++) {
    const kind = level.palette[i];
    const entry = document.createElement('div');
    entry.className = 'palette-entry';
    entry.dataset.paletteKind = kind;
    if (ui.brush && ui.brush.kind === kind) entry.classList.add('active');
    const hk = paletteHotkeyLabel(i);
    if (hk) {
      const badge = document.createElement('span');
      badge.className = 'pe-hotkey';
      badge.textContent = hk;
      badge.title = i < 10 ? `Hotkey ${hk}` : `Hotkey Shift+${hk.slice(1)}`;
      entry.appendChild(badge);
    }

    const glyph = document.createElementNS(SVG_NS, 'svg');
    glyph.setAttribute('class', 'pe-glyph');
    glyph.setAttribute('viewBox', `0 0 ${INNER_DESIGN_PX} ${INNER_DESIGN_PX}`);
    const fake = {
      kind,
      rotationRad: ui.brush && ui.brush.kind === kind ? (ui.brush.rotationRad ?? 0) : 0,
      scale: ui.brush && ui.brush.kind === kind ? (ui.brush.scale ?? 1) : 1,
      params: defaultParams(kind),
    };
    const inner = drawTileG(fake, false);
    const cpPal = cellPx(APP.state);
    const c0 = INNER_DESIGN_PX / 2;
    inner.setAttribute('transform', tileRootSvgTransform({ ...fake, x: c0, y: c0 }, cpPal, INNER_DESIGN_PX));
    glyph.appendChild(inner);
    entry.appendChild(glyph);
    const label = document.createElement('div');
    label.className = 'pe-label';
    label.textContent = `${kind}`;
    entry.appendChild(label);
    const rotBox = document.createElement('div');
    rotBox.className = 'pe-rot';
    const cur = ui.brush && ui.brush.kind === kind ? brushRotationQuadrant(ui.brush.rotationRad ?? 0) : 0;
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
        ui.brush = makeDefaultBrush(kind);
      }
      ui.brush.rotationRad = (ui.brush.rotationRad ?? 0) + ROTATION_QUARTER_TURN;
      APP.render();
    });
    entry.appendChild(rotBox);
    entry.addEventListener('click', () => {
      if (ui.brush && ui.brush.kind === kind) ui.brush = null;
      else ui.brush = makeDefaultBrush(kind);
      APP.render();
    });
    host.appendChild(entry);
  }
}

/** Fixed-timestep ticks since last reset (Zachtronics “cycles”). */
function solutionCycleTicks(state) {
  return Math.round(state.sim.time / FIXED_DT);
}

/** Axis-aligned bbox of all tile hitboxes, in board-cell² (spread-out layouts score worse). */
function solutionFootprintCellsSq(state) {
  const cp = cellPx(state);
  const tiles = [...state.tiles.values()];
  if (tiles.length === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    const br = boundingRadiusPx(t, cp);
    minX = Math.min(minX, t.x - br);
    maxX = Math.max(maxX, t.x + br);
    minY = Math.min(minY, t.y - br);
    maxY = Math.max(maxY, t.y + br);
  }
  const areaPx = (maxX - minX) * (maxY - minY);
  return areaPx / (cp * cp);
}

function solutionMaterialCost(state) {
  let s = 0;
  for (const t of state.tiles.values()) {
    s += TILE_MATERIAL_COST[t.kind] ?? 12;
  }
  return s;
}

function equipmentSummary(state) {
  const c = new Map();
  for (const t of state.tiles.values()) {
    c.set(t.kind, (c.get(t.kind) || 0) + 1);
  }
  const parts = [];
  const seen = new Set();
  for (const k of state.level.palette) {
    const n = c.get(k) || 0;
    if (n) {
      parts.push(`${KIND_META[k]?.label ?? k}×${n}`);
      seen.add(k);
    }
  }
  for (const [k, n] of c) {
    if (!seen.has(k) && n) parts.push(`${KIND_META[k]?.label ?? k}×${n}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}

function goalsCapturedSum(state) {
  let s = 0;
  for (const t of state.tiles.values()) {
    if (t.kind === 'GOAL') s += t._captured | 0;
  }
  return s;
}

function sourceBudgetPct(state) {
  let left = 0, cap = 0;
  for (const t of state.tiles.values()) {
    if (t.kind !== 'SOURCE') continue;
    const b = t.params.energyBudget | 0;
    if (b <= 0) continue;
    cap += b;
    left += t._energyLeft != null ? t._energyLeft : b;
  }
  if (cap <= 0) return null;
  return (100 * left) / cap;
}

function bufferCapacityTotals(state) {
  let used = 0, cap = 0;
  for (const t of state.tiles.values()) {
    if (t.kind !== 'BUFFER') continue;
    const maxK = Math.max(1, t.params.maxK | 0);
    cap += maxK;
    used += (t._buf || []).length;
  }
  return { used, cap };
}

function computeParticleMetrics(state) {
  const ps = state.particles;
  const n = ps.length;
  if (n === 0) {
    return {
      meanSpeed: 0,
      meanEnergyFrac: 0,
      sumKe: 0,
      minSpeed: 0,
      maxSpeed: 0,
      minEf: 0,
      maxEf: 0,
      spread: 0,
      uniqueGlyphs: 0,
      colorsPresent: 0,
      maxPerTile: 0,
      tilesWithParticles: 0,
    };
  }
  let sx = 0;
  let sy = 0;
  let sumSp = 0;
  let sumKe = 0;
  let sumEf = 0;
  let minSp = Infinity;
  let maxSp = 0;
  let minEf = 1;
  let maxEf = 0;
  const colors = new Set();
  const glyphs = new Set();
  const tilePop = new Map();
  for (const p of ps) {
    sx += p.x;
    sy += p.y;
    const sp = hypot(p.vx, p.vy);
    sumSp += sp;
    sumKe += sp * sp;
    minSp = Math.min(minSp, sp);
    maxSp = Math.max(maxSp, sp);
    colors.add(p.colorId && COLOR_HEX[p.colorId] ? p.colorId : 'black');
    if (p.glyph) glyphs.add(p.glyph);
    const maxE = Math.max(1e-6, p.energyMax ?? p.energy ?? 1);
    const e = Number.isFinite(p.energy) ? p.energy : maxE;
    const ef = e / maxE;
    sumEf += ef;
    minEf = Math.min(minEf, ef);
    maxEf = Math.max(maxEf, ef);
    const tile = tileAtPoint(state, p.x, p.y);
    const key = tile ? tile.id : -1;
    tilePop.set(key, (tilePop.get(key) || 0) + 1);
  }
  sx /= n;
  sy /= n;
  let distSum = 0;
  for (const p of ps) distSum += Math.hypot(p.x - sx, p.y - sy);
  let maxPerTile = 0;
  for (const v of tilePop.values()) maxPerTile = Math.max(maxPerTile, v);
  return {
    meanSpeed: sumSp / n,
    meanEnergyFrac: sumEf / n,
    sumKe,
    minSpeed: minSp,
    maxSpeed: maxSp,
    minEf,
    maxEf,
    spread: distSum / n,
    uniqueGlyphs: glyphs.size,
    colorsPresent: colors.size,
    maxPerTile,
    tilesWithParticles: tilePop.size,
  };
}

/** Goals summary for the top of the simulation stats hover panel. */
function formatGoalsStatsHtml(state) {
  const goals = [...state.tiles.values()].filter(t => t.kind === 'GOAL');
  const sum = goalsCapturedSum(state);
  if (goals.length === 0) {
    return '<div class="stats-goals">'
      + '<div class="stats-goals-title">goals</div>'
      + '<div class="sp-row"><span>none placed</span><b>—</b></div>'
      + '</div>';
  }
  const rows = goals.map(g => {
    const filt = g.params.filterColor || 'any';
    return `<div class="sp-row"><span>goal #${g.id} (${filt})</span><b>${g._captured ?? 0}</b></div>`;
  }).join('');
  return `<div class="stats-goals"><div class="stats-goals-title">goals · Σ ${sum} captured</div>${rows}</div>`;
}

function renderHUD() {
  const host = document.getElementById('stats');
  const st = APP.state;
  const rs = st.runStats;
  const sim = st.sim;
  const n = st.particles.length;
  const fpsStr = sim.fpsAvg > 0 ? sim.fpsAvg.toFixed(0) : '—';
  const zhFoot = Math.ceil(solutionFootprintCellsSq(st));
  const zhCost = solutionMaterialCost(st);
  const zhCycles = solutionCycleTicks(st);

  let buf = 0;
  for (const t of st.tiles.values()) {
    if (t.kind === 'BUFFER' && t._buf) buf += t._buf.length;
  }
  const bufCap = bufferCapacityTotals(st);
  const bufFill = bufCap.cap > 0 ? ((100 * bufCap.used) / bufCap.cap).toFixed(0) + '%' : '—';
  const srcPct = sourceBudgetPct(st);
  const srcBudgetStr = srcPct == null ? '∞' : `${srcPct.toFixed(0)}%`;
  const pm = computeParticleMetrics(st);
  const capPct = ((100 * n) / MAX_PARTICLES).toFixed(1);
  const spd = simTimeScale(sim.speed);
  const headRows = [
    ['time (sim s)', sim.time.toFixed(1)],
    ['chars', String(n)],
    ['fps', fpsStr],
  ];
  const zhRows = [
    ['cycles', String(zhCycles)],
    ['footprint (cells²)', String(zhFoot)],
    ['cost', String(zhCost)],
  ];
  const rows = [
    ['time scale', `×${spd}`],
    ['substeps / frame', String(sim.substepsLastFrame | 0)],
    ['sim capacity', `${capPct}%`],
    ['tiles placed', String(st.tiles.size)],
    ['equipment', equipmentSummary(st)],
    ['buffered (live)', String(buf)],
    ['buffer slots', bufCap.cap > 0 ? `${bufCap.used}/${bufCap.cap}` : '—'],
    ['buffer fill', bufFill],
    ['SRC budget', srcBudgetStr],
    ['⟨speed⟩', n ? pm.meanSpeed.toFixed(1) : '—'],
    ['speed min–max', n ? `${pm.minSpeed.toFixed(0)}–${pm.maxSpeed.toFixed(0)}` : '—'],
    ['⟨energy⟩', n ? (pm.meanEnergyFrac * 100).toFixed(0) + '%' : '—'],
    ['energy min–max', n ? `${(pm.minEf * 100).toFixed(0)}–${(pm.maxEf * 100).toFixed(0)}%` : '—'],
    ['Σ v² (ke proxy)', n ? pm.sumKe.toFixed(0) : '0'],
    ['spread (px)', n ? pm.spread.toFixed(0) : '—'],
    ['glyph kinds', n ? `${pm.uniqueGlyphs} / ${n}` : '—'],
    ['color channels', n ? String(pm.colorsPresent) + ' / 5' : '—'],
    ['pile height', n ? String(pm.maxPerTile) : '—'],
    ['tiles occupied', n ? String(pm.tilesWithParticles) : '—'],
  ];
  const runRows = [
    ['spawned (SRC)', String(rs.spawnSource)],
    ['buffer in → out', `${rs.bufferIn} → ${rs.bufferOut}`],
    ['split births', String(rs.splitBirths)],
    ['teleports', String(rs.teleports)],
    ['absorber', String(rs.absorber)],
    ['goal catches', String(rs.goalCatch)],
    ['reflector (enter)', String(rs.reflectorHit)],
    ['edge cull', String(rs.edgeCull)],
  ];
  const rowHtml = (a, rowClass = '') => a.map(([k, v]) =>
    `<div class="sp-row${rowClass ? ` ${rowClass}` : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
  host.innerHTML = formatGoalsStatsHtml(st)
    + rowHtml(headRows)
    + '<div class="sp-zh">layout score</div>'
    + rowHtml(zhRows, 'sp-zh-metric')
    + rowHtml(rows)
    + '<div class="sp-sub">run since reset (q)</div>'
    + rowHtml(runRows);
}

/* ---------- Input ---------- */

let APP = null;
let BOARD_INPUT_ATTACHED = false;

function syncTransformToolButtons() {
  if (!APP) return;
  const t = APP.state.ui.tool || 'move';
  for (const m of TOOL_MODES) {
    document.getElementById(`tool-${m}`)?.classList.toggle('active', t === m);
  }
}

function setTransformTool(mode) {
  if (!APP || !TOOL_MODES.includes(mode)) return;
  APP.state.ui.tool = mode;
  syncTransformToolButtons();
  APP.render();
}
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

  boardEl.addEventListener('dblclick', e => {
    const world = worldFromEvent(boardEl, e);
    if (!world) return;
    const cp = cellPx(APP.state);
    const id = APP.state.ui.inspectorTileId;
    if (id == null) return;
    const tile = APP.state.tiles.get(id);
    if (!tile) return;
    if (hitTestRotateRing(world.x, world.y, tile, cp)) {
      withBoardEdit(APP.state, () => { tile.rotationRad = 0; return true; });
      inspectorDomSig = '';
      APP.render();
      return;
    }
    if (hitTestScaleHandle(world.x, world.y, tile, cp)) {
      withBoardEdit(APP.state, () => { tile.scale = 1; return true; });
      inspectorDomSig = '';
      APP.render();
    }
  });

  boardEl.addEventListener('mousedown', e => {
    const world = worldFromEvent(boardEl, e);
    if (!world) return;
    APP.state.ui.hoverWorld = world;
    const cp = cellPx(APP.state);
    const tool = APP.state.ui.tool || 'move';
    const selId = APP.state.ui.inspectorTileId;
    const st = selId != null ? APP.state.tiles.get(selId) : null;
    const tileTop = tileAtPoint(APP.state, world.x, world.y);

    if (e.button === 2) {
      if (tileTop) {
        withBoardEdit(APP.state, () => { rotateTile(APP.state, tileTop.id); return true; });
        inspectorDomSig = '';
        APP.render();
      }
      return;
    }
    if (e.button !== 0) return;

    if (st) {
      if (tool === 'scale' && hitTestScaleHandle(world.x, world.y, st, cp)) {
        const tile = st;
        const { fx, fy } = tileAxes(tile);
        const projectAlongScaleRay = (wx, wy) => {
          const dx = wx - tile.x;
          const dy = wy - tile.y;
          return Math.max(GIZMO_SCALE_HUB_MIN_PX, dx * fx + dy * fy);
        };
        const dragSnap = snapshotBoard(APP.state);
        const startScale = tile.scale ?? 1;
        const r0 = projectAlongScaleRay(world.x, world.y);
        const lenHud = gizmoScaleLineLength(tile, cp);
        const onMove = ev => {
          const wloc = worldFromEvent(boardEl, ev);
          if (!wloc) return;
          const r1 = projectAlongScaleRay(wloc.x, wloc.y);
          let ns = startScale * (r1 / r0);
          ns = snapScaleNum(ns, ev.shiftKey, ev.altKey);
          tile.scale = clamp(ns, SCALE_MIN, SCALE_MAX);
          APP.state.ui.gizmoHud = {
            text: `× ${tile.scale.toFixed(2)}`,
            x: tile.x + fx * (lenHud + 18),
            y: tile.y + fy * (lenHud + 18) - 4,
          };
          APP.render();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          APP.state.ui.gizmoHud = null;
          commitBoardEdit(APP.state, dragSnap);
          inspectorDomSig = '';
          APP.render();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }
      if (tool === 'rotate' && hitTestRotateRing(world.x, world.y, st, cp)) {
        const tile = st;
        const dragSnap = snapshotBoard(APP.state);
        const startRot = tileRotationRad(tile);
        const a0 = Math.atan2(world.y - tile.y, world.x - tile.x);
        const Rring = gizmoRotateRingRadius(tile, cp);
        const onMove = ev => {
          const wloc = worldFromEvent(boardEl, ev);
          if (!wloc) return;
          const a1 = Math.atan2(wloc.y - tile.y, wloc.x - tile.x);
          const delta = unwrapDeltaAngle(a1 - a0);
          let nr = startRot + delta;
          nr = snapRotationRadVal(nr, ev.shiftKey, ev.altKey);
          tile.rotationRad = nr;
          APP.state.ui.gizmoHud = {
            text: `${((nr * 180) / Math.PI).toFixed(1)}°`,
            x: tile.x + Math.cos(a1) * (Rring + 22),
            y: tile.y + Math.sin(a1) * (Rring + 22) - 4,
          };
          APP.render();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          APP.state.ui.gizmoHud = null;
          commitBoardEdit(APP.state, dragSnap);
          inspectorDomSig = '';
          APP.render();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }
    }

    let moveTile = null;
    if (tool === 'move') {
      if (tileTop) moveTile = tileTop;
      else if (st && hitTestMoveNear(world.x, world.y, st, cp)) moveTile = st;
    }

    if (moveTile) {
      const startX = e.clientX;
      const startY = e.clientY;
      let dragged = false;
      const dragStartSnap = snapshotBoard(APP.state);
      const grabDx = world.x - moveTile.x;
      const grabDy = world.y - moveTile.y;
      const onMove = ev => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
          dragged = true;
          document.getElementById('trash').classList.add('armed');
        }
        if (dragged) {
          const wloc = worldFromEvent(boardEl, ev);
          if (wloc) tryMoveTileTo(APP.state, moveTile.id, wloc.x - grabDx, wloc.y - grabDy);
          APP.render();
        }
      };
      const onUp = ev => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.getElementById('trash').classList.remove('armed');
        if (!dragged) selectTileForInspector(moveTile);
        else {
          const trash = document.getElementById('trash').getBoundingClientRect();
          const overTrash = ev.clientX >= trash.left && ev.clientX <= trash.right
            && ev.clientY >= trash.top && ev.clientY <= trash.bottom;
          if (overTrash) {
            withBoardEdit(APP.state, () => {
              const tid = moveTile.id;
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

    if (tileTop) {
      if (tool !== 'move') {
        selectTileForInspector(tileTop);
        inspectorDomSig = '';
        APP.render();
        return;
      }
    }

    if (APP.state.ui.brush) {
      const b = APP.state.ui.brush;
      if (canPlaceTileCenter(APP.state, world.x, world.y, null, b.kind)) {
        let placed = null;
        withBoardEdit(APP.state, () => {
          placed = placeTile(
            APP.state,
            b.kind,
            world.x,
            world.y,
            b.rotationRad ?? 0,
            b.scale ?? 1,
            b.params,
          );
          return !!placed;
        });
        if (placed) {
          selectTileForInspector(placed);
          inspectorDomSig = '';
        }
        APP.state.ui.brush = null;
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
  let digit = '';
  if (e.code && e.code.startsWith('Digit')) digit = e.code.slice(5);
  else if (e.code && e.code.startsWith('Numpad')) digit = e.code.slice(6);
  if (!/^\d$/.test(digit)) return -1;
  const base = digit === '0' ? 9 : parseInt(digit, 10) - 1;
  if (e.shiftKey && e.code && e.code.startsWith('Numpad')) return -1;
  return base + (e.shiftKey ? 10 : 0);
}

function cycleBrush(reverse) {
  const pal = APP.state.level.palette;
  const cur = APP.state.ui.brush ? APP.state.ui.brush.kind : null;
  const idx = cur ? pal.indexOf(cur) : -1;
  const next = idx < 0 ? (reverse ? pal.length - 1 : 0)
    : (idx + (reverse ? pal.length - 1 : 1)) % pal.length;
  const kind = pal[next];
  APP.state.ui.brush = makeDefaultBrush(kind);
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
      if (t) {
        withBoardEdit(APP.state, () => { rotateTile(APP.state, t.id); return true; });
        APP.render();
        return;
      }
    }
    if (APP.state.ui.brush) {
      APP.state.ui.brush.rotationRad = (APP.state.ui.brush.rotationRad ?? 0) + ROTATION_QUARTER_TURN;
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
      const s = Number(b.dataset.speed);
      if (!SPEED_STEPS.includes(s)) return;
      APP.state.sim.speed = s;
      for (const x of document.querySelectorAll('.spd-btn')) x.classList.remove('active');
      b.classList.add('active');
      Storage.saveSpeed(s);
    });
  }

  syncTransformToolButtons();
  for (const m of TOOL_MODES) {
    document.getElementById(`tool-${m}`)?.addEventListener('click', () => setTransformTool(m));
  }

  document.addEventListener('mousedown', e => {
    if (APP) {
      const tgt = e.target instanceof Element ? e.target : e.target?.parentElement;
      const sg = document.getElementById('screen-game');
      if (sg && tgt && sg.contains(tgt)) {
        sg.focus({ preventScroll: true });
      }
      // Include .sidebar (left + right): capture-phase runs before click; re-rendering
      // the palette here would replace DOM under the pointer and swallow palette clicks.
      const keepInspector = tgt && (tgt.closest('.sidebar')
        || tgt.closest('[data-tile-id]')
        || tgt.closest('#layer-gizmo')
        || tgt.closest('.tool-picker')
        || tgt.closest('.topbar')
        || tgt.closest('.bottombar'));
      if (!keepInspector) {
        clearInspector();
        APP.render();
      }
    }
  }, true);

  const onAppKeydown = e => {
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
      if (e.repeat) return;
      const kind = APP.state.level.palette[pi];
      if (!kind) return;
      e.preventDefault();
      const cur = APP.state.ui.brush;
      if (cur && cur.kind === kind) {
        APP.state.ui.brush = null;
      } else {
        APP.state.ui.brush = makeDefaultBrush(kind);
      }
      APP.render();
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
    if (e.code === 'KeyW') {
      e.preventDefault();
      setTransformTool('move');
      return;
    }
    if (e.code === 'KeyE') {
      e.preventDefault();
      setTransformTool('rotate');
      return;
    }
    if (e.code === 'KeyR') {
      e.preventDefault();
      setTransformTool('scale');
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      document.getElementById('btn-delete').click();
    }
  };
  window.addEventListener('keydown', onAppKeydown, true);
}

function bumpSpeed(dir) {
  const i = SPEED_STEPS.indexOf(APP.state.sim.speed);
  const ni = clamp((i < 0 ? 1 : i) + dir, 0, SPEED_STEPS.length - 1);
  APP.state.sim.speed = SPEED_STEPS[ni];
  for (const b of document.querySelectorAll('.spd-btn')) {
    b.classList.toggle('active', Number(b.dataset.speed) === APP.state.sim.speed);
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
  renderHUD();
  document.getElementById('btn-undo').disabled = APP.state.history.past.length === 0;
  document.getElementById('btn-redo').disabled = APP.state.history.future.length === 0;
}

function bootstrap() {
  const state = createState();
  const saved = Storage.getBoard();
  const meta = Storage.load();
  if (saved) applyBoardSnapshot(state, saved, !meta.posPx);
  let sp = Storage.getSpeed();
  if (!SPEED_STEPS.includes(sp)) sp = 1;
  state.sim.speed = sp;
  APP = { state, render: renderAll };
  document.querySelectorAll('.spd-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.speed) === state.sim.speed);
  });
  attachUI();
  if (!BOARD_INPUT_ATTACHED) {
    attachBoardInput(document.getElementById('board'));
    BOARD_INPUT_ATTACHED = true;
  }
  renderAll();
  const focusGame = () => {
    document.getElementById('screen-game')?.focus({ preventScroll: true });
  };
  requestAnimationFrame(() => {
    focusGame();
    requestAnimationFrame(focusGame);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  bootstrap();
});
