/* BUILDER — main app.
 *
 * Single-file vanilla-JS implementation. Organized in sections:
 *   1. Constants & helpers
 *   2. Component definitions
 *   3. Levels
 *   4. State & mutations
 *   5. Simulator
 *   6. Renderer (SVG)
 *   7. Input (mouse)
 *   8. UI panels (palette, controls, HUD, modals, level select)
 *   9. Storage
 *  10. Bootstrap
 */
'use strict';

/* ---------- 1. Constants & helpers ---------- */

const DIR_RIGHT = 0;
const DIR_DOWN  = 1;
const DIR_LEFT  = 2;
const DIR_UP    = 3;
const DIR_DX = [1, 0, -1, 0];
const DIR_DY = [0, 1, 0, -1];
const SPEED_STEPS = [1, 2, 3, 5, 8, 13, 21, 34, 55];
const SPEED_MS = {
  1: 800,
  2: 400,
  3: 266,
  5: 160,
  8: 100,
  13: 62,
  21: 38,
  34: 24,
  55: 15,
};
const DIRECTION_PRIORITY = {
  [DIR_UP]: 4,     // N
  [DIR_RIGHT]: 3,  // E
  [DIR_DOWN]: 2,   // S
  [DIR_LEFT]: 1,   // W
};

const cellKey = (x, y) => `${x},${y}`;
const neighbor = (x, y, dir) => ({ x: x + DIR_DX[dir], y: y + DIR_DY[dir] });
const inBounds = (x, y, w, h) => x >= 0 && y >= 0 && x < w && y < h;

function isAbsorbArrivalVfxKind(kind) {
  return kind === 'OUT_ARRIVAL' || kind === 'DELETE_ARRIVAL' || kind === 'HOLD_CAPTURE';
}

/* ---------- 2. Component definitions ---------- */
/* Each component:
 *   - id, label, hasRotation, hasConfig, configKind ('char' | 'sink' | 'stream'), defaultConfig
 *   - drawShape(svg, cellPx, rotation, config, opts) — returns an SVG <g> string
 *   - act(tile, item, ctx) — called in the read phase if an item is on its cell.
 *       returns { emissions: [{char, dx, dy, fromTileId}], destroyed?: bool }
 *       (BELT/WRITE/COPY/IF/HOLD/DELETE/OUT). IN is handled separately.
 */

const COMPONENTS = {
  IN: {
    id: 'IN', label: 'IN',
    hasRotation: true, hasConfig: false,
    inputs: 0, outputs: 1,
    immovable: true,
  },
  OUT: {
    id: 'OUT', label: 'OUT',
    hasRotation: false, hasConfig: false,
    inputs: 1, outputs: 0,
    immovable: true,
    actOnTarget: true, // arrivals are absorbed in resolve phase
  },
  BELT: {
    id: 'BELT', label: '',
    hasRotation: true, hasConfig: false,
    inputs: 1, outputs: 1,
    act(tile, item) {
      return { emissions: [{ char: item.char, dir: tile.rotation, fromTileId: tile.id }] };
    },
  },
  WRITE: {
    id: 'WRITE', label: 'WRITE',
    hasRotation: true, hasConfig: true, configKind: 'char',
    defaultConfig: 'A',
    inputs: 1, outputs: 1,
    act(tile, item, ctx) {
      ctx.stats.totalWrites++;
      return { emissions: [{ char: tile.config, dir: tile.rotation, fromTileId: tile.id }] };
    },
  },
  DELETE: {
    id: 'DELETE', label: 'DEL',
    hasRotation: false, hasConfig: false,
    inputs: 1, outputs: 0,
    act(tile, item, ctx) {
      ctx.stats.totalDestroyed++;
      return { emissions: [], destroyed: true };
    },
  },
  COPY: {
    id: 'COPY', label: 'COPY',
    hasRotation: true, hasConfig: false,
    inputs: 1, outputs: 2,
    act(tile, item) {
      // outputs: rotation and (rotation + 1) % 4
      return { emissions: [
        { char: item.char, dir: tile.rotation,            fromTileId: tile.id },
        { char: item.char, dir: (tile.rotation + 1) % 4,  fromTileId: tile.id },
      ]};
    },
  },
  IF: {
    id: 'IF', label: 'IF',
    hasRotation: true, hasConfig: true, configKind: 'char',
    defaultConfig: 'A',
    inputs: 1, outputs: 2,
    act(tile, item) {
      // yes -> rotation; no -> (rotation + 1) % 4
      const dir = item.char === tile.config ? tile.rotation : (tile.rotation + 1) % 4;
      return { emissions: [{ char: item.char, dir, fromTileId: tile.id }] };
    },
  },
  HOLD: {
    id: 'HOLD', label: 'HOLD',
    hasRotation: true, hasConfig: false,
    inputs: 1, outputs: 1,
    hasInternalState: true,
    // HOLD logic is special-cased in the simulator: it both consumes
    // the item on its cell AND emits the previously-held char, in one tick.
  },
};

/* ---------- 3. Levels ---------- */

/* Each level:
 *   id, name, description?, gridW, gridH
 *   pre: [{kind, x, y, rotation, config}]
 *   streams: [{id, chars}]                    (input streams; IN tiles map by config)
 *   sinks: [{id, target}]                     (target output strings; OUT tiles map by config)
 *   palette: [componentId, ...]               (which components are placeable)
 */

const LEVELS = [
  {
    id: 'L1', name: 'PASS',
    description: 'Route the chars from IN to OUT unchanged.',
    gridW: 8, gridH: 6,
    pre: [
      { kind: 'IN',  x: 0, y: 2, rotation: DIR_RIGHT, config: 0 },
      { kind: 'OUT', x: 7, y: 2, rotation: 0,         config: 0 },
    ],
    streams: [{ id: 0, chars: 'DOG' }],
    sinks:   [{ id: 0, target: 'DOG' }],
    palette: ['BELT'],
  },
  {
    id: 'L2', name: 'SWAP',
    description: "Replace 'B' with 'C'; pass the rest through.",
    gridW: 10, gridH: 8,
    pre: [
      { kind: 'IN',  x: 0, y: 3, rotation: DIR_RIGHT, config: 0 },
      { kind: 'OUT', x: 9, y: 3, rotation: 0,         config: 0 },
    ],
    streams: [{ id: 0, chars: 'BAT' }],
    sinks:   [{ id: 0, target: 'CAT' }],
    palette: ['BELT', 'IF', 'WRITE'],
  },
  {
    id: 'L3', name: 'REVERSE',
    description: 'Output the input in reverse. Use IF to peel chars off; HOLDs to delay.',
    gridW: 12, gridH: 10,
    pre: [
      { kind: 'IN',  x: 0,  y: 4, rotation: DIR_RIGHT, config: 0 },
      { kind: 'OUT', x: 11, y: 4, rotation: 0,         config: 0 },
    ],
    streams: [{ id: 0, chars: 'FLY' }],
    sinks:   [{ id: 0, target: 'YLF' }],
    palette: ['BELT', 'HOLD', 'COPY', 'IF'],
  },
  {
    id: 'L4', name: 'FILTER',
    description: "Strip every 'X'. Keep the rest in order.",
    gridW: 12, gridH: 10,
    pre: [
      { kind: 'IN',  x: 0,  y: 4, rotation: DIR_RIGHT, config: 0 },
      { kind: 'OUT', x: 11, y: 4, rotation: 0,         config: 0 },
    ],
    streams: [{ id: 0, chars: 'AXBXCXDX' }],
    sinks:   [{ id: 0, target: 'ABCD' }],
    palette: ['BELT', 'IF', 'DELETE', 'HOLD'],
  },
  {
    id: 'L5', name: 'AMPLIFY',
    description: 'Build a long chant from a short seed.',
    gridW: 14, gridH: 12,
    pre: [
      { kind: 'IN',  x: 0,  y: 5, rotation: DIR_RIGHT, config: 0 },
      { kind: 'OUT', x: 13, y: 5, rotation: 0,         config: 0 },
    ],
    streams: [{ id: 0, chars: 'WIN' }],
    sinks:   [{ id: 0, target: 'WINWINWIN' }],
    palette: ['BELT', 'WRITE', 'COPY', 'HOLD', 'IF'],
  },
];

/* ---------- 4. State & mutations ---------- */

function createState(level) {
  const tiles = new Map(); // tileId -> tile
  const grid  = new Map(); // cellKey -> tileId
  let nextTileId = 1;

  for (const p of level.pre) {
    const tile = {
      id: nextTileId++,
      kind: p.kind,
      x: p.x, y: p.y,
      rotation: p.rotation || 0,
      config: p.config !== undefined ? p.config : (COMPONENTS[p.kind].defaultConfig || null),
      immovable: !!COMPONENTS[p.kind].immovable,
      held: null, // for HOLD
    };
    tiles.set(tile.id, tile);
    grid.set(cellKey(tile.x, tile.y), tile.id);
  }

  return {
    level,
    tiles,
    grid,
    nextTileId,
    items: [],          // {id, char, x, y, prevX, prevY, fromTileId}
    nextItemId: 1,
    streams: level.streams.map(s => ({ id: s.id, chars: s.chars, position: 0 })),
    sinks:   level.sinks.map(s => ({ id: s.id, target: s.target, output: '' })),
    sim: {
      running: false,
      tick: 0,
      speed: 1,
      timer: null,
      finished: false,
      vfx: [],
      historyPast: [],
      historyFuture: [],
    },
    stats: {
      maxItemsOnBoard: 0,
      totalCollisions: 0,
      totalDestroyed: 0,
      totalWrites: 0,
      distinctOut: new Set(),
    },
    ui: {
      brush: null,             // {kind, rotation}
      popoverTileId: null,
      configTileId: null,
      dragPaint: null,         // {lastCell}
      draggingTileId: null,
      hoverCell: null,         // {x, y}
      keyboardPaintKind: null, // component kind while palette hotkey is held
    },
    history: {
      past: [],
      future: [],
    },
  };
}

function tileAtCell(state, x, y) {
  const id = state.grid.get(cellKey(x, y));
  return id === undefined ? null : state.tiles.get(id);
}

function placeTile(state, kind, x, y, rotation, config) {
  if (!inBounds(x, y, state.level.gridW, state.level.gridH)) return null;
  if (state.grid.has(cellKey(x, y))) return null;
  const def = COMPONENTS[kind];
  const tile = {
    id: state.nextTileId++,
    kind, x, y,
    rotation: rotation || 0,
    config: config !== undefined ? config : (def.defaultConfig || null),
    immovable: false,
    held: null,
  };
  state.tiles.set(tile.id, tile);
  state.grid.set(cellKey(x, y), tile.id);
  return tile;
}

function deleteTile(state, tileId) {
  const tile = state.tiles.get(tileId);
  if (!tile || tile.immovable) return false;
  state.grid.delete(cellKey(tile.x, tile.y));
  state.tiles.delete(tileId);
  return true;
}

function moveTile(state, tileId, x, y) {
  const tile = state.tiles.get(tileId);
  if (!tile || tile.immovable) return false;
  if (!inBounds(x, y, state.level.gridW, state.level.gridH)) return false;
  if (state.grid.has(cellKey(x, y))) return false;
  state.grid.delete(cellKey(tile.x, tile.y));
  tile.x = x; tile.y = y;
  state.grid.set(cellKey(x, y), tileId);
  return true;
}

function rotateTile(state, tileId) {
  const tile = state.tiles.get(tileId);
  if (!tile) return;
  const def = COMPONENTS[tile.kind];
  if (!def.hasRotation || tile.immovable) return;
  tile.rotation = (tile.rotation + 1) % 4;
}

function setTileConfig(state, tileId, config) {
  const tile = state.tiles.get(tileId);
  if (!tile) return;
  tile.config = config;
}

function snapshotBoard(state) {
  return playerTiles(state)
    .sort((a, b) => a.id - b.id)
    .map(t => ({
      kind: t.kind,
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      config: t.config,
    }));
}

function sameBoardSnapshot(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.kind !== y.kind ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.rotation !== y.rotation ||
      x.config !== y.config
    ) {
      return false;
    }
  }
  return true;
}

function applyBoardSnapshot(state, board) {
  for (const t of [...state.tiles.values()]) {
    if (!t.immovable) deleteTile(state, t.id);
  }
  for (const t of board) {
    const placed = placeTile(state, t.kind, t.x, t.y, t.rotation, t.config);
    if (!placed) {
      console.error('[builder] Failed to restore a saved tile while applying board snapshot.', t);
    }
  }
}

function setPlayIdleLabel() {
  const btn = document.getElementById('btn-play');
  if (btn) btn.textContent = '▶ play [space]';
}

function setPlayRunningLabel() {
  const btn = document.getElementById('btn-play');
  if (btn) btn.textContent = 'pause [space]';
}

function stopSimulation(state) {
  if (state.sim.timer) {
    clearInterval(state.sim.timer);
    state.sim.timer = null;
  }
  state.sim.running = false;
}

function commitBoardEdit(state, beforeBoard) {
  const afterBoard = snapshotBoard(state);
  if (sameBoardSnapshot(beforeBoard, afterBoard)) return false;
  state.history.past.push(beforeBoard);
  state.history.future = [];
  Storage.saveBoardLayout(state.level.id, afterBoard);
  resetSim(state);
  setPlayIdleLabel();
  return true;
}

function undoBoardEdit(state) {
  if (state.history.past.length === 0) return false;
  const current = snapshotBoard(state);
  const previous = state.history.past.pop();
  state.history.future.push(current);
  applyBoardSnapshot(state, previous);
  Storage.saveBoardLayout(state.level.id, previous);
  resetSim(state);
  setPlayIdleLabel();
  return true;
}

function redoBoardEdit(state) {
  if (state.history.future.length === 0) return false;
  const current = snapshotBoard(state);
  const next = state.history.future.pop();
  state.history.past.push(current);
  applyBoardSnapshot(state, next);
  Storage.saveBoardLayout(state.level.id, next);
  resetSim(state);
  setPlayIdleLabel();
  return true;
}

function withBoardEdit(state, mutationFn) {
  const before = snapshotBoard(state);
  const changed = mutationFn();
  if (!changed) return false;
  return commitBoardEdit(state, before);
}

function resetSim(state) {
  stopSimulation(state);
  state.sim.tick = 0;
  state.sim.finished = false;
  state.sim.vfx = [];
  state.sim.historyPast = [];
  state.sim.historyFuture = [];
  state.items = [];
  state.nextItemId = 1;
  for (const s of state.streams) s.position = 0;
  for (const s of state.sinks)   s.output = '';
  for (const t of state.tiles.values()) t.held = null;
  state.stats = {
    maxItemsOnBoard: 0,
    totalCollisions: 0,
    totalDestroyed: 0,
    totalWrites: 0,
    distinctOut: new Set(),
  };
}

function playerTiles(state) {
  return [...state.tiles.values()].filter(t => !t.immovable);
}

function metrics(state) {
  const pl = playerTiles(state);
  let footprint = 0;
  if (pl.length > 0) {
    const xs = pl.map(t => t.x); const ys = pl.map(t => t.y);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    footprint = w * h;
  }
  return { cycles: state.sim.tick, components: pl.length, footprint };
}

function collisionDirectionPriority(dir) {
  return DIRECTION_PRIORITY[dir] || 0;
}

function tokenAnimMs(state) {
  return SPEED_MS[state.sim.speed] || 600;
}

function cloneItems(items) {
  return items.map(item => ({ ...item }));
}

function resolveNextItems(state, oldItems, winners) {
  const pool = oldItems.map(item => ({ ...item }));
  const next = [];
  for (const w of winners) {
    const hasDir = typeof w.sourceDir === 'number' && w.sourceDir >= 0;
    const pred = hasDir
      ? { x: w.x - DIR_DX[w.sourceDir], y: w.y - DIR_DY[w.sourceDir] }
      : null;

    let id;
    let prevX = null;
    let prevY = null;

    if (pred) {
      const idx = pool.findIndex(
        item => item.char === w.char && item.x === pred.x && item.y === pred.y,
      );
      if (idx >= 0) {
        const chosen = pool.splice(idx, 1)[0];
        id = chosen.id;
        prevX = pred.x;
        prevY = pred.y;
      } else {
        id = state.nextItemId++;
        const emitter = [...state.tiles.values()].find(t => t.id === w.fromTileId);
        if (emitter && emitter.kind === 'IN') {
          prevX = emitter.x;
          prevY = emitter.y;
        } else if (emitter && emitter.kind === 'HOLD') {
          prevX = emitter.x;
          prevY = emitter.y;
        } else {
          prevX = pred.x;
          prevY = pred.y;
        }
      }
    } else {
      const idx = pool.findIndex(
        item => item.char === w.char && item.x === w.x && item.y === w.y,
      );
      if (idx >= 0) {
        const chosen = pool.splice(idx, 1)[0];
        id = chosen.id;
        prevX = w.x;
        prevY = w.y;
      } else {
        id = state.nextItemId++;
        prevX = w.x;
        prevY = w.y;
      }
    }

    const emitterForPrev = [...state.tiles.values()].find(t => t.id === w.fromTileId);
    if (emitterForPrev && emitterForPrev.kind === 'HOLD') {
      const outCell = neighbor(emitterForPrev.x, emitterForPrev.y, emitterForPrev.rotation);
      if (w.x === outCell.x && w.y === outCell.y) {
        prevX = emitterForPrev.x;
        prevY = emitterForPrev.y;
      }
    }

    next.push({
      id,
      char: w.char,
      x: w.x,
      y: w.y,
      prevX,
      prevY,
      fromTileId: w.fromTileId,
      sourceDir: w.sourceDir,
    });
  }
  return next;
}

function captureSimSnapshot(state) {
  const heldByTileId = {};
  for (const tile of state.tiles.values()) {
    if (tile.kind === 'HOLD') heldByTileId[tile.id] = tile.held;
  }
  return {
    tick: state.sim.tick,
    finished: state.sim.finished,
    items: cloneItems(state.items),
    nextItemId: state.nextItemId,
    streams: state.streams.map(s => ({ id: s.id, position: s.position })),
    sinks: state.sinks.map(s => ({ id: s.id, output: s.output })),
    heldByTileId,
    stats: {
      maxItemsOnBoard: state.stats.maxItemsOnBoard,
      totalCollisions: state.stats.totalCollisions,
      totalDestroyed: state.stats.totalDestroyed,
      totalWrites: state.stats.totalWrites,
      distinctOut: [...state.stats.distinctOut],
    },
  };
}

function restoreSimSnapshot(state, snap) {
  state.sim.tick = snap.tick;
  state.sim.finished = snap.finished;
  state.sim.vfx = [];
  state.items = cloneItems(snap.items);
  state.nextItemId = snap.nextItemId;
  for (const stream of state.streams) {
    const source = snap.streams.find(s => s.id === stream.id);
    if (!source) continue;
    stream.position = source.position;
  }
  for (const sink of state.sinks) {
    const source = snap.sinks.find(s => s.id === sink.id);
    if (!source) continue;
    sink.output = source.output;
  }
  for (const tile of state.tiles.values()) {
    if (tile.kind !== 'HOLD') continue;
    tile.held = Object.prototype.hasOwnProperty.call(snap.heldByTileId, tile.id)
      ? snap.heldByTileId[tile.id]
      : null;
  }
  state.stats = {
    maxItemsOnBoard: snap.stats.maxItemsOnBoard,
    totalCollisions: snap.stats.totalCollisions,
    totalDestroyed: snap.stats.totalDestroyed,
    totalWrites: snap.stats.totalWrites,
    distinctOut: new Set(snap.stats.distinctOut),
  };
}

function arrivalWins(a, b) {
  if (a.fromTileId !== b.fromTileId) return a.fromTileId > b.fromTileId;
  return collisionDirectionPriority(a.sourceDir) > collisionDirectionPriority(b.sourceDir);
}

function outputCellIsClear(state, x, y) {
  if (!inBounds(x, y, state.level.gridW, state.level.gridH)) return false;
  return !state.items.some(item => item.x === x && item.y === y);
}

/* ---------- 5. Simulator ---------- */

function pushAbsorbVfxFromItem(state, kind, item, absorbX, absorbY) {
  const hasPrev = item.prevX != null && item.prevY != null;
  const moved = hasPrev && (item.prevX !== absorbX || item.prevY !== absorbY);
  const fromX = moved ? item.prevX : absorbX;
  const fromY = moved ? item.prevY : absorbY;
  state.sim.vfx.push({
    kind,
    char: item.char,
    fromX,
    fromY,
    toX: absorbX,
    toY: absorbY,
    moved,
  });
}

/** Merge-phase or stationary absorb: OUT / DELETE / (shared geometry for HOLD capture uses pushAbsorbVfxFromItem). */
function pushArrivalAbsorbVfx(state, kind, winner, oldItems) {
  const hasDir = typeof winner.sourceDir === 'number' && winner.sourceDir >= 0;
  const pred = hasDir
    ? { x: winner.x - DIR_DX[winner.sourceDir], y: winner.y - DIR_DY[winner.sourceDir] }
    : null;

  let fromX = winner.x;
  let fromY = winner.y;
  let moved = false;

  if (pred && inBounds(pred.x, pred.y, state.level.gridW, state.level.gridH)) {
    const idx = oldItems.findIndex(
      it => it.char === winner.char && it.x === pred.x && it.y === pred.y,
    );
    if (idx >= 0) {
      fromX = pred.x;
      fromY = pred.y;
      moved = true;
    } else {
      const emitter = [...state.tiles.values()].find(t => t.id === winner.fromTileId);
      if (emitter && emitter.kind === 'IN') {
        fromX = emitter.x;
        fromY = emitter.y;
        moved = true;
      } else if (emitter && emitter.kind === 'HOLD') {
        fromX = emitter.x;
        fromY = emitter.y;
        moved = true;
      } else {
        fromX = pred.x;
        fromY = pred.y;
        moved = true;
      }
    }
  } else if (pred && !inBounds(pred.x, pred.y, state.level.gridW, state.level.gridH)) {
    const emitter = [...state.tiles.values()].find(t => t.id === winner.fromTileId);
    if (emitter && emitter.kind === 'IN') {
      fromX = emitter.x;
      fromY = emitter.y;
      moved = true;
    } else if (emitter && emitter.kind === 'HOLD') {
      fromX = emitter.x;
      fromY = emitter.y;
      moved = true;
    } else {
      fromX = winner.x;
      fromY = winner.y;
      moved = false;
    }
  }

  state.sim.vfx.push({
    kind,
    char: winner.char,
    fromX,
    fromY,
    toX: winner.x,
    toY: winner.y,
    moved,
  });
}

function step(state) {
  if (state.sim.finished) return;
  const { level, tiles, items, sinks, streams, stats } = state;
  state.sim.vfx = [];

  // emissions: array of { char, x, y, fromTileId, sourceDir }
  const emissions = [];
  const ctx = { stats };

  // 5a. IN tiles emit fresh chars
  for (const tile of tiles.values()) {
    if (tile.kind !== 'IN') continue;
    const stream = streams.find(s => s.id === tile.config);
    if (!stream) continue;
    if (stream.position >= stream.chars.length) continue;
    const char = stream.chars[stream.position++];
    const t = neighbor(tile.x, tile.y, tile.rotation);
    emissions.push({ char, x: t.x, y: t.y, fromTileId: tile.id, sourceDir: tile.rotation });
  }

  // 5b. Process every item on the board through whatever tile is under it
  const carriedOver = []; // items on cells that don't act on them
  for (const item of items) {
    const tile = tileAtCell(state, item.x, item.y);
    if (!tile) {
      // No tile -> item stays in place
      carriedOver.push({ char: item.char, x: item.x, y: item.y, fromTileId: item.fromTileId, sourceDir: -1 });
      continue;
    }
    if (tile.kind === 'IN') {
      // an item collided with an IN's own cell: destroy it
      stats.totalDestroyed++;
      continue;
    }
    if (tile.kind === 'HOLD') {
      // HOLD: release only if output cell is clear this tick.
      const out = neighbor(tile.x, tile.y, tile.rotation);
      if (tile.held !== null && outputCellIsClear(state, out.x, out.y)) {
        const t = neighbor(tile.x, tile.y, tile.rotation);
        emissions.push({ char: tile.held, x: t.x, y: t.y, fromTileId: tile.id, sourceDir: tile.rotation });
        tile.held = null;
      }
      // HOLD has capacity 1. If still occupied, the incoming item is dropped.
      // This prevents newer chars from overwriting buffered chars.
      if (tile.held === null) {
        pushAbsorbVfxFromItem(state, 'HOLD_CAPTURE', item, tile.x, tile.y);
        tile.held = item.char;
      } else {
        pushAbsorbVfxFromItem(state, 'DELETE_ARRIVAL', item, tile.x, tile.y);
        stats.totalDestroyed++;
      }
      continue;
    }
    const def = COMPONENTS[tile.kind];
    if (!def || !def.act) {
      // OUT or unknown: handled in resolve as "destination"
      // If item lands on an OUT cell (already there), absorb it.
      if (tile.kind === 'OUT') {
        pushArrivalAbsorbVfx(state, 'OUT_ARRIVAL', {
          char: item.char,
          x: item.x,
          y: item.y,
          fromTileId: item.fromTileId,
          sourceDir: -1,
        }, items);
        const sink = sinks.find(s => s.id === tile.config);
        if (sink) sink.output += item.char;
        stats.distinctOut.add(item.char);
        continue;
      }
      carriedOver.push({ char: item.char, x: item.x, y: item.y, fromTileId: item.fromTileId, sourceDir: -1 });
      continue;
    }
    const result = def.act(tile, item, ctx);
    if (tile.kind === 'DELETE' && result.destroyed) {
      pushAbsorbVfxFromItem(state, 'DELETE_ARRIVAL', item, tile.x, tile.y);
    }
    for (const e of result.emissions) {
      const t = neighbor(tile.x, tile.y, e.dir);
      emissions.push({ char: e.char, x: t.x, y: t.y, fromTileId: e.fromTileId, sourceDir: e.dir });
    }
  }

  // 5c. Also: HOLD tiles whose cell is empty but still have a held char should emit it.
  for (const tile of tiles.values()) {
    if (tile.kind !== 'HOLD' || tile.held === null) continue;
    // Was an item processed on this cell this tick? If so, the held char was already emitted above.
    const itemWasHere = items.some(i => i.x === tile.x && i.y === tile.y);
    if (itemWasHere) continue;
    // Emit held only when output cell is clear.
    const t = neighbor(tile.x, tile.y, tile.rotation);
    if (outputCellIsClear(state, t.x, t.y)) {
      emissions.push({ char: tile.held, x: t.x, y: t.y, fromTileId: tile.id, sourceDir: tile.rotation });
      tile.held = null;
    }
  }

  // 5d. Combine carried-over items + emissions, resolve per-cell collisions,
  //     absorb arrivals at OUT cells.
  const allArrivals = [...emissions, ...carriedOver];
  const byCell = new Map();
  for (const e of allArrivals) {
    if (!inBounds(e.x, e.y, level.gridW, level.gridH)) {
      stats.totalDestroyed++;
      continue;
    }
    const k = cellKey(e.x, e.y);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(e);
  }

  const winnerItems = [];
  for (const [k, list] of byCell) {
    let winner;
    if (list.length === 1) {
      winner = list[0];
    } else {
      stats.totalCollisions++;
      stats.totalDestroyed += list.length - 1;
      // Highest fromTileId wins; ties resolve by direction (N > E > S > W).
      winner = list.reduce((a, b) => (arrivalWins(b, a) ? b : a));
    }
    const tile = tileAtCell(state, winner.x, winner.y);
    if (tile && tile.kind === 'OUT') {
      pushArrivalAbsorbVfx(state, 'OUT_ARRIVAL', winner, items);
      const sink = sinks.find(s => s.id === tile.config);
      if (sink) sink.output += winner.char;
      stats.distinctOut.add(winner.char);
      continue;
    }
    if (tile && tile.kind === 'DELETE') {
      pushArrivalAbsorbVfx(state, 'DELETE_ARRIVAL', winner, items);
      stats.totalDestroyed++;
      continue;
    }
    winnerItems.push({
      char: winner.char,
      x: winner.x,
      y: winner.y,
      fromTileId: winner.fromTileId,
      sourceDir: winner.sourceDir,
    });
  }

  state.items = resolveNextItems(state, items, winnerItems);
  state.sim.tick++;
  if (state.items.length > stats.maxItemsOnBoard) stats.maxItemsOnBoard = state.items.length;

  // 5e. Win check: all streams exhausted + no items on board + no HOLDs holding
  const streamsDone = streams.every(s => s.position >= s.chars.length);
  const boardEmpty  = state.items.length === 0;
  const holdsEmpty  = [...tiles.values()].every(t => t.kind !== 'HOLD' || t.held === null);
  if (streamsDone && boardEmpty && holdsEmpty) {
    const allMatch = sinks.every(s => s.output === s.target);
    state.sim.finished = true;
    stopSimulation(state);
    return { won: allMatch };
  }
  // Failure detection: any sink already mismatches its target prefix
  for (const s of sinks) {
    if (s.output.length > s.target.length) {
      state.sim.finished = true;
      stopSimulation(state);
      return { won: false };
    }
    if (!s.target.startsWith(s.output)) {
      state.sim.finished = true;
      stopSimulation(state);
      return { won: false };
    }
  }
  // Stuck detection: streams done, no items, but holds still hold things that never come out -- handled above.
  // Stuck if streams done, no new emissions possible: skipped for V1.
  return null;
}

/* ---------- 6. Renderer ---------- */

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

function cellPx() { return 72; }

function rotationTransform(rotation, cx, cy) {
  const deg = rotation * 90;
  return `rotate(${deg} ${cx} ${cy})`;
}

function drawTileShape(tile, opts) {
  const cp = cellPx();
  const cx = cp / 2, cy = cp / 2;
  // Place arrow tips at the inner frame edge (frame rect is inset by 4px on each side).
  const arrowTip = cp / 2 - 4;
  const beltShaftInner = arrowTip - 10;
  const isGhost = opts && opts.ghost;
  const klassFrame = isGhost ? 'ghost-frame' : 'tile-frame' + (tile.immovable ? ' fixed' : '');
  const klassArrow = isGhost ? 'ghost-arrow' : 'tile-arrow';
  const klassLabel = isGhost ? 'tile-label ghost-label' : 'tile-label';

  const g = svg('g', null);
  // Frame
  g.appendChild(svg('rect', { x: 4, y: 4, width: cp - 8, height: cp - 8, class: klassFrame }));

  switch (tile.kind) {
    case 'IN': {
      // Half-disc on the input side, arrow leaving in rotation direction
      const r = cp * 0.32;
      g.appendChild(svg('circle', { cx, cy, r, class: klassFrame }));
      g.appendChild(svg('circle', { cx, cy, r: r - 6, class: 'tile-stroke' }));
      g.appendChild(svg('text', { x: cx, y: cy - 1, class: klassLabel + ' tile-label-large' }, 'IN'));
      const tri = drawArrowTri(cx + arrowTip, cy, klassArrow);
      tri.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(tri);
      break;
    }
    case 'OUT': {
      const r = cp * 0.32;
      g.appendChild(svg('circle', { cx, cy, r, class: klassFrame }));
      g.appendChild(svg('circle', { cx, cy, r: r - 7, class: 'tile-stroke' }));
      g.appendChild(svg('text', { x: cx, y: cy - 1, class: klassLabel + ' tile-label-large' }, 'OUT'));
      break;
    }
    case 'BELT': {
      const tri = drawArrowTri(cx + arrowTip, cy, klassArrow);
      tri.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(tri);
      // a thin shaft line
      const shaft = svg('line', {
        x1: cx - beltShaftInner, y1: cy, x2: cx + arrowTip - 1, y2: cy,
        class: 'tile-stroke',
        transform: rotationTransform(tile.rotation, cx, cy),
      });
      g.appendChild(shaft);
      break;
    }
    case 'WRITE': {
      // Square with a triangle output
      const tri = drawArrowTri(cx + arrowTip, cy, klassArrow);
      tri.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(tri);
      g.appendChild(svg('text', { x: cx, y: cy - 6, class: klassLabel }, 'WRITE'));
      const c = (tile.config != null) ? String(tile.config) : '?';
      g.appendChild(svg('text', { x: cx, y: cy + 8, class: klassLabel + ' tile-label-large' }, glyphForChar(c)));
      break;
    }
    case 'DELETE': {
      // X mark
      const off = cp * 0.18;
      g.appendChild(svg('line', { x1: cx - off, y1: cy - off, x2: cx + off, y2: cy + off, class: 'tile-stroke' }));
      g.appendChild(svg('line', { x1: cx + off, y1: cy - off, x2: cx - off, y2: cy + off, class: 'tile-stroke' }));
      g.appendChild(svg('text', { x: cx, y: cy + cp * 0.32, class: klassLabel }, 'DEL'));
      break;
    }
    case 'COPY': {
      // T-shape: trunk in rotation dir, arm in (rotation+1)
      const armDir = (tile.rotation + 1) % 4;
      const trunkArrow = drawArrowTri(cx + arrowTip, cy, klassArrow);
      trunkArrow.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(trunkArrow);
      const armArrow = drawArrowTri(cx + arrowTip, cy, klassArrow);
      armArrow.setAttribute('transform', rotationTransform(armDir, cx, cy));
      g.appendChild(armArrow);
      g.appendChild(svg('text', { x: cx, y: cy + cp * 0.02, class: klassLabel }, 'COPY'));
      break;
    }
    case 'IF': {
      // Two outputs like COPY but labelled with predicate
      const armDir = (tile.rotation + 1) % 4;
      const trunkArrow = drawArrowTri(cx + arrowTip, cy, klassArrow);
      trunkArrow.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(trunkArrow);
      const armArrow = drawArrowTri(cx + arrowTip, cy, klassArrow);
      armArrow.setAttribute('transform', rotationTransform(armDir, cx, cy));
      g.appendChild(armArrow);
      g.appendChild(svg('text', { x: cx, y: cy - 6, class: klassLabel }, 'IF'));
      const c = (tile.config != null) ? String(tile.config) : '?';
      g.appendChild(svg('text', { x: cx, y: cy + 8, class: klassLabel + ' tile-label-large' }, glyphForChar(c)));
      break;
    }
    case 'HOLD': {
      // Square frame with a small inner square (the "buffer")
      const sz = cp * 0.32;
      g.appendChild(svg('rect', {
        x: cx - sz / 2, y: cy - sz / 2,
        width: sz, height: sz,
        class: 'tile-stroke',
      }));
      const tri = drawArrowTri(cx + arrowTip, cy, klassArrow);
      tri.setAttribute('transform', rotationTransform(tile.rotation, cx, cy));
      g.appendChild(tri);
      g.appendChild(svg('text', { x: cx, y: cy + cp * 0.32, class: klassLabel }, 'HOLD'));
      if (tile.held !== null) {
        g.appendChild(svg('circle', { cx, cy, r: cp * 0.17, class: 'held-badge' }));
        g.appendChild(svg('text', { x: cx, y: cy, class: 'held-glyph' }, glyphForChar(tile.held)));
      }
      break;
    }
  }
  return g;
}

function drawArrowTri(tipX, tipY, klass) {
  const sz = 6;
  const path = svg('polygon', {
    points: `${tipX},${tipY} ${tipX - sz - 1},${tipY - sz} ${tipX - sz - 1},${tipY + sz}`,
    class: klass,
  });
  return path;
}

function glyphForChar(c) {
  if (c === ' ') return '␣';
  return c;
}

function svgClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function svgTranslate(x, y) {
  return `translate(${x} ${y})`;
}

function cellTopLeftPx(cp, x, y) {
  return { x: x * cp, y: y * cp };
}

function cellCenterPx(cp, x, y) {
  return { x: x * cp + cp / 2, y: y * cp + cp / 2 };
}

function assertItemCellsHaveTiles(state, item) {
  if (!tileAtCell(state, item.x, item.y)) {
    console.error('[builder] Item sits on a cell without a tile.', item);
  }
  if (item.prevX != null && item.prevY != null && !tileAtCell(state, item.prevX, item.prevY)) {
    console.error('[builder] Item animation anchor (prev) is not a tiled cell.', item);
  }
}

function itemsRenderSignature(state) {
  // Used to avoid rebuilding the items layer on unrelated UI renders (hover, popovers).
  const parts = [];
  parts.push(String(state.sim.tick));
  for (const v of state.sim.vfx || []) {
    parts.push(`${v.kind}:${v.char}:${v.fromX},${v.fromY}->${v.toX},${v.toY}:${v.moved ? '1' : '0'}`);
  }
  for (const it of state.items) {
    parts.push(
      `${it.id}:${it.char}:${it.x},${it.y}:${it.prevX ?? ''},${it.prevY ?? ''}`,
    );
  }
  return parts.join('|');
}

function ensureBoardLayers(hostBoard) {
  let layerGrid = hostBoard.querySelector('#layer-grid');
  let layerTiles = hostBoard.querySelector('#layer-tiles');
  let layerHover = hostBoard.querySelector('#layer-hover');
  let layerItems = hostBoard.querySelector('#layer-items');

  if (layerGrid && layerTiles && layerHover && layerItems) {
    return { layerGrid, layerTiles, layerHover, layerItems };
  }

  hostBoard.textContent = '';
  layerGrid = svg('g', { id: 'layer-grid' });
  layerTiles = svg('g', { id: 'layer-tiles' });
  layerHover = svg('g', { id: 'layer-hover' });
  layerItems = svg('g', { id: 'layer-items' });
  hostBoard.appendChild(layerGrid);
  hostBoard.appendChild(layerTiles);
  hostBoard.appendChild(layerHover);
  hostBoard.appendChild(layerItems);
  return { layerGrid, layerTiles, layerHover, layerItems };
}

function renderGridDots(layerGrid, state, cp) {
  for (let y = 0; y <= state.level.gridH; y++) {
    for (let x = 0; x <= state.level.gridW; x++) {
      layerGrid.appendChild(svg('circle', { cx: x * cp, cy: y * cp, r: 1.8, class: 'cell-dot' }));
    }
  }
}

function renderTiles(layerTiles, state, cp) {
  for (const tile of state.tiles.values()) {
    const g = drawTileShape(tile, {});
    const p = cellTopLeftPx(cp, tile.x, tile.y);
    g.setAttribute('transform', svgTranslate(p.x, p.y));
    g.dataset && (g.dataset.tileId = String(tile.id));
    g.setAttribute('data-tile-id', String(tile.id));
    if (state.ui.popoverTileId === tile.id) {
      const frame = g.querySelector('.tile-frame');
      if (frame) frame.classList.add('popover-target');
    }
    layerTiles.appendChild(g);
  }
}

function renderHover(layerHover, state, cp) {
  if (!state.ui.hoverCell) return;
  const { x, y } = state.ui.hoverCell;
  if (!inBounds(x, y, state.level.gridW, state.level.gridH)) return;

  const existing = tileAtCell(state, x, y);
  if (!existing && state.ui.brush) {
    const ghostTile = {
      id: 0,
      kind: state.ui.brush.kind,
      x,
      y,
      rotation: state.ui.brush.rotation,
      config: state.ui.brush.config,
      immovable: false,
      held: null,
    };
    const g = drawTileShape(ghostTile, { ghost: true });
    const p = cellTopLeftPx(cp, x, y);
    g.setAttribute('transform', svgTranslate(p.x, p.y));
    layerHover.appendChild(g);
    return;
  }

  if (existing) {
    layerHover.appendChild(svg('rect', {
      x: x * cp + 3,
      y: y * cp + 3,
      width: cp - 6,
      height: cp - 6,
      class: 'hover-occupied',
    }));
  }
}

function renderItems(layerItems, state, cp, tickMs) {
  const half = Math.max(1, Math.floor(tickMs / 2));
  for (const item of state.items) {
    assertItemCellsHaveTiles(state, item);

    const to = cellCenterPx(cp, item.x, item.y);
    const hasPrev = item.prevX != null && item.prevY != null;
    const from = hasPrev ? cellCenterPx(cp, item.prevX, item.prevY) : to;
    const moved = hasPrev && (item.prevX !== item.x || item.prevY !== item.y);
    const prevTile = hasPrev ? tileAtCell(state, item.prevX, item.prevY) : null;
    const spawnFromIn = prevTile && prevTile.kind === 'IN' && (moved || (item.prevX === item.x && item.prevY === item.y));
    const spawnFromHold = prevTile && prevTile.kind === 'HOLD' && (moved || (item.prevX === item.x && item.prevY === item.y));
    const toTile = tileAtCell(state, item.x, item.y);
    const despawnToOut = toTile && toTile.kind === 'OUT' && (moved || (item.prevX === item.x && item.prevY === item.y));

    const g = svg('g', { class: 'item-group', 'data-item-id': String(item.id) });
    g.appendChild(svg('circle', { cx: 0, cy: 0, r: cp * 0.30, class: 'item-circle' }));
    g.appendChild(svg('text', { x: 0, y: 1, class: 'item-glyph' }, glyphForChar(item.char)));
    layerItems.appendChild(g);

    // Animate via CSS `transform` (translate + scale) in pixel units.
    // transform-origin is the token's local origin (0,0), i.e. the cell center after translate().
    g.setAttribute('transform', '');
    g.style.transition = 'none';
    g.style.transformOrigin = '0px 0px';

    if (spawnFromIn || spawnFromHold) {
      // Spawn: first half tick scales up at IN/HOLD center; second half tick moves to next cell center.
      g.style.transform = `translate(${from.x}px, ${from.y}px) scale(0)`;
      requestAnimationFrame(() => {
        g.style.transition = `transform ${half}ms linear`;
        g.style.transform = `translate(${from.x}px, ${from.y}px) scale(1)`;
      });
      if (moved) {
        setTimeout(() => {
          g.style.transition = `transform ${half}ms linear`;
          g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
        }, half);
      }
      continue;
    }

    if (despawnToOut) {
      if (moved) {
        // (a) despawn: first half tick moves to OUT center; second half tick scales down at OUT center.
        g.style.transform = `translate(${from.x}px, ${from.y}px) scale(1)`;
        requestAnimationFrame(() => {
          g.style.transition = `transform ${half}ms linear`;
          g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
        });
        setTimeout(() => {
          g.style.transition = `transform ${half}ms linear`;
          g.style.transform = `translate(${to.x}px, ${to.y}px) scale(0)`;
        }, half);
      } else {
        // Absorbed while already sitting on OUT: scale down in place for the full tick.
        g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
        requestAnimationFrame(() => {
          g.style.transition = `transform ${tickMs}ms linear`;
          g.style.transform = `translate(${to.x}px, ${to.y}px) scale(0)`;
        });
      }
      continue;
    }

    // (b) normal move: smooth translate between two cell centers (no scale).
    g.style.transform = `translate(${from.x}px, ${from.y}px) scale(1)`;
    if (moved) {
      requestAnimationFrame(() => {
        g.style.transition = `transform ${tickMs}ms linear`;
        g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
      });
    } else {
      g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
    }
  }

  for (const v of state.sim.vfx || []) {
    if (!isAbsorbArrivalVfxKind(v.kind)) continue;
    const from = cellCenterPx(cp, v.fromX, v.fromY);
    const to = cellCenterPx(cp, v.toX, v.toY);

    const g = svg('g', { class: 'item-group item-vfx' });
    g.appendChild(svg('circle', { cx: 0, cy: 0, r: cp * 0.30, class: 'item-circle' }));
    g.appendChild(svg('text', { x: 0, y: 1, class: 'item-glyph' }, glyphForChar(v.char)));
    layerItems.appendChild(g);

    g.setAttribute('transform', '');
    g.style.transition = 'none';
    g.style.transformOrigin = '0px 0px';

    if (v.moved) {
      g.style.transform = `translate(${from.x}px, ${from.y}px) scale(1)`;
      requestAnimationFrame(() => {
        g.style.transition = `transform ${half}ms linear`;
        g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
      });
      setTimeout(() => {
        g.style.transition = `transform ${half}ms linear`;
        g.style.transform = `translate(${to.x}px, ${to.y}px) scale(0)`;
      }, half);
    } else {
      g.style.transform = `translate(${to.x}px, ${to.y}px) scale(1)`;
      requestAnimationFrame(() => {
        g.style.transition = `transform ${tickMs}ms linear`;
        g.style.transform = `translate(${to.x}px, ${to.y}px) scale(0)`;
      });
    }
  }
}

function renderBoard(state, hostBoard) {
  const cp = cellPx();
  const w = state.level.gridW * cp;
  const h = state.level.gridH * cp;
  hostBoard.setAttribute('width',  w);
  hostBoard.setAttribute('height', h);
  hostBoard.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const tickMs = tokenAnimMs(state);

  const sig = itemsRenderSignature(state);
  const prevSig = hostBoard.dataset.itemsSig || '';

  const { layerGrid, layerTiles, layerHover, layerItems } = ensureBoardLayers(hostBoard);

  svgClear(layerGrid);
  svgClear(layerTiles);
  svgClear(layerHover);
  if (sig !== prevSig) {
    svgClear(layerItems);
    hostBoard.dataset.itemsSig = sig;
  }

  renderGridDots(layerGrid, state, cp);
  renderTiles(layerTiles, state, cp);
  renderHover(layerHover, state, cp);

  // Items: token transforms are ALWAYS cell centers: (x + 0.5) * cp.
  // Between ticks, we only interpolate between two cell centers (prev -> current).
  if (sig !== prevSig) {
    renderItems(layerItems, state, cp, tickMs);
  }
}

/* ---------- 7. Input (mouse) ---------- */

let APP = null; // singleton
let BOARD_INPUT_ATTACHED = false;

function attachBoardInput(boardEl) {
  boardEl.addEventListener('contextmenu', e => e.preventDefault());

  boardEl.addEventListener('mousedown', e => {
    const cell = cellFromEvent(boardEl, e);
    if (!cell) return;
    APP.state.ui.hoverCell = { x: cell.x, y: cell.y };
    const tile = tileAtCell(APP.state, cell.x, cell.y);

    if (e.button === 2) {
      // right click: rotate placed tile
      if (tile && !tile.immovable) {
        rotateHoveredTile();
        APP.state.ui.popoverTileId = null;
        APP.render();
      }
      return;
    }

    if (e.button !== 0) return;

    // Clicking a placed (non-immovable) tile opens drag-or-popover even when a brush is active.
    if (tile) {
      // Set up a candidate drag: if mouse moves > threshold, drag-move; otherwise popover
      const startX = e.clientX, startY = e.clientY;
      let dragged = false;
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) > 6) {
          if (!tile.immovable) {
            dragged = true;
            APP.state.ui.draggingTileId = tile.id;
            document.getElementById('trash').classList.add('armed');
            APP.render();
          }
        }
      };
      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.getElementById('trash').classList.remove('armed');
        if (!dragged) {
          // popover
          openPopover(tile);
        } else {
          // drop
          const dropCell = cellFromEvent(boardEl, ev);
          const trash = document.getElementById('trash');
          const r = trash.getBoundingClientRect();
          const overTrash = ev.clientX >= r.left && ev.clientX <= r.right
                          && ev.clientY >= r.top  && ev.clientY <= r.bottom;
          withBoardEdit(APP.state, () => {
            if (overTrash) return deleteTile(APP.state, tile.id);
            if (dropCell && !(dropCell.x === tile.x && dropCell.y === tile.y)) {
              return moveTile(APP.state, tile.id, dropCell.x, dropCell.y);
            }
            return false;
          });
          APP.state.ui.draggingTileId = null;
          APP.state.ui.popoverTileId = null;
          APP.render();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    // Brush active -> placement
    if (APP.state.ui.brush && !tile) {
      placeWithBrushAtCell(cell);
      // Begin drag-paint for BELT
      if (APP.state.ui.brush.kind === 'BELT') {
        APP.state.ui.dragPaint = { lastCell: cell };
        const onMove = (ev) => {
          const c = cellFromEvent(boardEl, ev);
          if (!c) return;
          const last = APP.state.ui.dragPaint.lastCell;
          if (c.x === last.x && c.y === last.y) return;
          // determine direction from last to c (must be adjacent)
          const dx = c.x - last.x, dy = c.y - last.y;
          if (Math.abs(dx) + Math.abs(dy) !== 1) return;
          const dir = dx === 1 ? DIR_RIGHT
                    : dx === -1 ? DIR_LEFT
                    : dy === 1 ? DIR_DOWN
                    : DIR_UP;
          // also rotate the previous tile to point in this dir if it's a BELT
          const lastTile = tileAtCell(APP.state, last.x, last.y);
          if (lastTile && lastTile.kind === 'BELT' && !lastTile.immovable) {
            withBoardEdit(APP.state, () => {
              lastTile.rotation = dir;
              return true;
            });
          }
          // place a new BELT here with same dir (if cell is empty)
          withBoardEdit(APP.state, () => {
            if (tileAtCell(APP.state, c.x, c.y)) return false;
            return !!placeTile(APP.state, 'BELT', c.x, c.y, dir, null);
          });
          APP.state.ui.dragPaint.lastCell = c;
          APP.render();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          APP.state.ui.dragPaint = null;
          APP.render();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
      APP.render();
    }
  });

  boardEl.addEventListener('mousemove', e => {
    const cell = cellFromEvent(boardEl, e);
    const prev = APP.state.ui.hoverCell;
    const changed = (!prev && !!cell) || (!!prev && !cell) || (prev && cell && (prev.x !== cell.x || prev.y !== cell.y));
    if (cell && prev && APP.state.ui.keyboardPaintKind) {
      paintWithBrushAlongHoverPath(prev, cell);
    } else if (cell && !prev && APP.state.ui.keyboardPaintKind) {
      placeWithBrushAtHover();
    }
    APP.state.ui.hoverCell = cell;
    if (changed) APP.render();
  });

  boardEl.addEventListener('mouseleave', () => {
    if (APP.state.ui.hoverCell) {
      APP.state.ui.hoverCell = null;
      APP.state.ui.keyboardPaintKind = null;
      APP.render();
    }
  });

}

function cellFromEvent(boardEl, ev) {
  const ctm = boardEl.getScreenCTM();
  if (!ctm) return null;
  const svgPoint = boardEl.createSVGPoint();
  svgPoint.x = ev.clientX;
  svgPoint.y = ev.clientY;
  const localPoint = svgPoint.matrixTransform(ctm.inverse());
  const cp = cellPx();
  const x = Math.floor(localPoint.x / cp);
  const y = Math.floor(localPoint.y / cp);
  if (!inBounds(x, y, APP.state.level.gridW, APP.state.level.gridH)) return null;
  return { x, y };
}

function selectBrushForKind(kind) {
  const def = COMPONENTS[kind];
  const ui = APP.state.ui;
  if (ui.brush && ui.brush.kind === kind) return;
  ui.brush = {
    kind,
    rotation: 0,
    config: def.defaultConfig || null,
  };
}

function placeWithBrushAtHover() {
  const b = APP.state.ui.brush;
  const hover = APP.state.ui.hoverCell;
  if (!b || !hover) return false;
  if (!inBounds(hover.x, hover.y, APP.state.level.gridW, APP.state.level.gridH)) return false;

  const existing = tileAtCell(APP.state, hover.x, hover.y);
  if (existing) return false;
  return withBoardEdit(APP.state, () => !!placeTile(APP.state, b.kind, hover.x, hover.y, b.rotation, b.config));
}

function placeWithBrushAtCell(cell) {
  const b = APP.state.ui.brush;
  if (!b) return false;
  if (!inBounds(cell.x, cell.y, APP.state.level.gridW, APP.state.level.gridH)) return false;
  if (tileAtCell(APP.state, cell.x, cell.y)) return false;
  return withBoardEdit(APP.state, () => !!placeTile(APP.state, b.kind, cell.x, cell.y, b.rotation, b.config));
}

function lineCellsInclusive(from, to) {
  const cells = [];
  let x0 = from.x;
  let y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  while (true) {
    cells.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return cells;
}

function paintWithBrushAlongHoverPath(fromCell, toCell) {
  const b = APP.state.ui.brush;
  if (!b) return false;
  const cells = lineCellsInclusive(fromCell, toCell);
  let changed = false;
  for (const c of cells) {
    if (placeWithBrushAtCell(c)) changed = true;
  }
  return changed;
}

function hoveredTile() {
  const hover = APP.state.ui.hoverCell;
  if (!hover) return null;
  return tileAtCell(APP.state, hover.x, hover.y);
}

function deleteHoveredTile() {
  const tile = hoveredTile();
  if (!tile || tile.immovable) return false;
  return withBoardEdit(APP.state, () => deleteTile(APP.state, tile.id));
}

function rotateHoveredTile() {
  const tile = hoveredTile();
  if (!tile || tile.immovable || !COMPONENTS[tile.kind].hasRotation) return false;
  return withBoardEdit(APP.state, () => {
    rotateTile(APP.state, tile.id);
    return true;
  });
}

function hotkeyPaletteIndexFromEvent(e) {
  if (!e.code || !e.code.startsWith('Digit')) return -1;
  const digit = e.code.slice(5);
  if (!/^\d$/.test(digit)) return -1;
  const base = digit === '0' ? 9 : parseInt(digit, 10) - 1;
  return base + (e.shiftKey ? 10 : 0);
}

function hotkeyLabelForPaletteIndex(index) {
  const baseLabels = ['1','2','3','4','5','6','7','8','9','0'];
  if (index < 10) return baseLabels[index];
  return `S-${baseLabels[index - 10]}`;
}

function cycleBrushByTab(reverse) {
  const palette = APP.state.level.palette;
  if (!palette || palette.length === 0) return;
  const currentKind = APP.state.ui.brush ? APP.state.ui.brush.kind : null;
  const currentIndex = currentKind ? palette.indexOf(currentKind) : -1;
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = reverse ? palette.length - 1 : 0;
  } else {
    nextIndex = reverse
      ? (currentIndex - 1 + palette.length) % palette.length
      : (currentIndex + 1) % palette.length;
  }
  selectBrushForKind(palette[nextIndex]);
}

/* ---------- 8. UI (palette, controls, HUD, modals, level select) ---------- */

function renderPalette() {
  const host = document.getElementById('palette');
  host.innerHTML = '';
  const { level, ui } = APP.state;
  for (let index = 0; index < level.palette.length; index++) {
    const kind = level.palette[index];
    const def = COMPONENTS[kind];
    const entry = document.createElement('div');
    entry.className = 'palette-entry';
    if (ui.brush && ui.brush.kind === kind) entry.classList.add('active');

    // glyph
    const glyph = document.createElementNS(SVG_NS, 'svg');
    glyph.setAttribute('class', 'pe-glyph');
    glyph.setAttribute('viewBox', '0 0 56 56');
    const fakeTile = {
      id: 0, kind, x: 0, y: 0,
      rotation: ui.brush && ui.brush.kind === kind ? ui.brush.rotation : 0,
      config: ui.brush && ui.brush.kind === kind ? ui.brush.config : (def.defaultConfig || null),
      immovable: false,
      held: null,
    };
    glyph.appendChild(drawTileShape(fakeTile, {}));
    entry.appendChild(glyph);

    const label = document.createElement('div');
    label.className = 'pe-label';
    label.textContent = `${def.label || kind}  [${hotkeyLabelForPaletteIndex(index)}]`;
    entry.appendChild(label);

    if (def.hasRotation) {
      const rotBox = document.createElement('div');
      rotBox.className = 'pe-rot';
      const cur = (ui.brush && ui.brush.kind === kind) ? ui.brush.rotation : 0;
      // simple 4-dot indicator: top, right, bottom, left
      const layout = [
        [null, 3,    null], // up
        [2,    null, 0],    // left, --, right
        [null, 1,    null], // down
      ];
      for (const row of layout) {
        const r = document.createElement('div');
        r.className = 'pe-rot-row';
        for (const v of row) {
          const d = document.createElement('div');
          if (v === null) {
            d.style.width = '5px'; d.style.height = '5px';
          } else {
            d.className = 'pe-dot' + (v === cur ? ' lit' : '');
          }
          r.appendChild(d);
        }
        rotBox.appendChild(r);
      }
      entry.appendChild(rotBox);
      rotBox.addEventListener('click', e => {
        e.stopPropagation();
        if (!ui.brush || ui.brush.kind !== kind) {
          ui.brush = { kind, rotation: 0, config: def.defaultConfig || null };
        }
        ui.brush.rotation = (ui.brush.rotation + 1) % 4;
        APP.render();
      });
      // mousewheel on entry rotates too
      entry.addEventListener('wheel', e => {
        e.preventDefault();
        if (!ui.brush || ui.brush.kind !== kind) {
          ui.brush = { kind, rotation: 0, config: def.defaultConfig || null };
        }
        const delta = e.deltaY > 0 ? 1 : 3; // 3 == -1 mod 4
        ui.brush.rotation = (ui.brush.rotation + delta) % 4;
        APP.render();
      }, { passive: false });
    }

    entry.addEventListener('click', () => {
      if (ui.brush && ui.brush.kind === kind) {
        // clicking the active brush deselects
        ui.brush = null;
      } else {
        ui.brush = { kind, rotation: 0, config: def.defaultConfig || null };
      }
      APP.render();
    });

    host.appendChild(entry);
  }
}

function renderTask() {
  const host = document.getElementById('task');
  host.innerHTML = '';
  const { streams, sinks } = APP.state;
  for (const s of streams) {
    const row = document.createElement('div');
    row.className = 'tp-row';
    const sofar = s.chars.slice(0, s.position);
    const rest  = s.chars.slice(s.position);
    row.innerHTML = `<div class="tp-label">IN${streams.length > 1 ? ' #' + s.id : ''}</div>
                     <div class="tp-str"><span class="so-far">${escHtml(sofar)}</span>${escHtml(rest)}</div>`;
    host.appendChild(row);
  }
  for (const s of sinks) {
    const row = document.createElement('div');
    row.className = 'tp-row';
    const out = s.output;
    row.innerHTML = `<div class="tp-label">OUT${sinks.length > 1 ? ' #' + s.id : ''} (target)</div>
                     <div class="tp-str tp-out-target">${escHtml(s.target)}</div>
                     <div class="tp-label" style="margin-top:4px">so far</div>
                     <div class="tp-str">${escHtml(out)}</div>`;
    host.appendChild(row);
  }
}

function renderHUD() {
  const m = metrics(APP.state);
  document.getElementById('m-cycles').textContent = m.cycles;
  document.getElementById('m-cmps').textContent   = m.components;
  document.getElementById('m-ftp').textContent    = m.footprint;

  const stats = APP.state.stats;
  const host = document.getElementById('stats');
  host.innerHTML = `
    <div class="sp-row"><span>items now</span><b>${APP.state.items.length}</b></div>
    <div class="sp-row"><span>max items</span><b>${stats.maxItemsOnBoard}</b></div>
    <div class="sp-row"><span>destroyed</span><b>${stats.totalDestroyed}</b></div>
    <div class="sp-row"><span>collisions</span><b>${stats.totalCollisions}</b></div>
    <div class="sp-row"><span>writes</span><b>${stats.totalWrites}</b></div>
    <div class="sp-row"><span>distinct out</span><b>${stats.distinctOut.size}</b></div>
  `;
}

function escHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function openPopover(tile) {
  if (tile.immovable) return;
  APP.state.ui.popoverTileId = tile.id;
  APP.render();

  const pop = document.getElementById('popover');
  pop.innerHTML = '';
  pop.classList.remove('hidden');

  const def = COMPONENTS[tile.kind];

  if (def.hasRotation) {
    const b = document.createElement('button');
    b.textContent = 'rotate';
    b.onclick = (e) => {
      e.stopPropagation();
      withBoardEdit(APP.state, () => {
        rotateTile(APP.state, tile.id);
        return true;
      });
      openPopover(tile);
      APP.render();
    };
    pop.appendChild(b);
  }
  if (def.hasConfig) {
    const b = document.createElement('button');
    b.textContent = 'set';
    b.onclick = (e) => { e.stopPropagation(); openConfigDialog(tile); };
    pop.appendChild(b);
  }
  const del = document.createElement('button');
  del.textContent = '✕';
  del.onclick = (e) => {
    e.stopPropagation();
    withBoardEdit(APP.state, () => deleteTile(APP.state, tile.id));
    closePopover();
    APP.render();
  };
  pop.appendChild(del);

  const cp = cellPx();
  const board = document.getElementById('board');
  const rect = board.getBoundingClientRect();
  pop.style.left = (rect.left + tile.x * cp + cp + 4) + 'px';
  pop.style.top  = (rect.top  + tile.y * cp - 2) + 'px';
}

function closePopover() {
  APP.state.ui.popoverTileId = null;
  document.getElementById('popover').classList.add('hidden');
}

function openConfigDialog(tile) {
  closePopover();
  const dlg = document.getElementById('config-dialog');
  dlg.innerHTML = '';
  dlg.classList.remove('hidden');

  const title = document.createElement('div');
  title.className = 'cd-title';
  title.textContent = tile.kind === 'WRITE' ? 'WRITE: pick a character' : 'IF: pick a predicate';
  dlg.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'cd-grid';
  const chars = charsForLevel(APP.state.level);
  for (const c of chars) {
    const k = document.createElement('div');
    k.className = 'cd-key' + (tile.config === c ? ' active' : '') + (c === ' ' ? ' space' : '');
    k.textContent = c === ' ' ? 'SPACE' : c;
    k.onclick = (e) => {
      e.stopPropagation();
      withBoardEdit(APP.state, () => {
        setTileConfig(APP.state, tile.id, c);
        return true;
      });
      dlg.classList.add('hidden');
      APP.render();
    };
    grid.appendChild(k);
  }
  dlg.appendChild(grid);

  const cp = cellPx();
  const board = document.getElementById('board');
  const rect = board.getBoundingClientRect();
  dlg.style.left = (rect.left + tile.x * cp + cp + 8) + 'px';
  dlg.style.top  = (rect.top  + tile.y * cp + 2) + 'px';
}

function charsForLevel(level) {
  const set = new Set();
  for (const s of level.streams) for (const c of s.chars) set.add(c);
  for (const s of level.sinks)   for (const c of s.target) set.add(c);
  return [...set].sort();
}

function attachUI() {
  document.getElementById('btn-step').onclick   = () => doStep();
  document.getElementById('btn-step-back').onclick = () => doStepBack();
  document.getElementById('btn-reset').onclick  = () => doReset();
  document.getElementById('btn-play').onclick   = () => doPlayPause();
  document.getElementById('btn-rotate').onclick = () => doRotateHoveredTileOrBrush();
  document.getElementById('btn-clear').onclick  = () => doClearBoard();
  document.getElementById('btn-delete').onclick = () => {
    if (deleteHoveredTile()) APP.render();
  };
  document.getElementById('btn-undo').onclick   = () => {
    if (undoBoardEdit(APP.state)) APP.render();
  };
  document.getElementById('btn-redo').onclick   = () => {
    if (redoBoardEdit(APP.state)) APP.render();
  };

  document.addEventListener('keydown', (e) => {
    if (!APP) return;
    if (document.getElementById('screen-game').classList.contains('hidden')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleBrushByTab(e.shiftKey);
      APP.render();
      return;
    }

    const paletteIndex = hotkeyPaletteIndexFromEvent(e);
    if (paletteIndex >= 0) {
      const kind = APP.state.level.palette[paletteIndex];
      if (!kind) return;
      e.preventDefault();
      selectBrushForKind(kind);
      APP.state.ui.keyboardPaintKind = kind;
      placeWithBrushAtHover();
      APP.render();
      return;
    }

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      doPlayPause();
      return;
    }
    if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      doReset();
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      doClearBoard();
      return;
    }

    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (undoBoardEdit(APP.state)) APP.render();
      return;
    }

    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      if (redoBoardEdit(APP.state)) APP.render();
      return;
    }

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      increaseSpeed();
      return;
    }

    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      decreaseSpeed();
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      stopSimulation(APP.state);
      setPlayIdleLabel();
      doStep();
      return;
    }

    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      doStepBack();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      doRotateHoveredTileOrBrush();
      return;
    }

    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      if (deleteHoveredTile()) APP.render();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!APP) return;
    if (e.code && e.code.startsWith('Digit')) {
      APP.state.ui.keyboardPaintKind = null;
    }
  });

  for (const b of document.querySelectorAll('.spd-btn')) {
    b.onclick = () => {
      setSpeed(parseInt(b.dataset.speed, 10));
    };
  }
  // Click on empty board area dismisses popover/config
  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('popover');
    const dlg = document.getElementById('config-dialog');
    if (!pop.contains(e.target) && !e.target.closest('[data-tile-id]')) {
      closePopover();
    }
    if (!dlg.contains(e.target)) {
      dlg.classList.add('hidden');
    }
    const md = document.getElementById('menu-dropdown');
    if (!md.contains(e.target) && e.target.id !== 'btn-menu') {
      md.classList.add('hidden');
    }
  }, true);

  // Menu
  document.getElementById('btn-menu').onclick = (e) => {
    e.stopPropagation();
    const md = document.getElementById('menu-dropdown');
    md.classList.toggle('hidden');
  };
  document.querySelectorAll('#menu-dropdown button').forEach(b => {
    b.onclick = () => {
      const a = b.dataset.action;
      document.getElementById('menu-dropdown').classList.add('hidden');
      if (a === 'back') showLevelSelect();
      else if (a === 'reset-board') confirmAndClearBoard();
      else if (a === 'howto') document.getElementById('modal-howto').classList.remove('hidden');
    };
  });

  // How-to
  document.getElementById('btn-howto').onclick    = () => document.getElementById('modal-howto').classList.remove('hidden');
  document.getElementById('btn-howto-ok').onclick = () => {
    document.getElementById('modal-howto').classList.add('hidden');
    Storage.markHowtoSeen();
  };

  // Win modal
  document.getElementById('btn-retry').onclick = () => {
    document.getElementById('modal-win').classList.add('hidden');
    doReset();
  };
  document.getElementById('btn-next').onclick = () => {
    document.getElementById('modal-win').classList.add('hidden');
    const idx = LEVELS.findIndex(l => l.id === APP.state.level.id);
    if (idx >= 0 && idx + 1 < LEVELS.length) {
      enterLevel(LEVELS[idx + 1]);
    } else {
      showLevelSelect();
    }
  };
}

function confirmAndClearBoard() {
  doClearBoard();
}

/* ---------- Sim controls ---------- */

function doStep() {
  if (APP.state.sim.finished) return;
  APP.state.sim.historyPast.push(captureSimSnapshot(APP.state));
  APP.state.sim.historyFuture = [];
  const r = step(APP.state);
  APP.render();
  if (r) handleSimEnd(r);
}

function doStepBack() {
  const sim = APP.state.sim;
  if (sim.historyPast.length === 0) return;
  stopSimulation(APP.state);
  setPlayIdleLabel();
  sim.historyFuture.push(captureSimSnapshot(APP.state));
  const previous = sim.historyPast.pop();
  restoreSimSnapshot(APP.state, previous);
  APP.render();
}

function simTickIfPlaying() {
  if (!APP.state.sim.running) return;
  doStep();
}

function doPlayPause() {
  const sim = APP.state.sim;
  if (sim.finished) return;
  if (sim.running) {
    stopSimulation(APP.state);
    setPlayIdleLabel();
  } else {
    sim.running = true;
    setPlayRunningLabel();
    sim.timer = setInterval(simTickIfPlaying, SPEED_MS[sim.speed]);
  }
}

function doReset() {
  resetSim(APP.state);
  setPlayIdleLabel();
  APP.render();
}

function doClearBoard() {
  const playerTileIds = [...APP.state.tiles.values()]
    .filter(t => !t.immovable)
    .map(t => t.id);
  for (const tileId of playerTileIds) {
    const before = snapshotBoard(APP.state);
    if (deleteTile(APP.state, tileId)) {
      commitBoardEdit(APP.state, before);
    }
  }
  APP.render();
}

function doRotateHoveredTileOrBrush() {
  if (rotateHoveredTile()) {
    APP.render();
    return;
  }
  if (APP.state.ui.brush && COMPONENTS[APP.state.ui.brush.kind].hasRotation) {
    APP.state.ui.brush.rotation = (APP.state.ui.brush.rotation + 1) % 4;
    APP.render();
  }
}

function setSpeed(speed) {
  APP.state.sim.speed = speed;
  for (const btn of document.querySelectorAll('.spd-btn')) {
    btn.classList.toggle('active', parseInt(btn.dataset.speed, 10) === speed);
  }
  if (APP.state.sim.running) {
    clearInterval(APP.state.sim.timer);
    APP.state.sim.timer = setInterval(simTickIfPlaying, SPEED_MS[APP.state.sim.speed]);
  }
}

function increaseSpeed() {
  const current = APP.state.sim.speed;
  const idx = SPEED_STEPS.indexOf(current);
  const next = idx === -1 ? SPEED_STEPS[0] : SPEED_STEPS[Math.min(idx + 1, SPEED_STEPS.length - 1)];
  setSpeed(next);
}

function decreaseSpeed() {
  const current = APP.state.sim.speed;
  const idx = SPEED_STEPS.indexOf(current);
  const next = idx === -1 ? SPEED_STEPS[0] : SPEED_STEPS[Math.max(idx - 1, 0)];
  setSpeed(next);
}

function handleSimEnd(result) {
  setPlayIdleLabel();
  if (result.won) {
    const m = metrics(APP.state);
    const best = Storage.getBest(APP.state.level.id);
    Storage.recordWin(APP.state.level.id, m);
    showWinModal(m, best);
  } else {
    // Don't show a fail modal; just stop. Player can hit reset.
    // Could surface "did not match" hint via stats panel.
  }
}

function showWinModal(current, best) {
  document.getElementById('win-cycles').textContent = current.cycles;
  document.getElementById('win-cmps').textContent   = current.components;
  document.getElementById('win-ftp').textContent    = current.footprint;
  const winBest = document.getElementById('win-best');
  if (best) {
    winBest.textContent = `best so far · cycles ${best.cycles} · cmps ${best.components} · ftp ${best.footprint}`;
  } else {
    winBest.textContent = 'first solve!';
  }
  // mark new bests
  document.querySelectorAll('.modal-metrics div').forEach(d => d.classList.remove('new-best'));
  if (best) {
    if (current.cycles     <= best.cycles)     document.querySelectorAll('.modal-metrics div')[0].classList.add('new-best');
    if (current.components <= best.components) document.querySelectorAll('.modal-metrics div')[1].classList.add('new-best');
    if (current.footprint  <= best.footprint)  document.querySelectorAll('.modal-metrics div')[2].classList.add('new-best');
  }
  document.getElementById('modal-win').classList.remove('hidden');
}

/* ---------- Level select / navigation ---------- */

function renderLevelSelect() {
  const grid = document.getElementById('level-grid');
  grid.innerHTML = '';
  const solvedSet = Storage.solvedSet();
  for (let i = 0; i < LEVELS.length; i++) {
    const l = LEVELS[i];
    const card = document.createElement('div');
    const locked = false;
    card.className = 'level-card' + (locked ? ' locked' : '');
    const solved = solvedSet.has(l.id);
    const best = Storage.getBest(l.id);
    card.innerHTML = `
      <div class="lc-num">${l.id}</div>
      <div class="lc-name">${l.name}</div>
      <div class="lc-status">${locked ? '- locked' : (solved ? '✓ solved' : '- - -')}</div>
      ${best ? `<div class="lc-best">cyc ${best.cycles} · cmp ${best.components} · ftp ${best.footprint}</div>` : ''}
    `;
    if (!locked) {
      card.onclick = () => enterLevel(l);
    }
    grid.appendChild(card);
  }
}

function showLevelSelect() {
  document.getElementById('screen-game').classList.add('hidden');
  document.getElementById('screen-title').classList.remove('hidden');
  if (APP && APP.state) stopSimulation(APP.state);
  renderLevelSelect();
}

function enterLevel(level) {
  if (APP && APP.state) stopSimulation(APP.state);
  const state = createState(level);
  if (level.palette && level.palette.length > 0) {
    const firstKind = level.palette[0];
    state.ui.brush = {
      kind: firstKind,
      rotation: 0,
      config: COMPONENTS[firstKind].defaultConfig || null,
    };
  }
  const savedBoard = Storage.getBoardLayout(level.id);
  if (savedBoard) {
    applyBoardSnapshot(state, savedBoard);
  }
  APP = {
    state,
    render() { renderAll(); },
  };
  document.getElementById('screen-title').classList.add('hidden');
  document.getElementById('screen-game').classList.remove('hidden');
  document.getElementById('level-title').textContent = `${level.id}  ${level.name}`;
  if (!BOARD_INPUT_ATTACHED) {
    attachBoardInput(document.getElementById('board'));
    BOARD_INPUT_ATTACHED = true;
  }
  renderAll();
}

function renderAll() {
  renderBoard(APP.state, document.getElementById('board'));
  renderPalette();
  renderTask();
  renderHUD();
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  undoBtn.disabled = APP.state.history.past.length === 0;
  redoBtn.disabled = APP.state.history.future.length === 0;
}

/* ---------- 9. Storage ---------- */

const Storage = {
  KEY: 'builder.v1',
  load() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY)) || {};
    } catch (error) {
      console.error('[builder] Failed to parse localStorage state. Resetting persisted data.', error);
      return {};
    }
  },
  save(d) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(d));
    } catch (error) {
      console.error('[builder] Failed to persist localStorage state.', error);
    }
  },
  solvedSet() {
    const d = this.load();
    return new Set(Object.keys(d.bests || {}));
  },
  getBest(levelId) {
    const d = this.load();
    return (d.bests && d.bests[levelId]) || null;
  },
  recordWin(levelId, m) {
    const d = this.load();
    d.bests = d.bests || {};
    const prev = d.bests[levelId];
    if (!prev) {
      d.bests[levelId] = { cycles: m.cycles, components: m.components, footprint: m.footprint };
    } else {
      d.bests[levelId] = {
        cycles:     Math.min(prev.cycles,     m.cycles),
        components: Math.min(prev.components, m.components),
        footprint:  Math.min(prev.footprint,  m.footprint),
      };
    }
    this.save(d);
  },
  markHowtoSeen() {
    const d = this.load();
    d.howtoSeen = true;
    this.save(d);
  },
  howtoSeen() {
    return !!this.load().howtoSeen;
  },
  getBoardLayout(levelId) {
    const d = this.load();
    const board = d.boards && d.boards[levelId];
    return Array.isArray(board) ? board : null;
  },
  saveBoardLayout(levelId, board) {
    const d = this.load();
    d.boards = d.boards || {};
    d.boards[levelId] = board;
    this.save(d);
  },
};

/* ---------- 10. Bootstrap ---------- */

window.addEventListener('DOMContentLoaded', () => {
  attachUI();
  showLevelSelect();
  if (!Storage.howtoSeen()) {
    document.getElementById('modal-howto').classList.remove('hidden');
  }
});
