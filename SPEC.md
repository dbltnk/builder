# Builder — design spec

A web-based, single-player puzzle game in the Zachtronics tradition. The player constructs grid-based machines that consume an input string of characters and produce a target output string. Pure black/white/grey vector graphics, no color, no images, no emoji. Pure puzzle, no narrative.

## Locked design decisions

- **Metaphor**: loose only — game must stand on its own as an abstract puzzle. (It is *also* a metaphor for ML-style data pipelines, but nothing in the game says so.)
- **Phase**: deployment only. No training mechanic.
- **Layout**: spatial grid (Opus Magnum / Manufactoria lineage).
- **Atomic data unit**: single character.
- **Determinism**: fully deterministic.
- **Win condition**: exact-match output at all sinks.
- **Metrics**: classic Zachtronics trio (cycles, components, footprint) + side observability stats.
- **Difficulty arc (target)**: 3-letter words → single-line haiku with spaces. (V1 ships the first 5 levels; haiku is a later iteration.)
- **Visual language**: geometric/symbolic, B&W with greys allowed for UI affordances. Plain English labels (verbs/nouns describing the mechanic) on components and UI buttons. **No** ML-flavored vocabulary (no ATTEND, EMBED, NEURAL, ATTENTION, etc.). Mechanics words only: WRITE, DELETE, COPY, IF, HOLD, etc.
- **Frame**: pure puzzle, no story.
- **Collisions**: when two characters land on the same cell, the later arrival overwrites the earlier — this is a usable primitive, not an error.
- **Palette per level**: each level unlocks a specific subset of components.
- **Ports**: levels may declare multiple input streams and multiple output sinks.
- **Controls**: mouse-only for V1.

## Tech & architecture

Pure static frontend. No backend, no build step, no framework — just HTML, CSS, ES modules, SVG.

- **Rendering**: SVG. Crisp at any zoom, easy hit-testing, fits the vector mandate.
- **Language**: vanilla JS, ES modules via `<script type="module">`. No TypeScript (zero-config priority). Can be added later.
- **State**: plain JS objects, single source of truth, render is a function of state.
- **Persistence**: `localStorage` for solved-level records, best metrics per level, and saved board layouts.
- **Levels**: data-driven — JS objects in `src/levels/`. Each level declares grid size, allowed components, input streams, target outputs, and optional par metrics.

Why no framework: state is small, the simulator needs full control over the tick loop, and a Zach-like benefits from owning every render frame. React would cost more than it saves.

## File layout

```
builder/
  index.html
  styles.css
  src/
    main.js              # bootstrap, wires modules together
    state.js             # game state object, mutation API, undo/redo
    grid.js              # grid model: tile placement, rotation, query
    components.js        # component registry: name → behavior + symbol
    sim.js               # tick loop, collision resolution, win check
    render.js            # SVG renderer (board, tiles, items, overlays)
    input.js             # mouse interaction, palette selection
    levels.js            # level loader + level list
    levels/
      l01_pass.js
      l02_swap.js
      l03_reverse.js
      l04_filter.js
      l05_amplify.js
    ui/
      palette.js         # tile picker on the side
      controls.js        # play / pause / step / speed / reset
      hud.js             # cycles, components, footprint, side stats
      modal.js           # win screen, level select
```

## Core simulation model

### Cells and tiles
- Grid is fixed per level (6×6 to 14×14). Each cell holds at most one **tile** (placed by player or fixed by level).
- A tile has: `kind` (component id), `rotation` (0/1/2/3 quarter turns), and `config` (e.g. the constant for `WRITE`, the predicate char for `IF`, the stream/sink id for `IN`/`OUT`).

### Items
- An **item** is a single character that occupies at most one cell at a time.
- Items live on the board between cells; visually they animate from cell to cell during a tick.

### The tick (deterministic)
Each tick:
1. **Read phase**: every component reads from its input port(s) and computes its output(s) into a staging buffer. No writes hit the board yet. `IN` tiles consume the next char from their declared input stream.
2. **Write phase**: items in the staging buffer are placed into their target cells. Multiple items targeting the same cell resolve via the collision rule.
3. **OUT phase**: any item that lands on an `OUT` tile is appended to that sink's emitted string and removed from the board.
4. **Win check**: when all input streams are exhausted *and* the board contains zero items, compare each sink's emitted string to its target. All must match exactly to win.

### Collision rule
When N items land on the same cell in the same tick, the one with the highest **priority** wins; the others are destroyed. Priority order, deterministic:
1. Items emitted by the higher-numbered tile id (i.e. tile placed later) win over earlier ones.
2. If still tied, a fixed cardinal-direction order (N > E > S > W) breaks the tie.

**Convergence at OUT.** Multiple `OUT` tiles can share the same sink id; the sink appends chars in arrival order across all sharing tiles (ties broken by the same priority rule). Branching paths (e.g. an `IF` that splits into "transform" and "pass through") don't need a `MERGE` to converge — they just both terminate in `OUT(sink=0)` tiles.

### Backpressure
Default: none. If a component would emit but its output cell already has an item that didn't move, the new emission collides per the rule above. This avoids implementing waiting/queueing globally; localized "hold on the input until clear" semantics live only inside the `HOLD` component.

## Component set

Each component is a 1-cell tile. Tile rendering = a geometric shape inscribed in the cell *plus* a small all-caps mechanic-label drawn in the cell. (Final glyph designs locked during M1.)

| Id | Label on tile | Inputs | Outputs | Config | Behavior |
|---|---|---|---|---|---|
| `IN` | `IN` (+ stream # if >1) | — | 1 (rotatable) | stream id (default 0) | Each tick, emits next char of stream into the cell its arrow points at. When stream is exhausted, emits nothing. |
| `OUT` | `OUT` (+ sink # if >1) | 1 | — | sink id (default 0) | Any item entering this cell is appended to sink's output and removed. |
| `BELT` | arrow only | 1 | 1 | rotation | Receives an item, emits it next tick to the cell its arrow points at. |
| `WRITE` | `WRITE` + the constant glyph | 1 | 1 | constant char `c`, rotation | Replaces any incoming item with `c` and emits to output. Pure transformer — never produces an item without one entering first. (Every item in the world traces back to an `IN`.) |
| `DELETE` | `DEL` | 1 | — | — | Any item entering this cell is destroyed. |
| `COPY` | `COPY` | 1 | 2 | rotation | Item entering is duplicated; one copy goes to each output direction. |
| `IF` | `IF` + the predicate glyph | 1 | 2 | predicate char `c`, rotation | If the incoming char `== c`, emit on output A; else emit on output B. The char itself is forwarded unchanged. |
| `HOLD` | `HOLD` | 1 | 1 | rotation | One-cell buffer. Holds at most one item. Releases its held item only when its output cell is empty. Useful for resequencing. |

Post-V1 additions:
- `MAP` — small player-edited table mapping char → char.
- `MERGE` — explicit 2-in 1-out.

## Visual language

- Background: white (`#FFF`).
- Foreground: black (`#000`) for active tiles, grid frame, items, text.
- Greys: one or two greys for grid lines, hover preview, ghost-placement, disabled palette items.
- Items: the actual character glyph, monospace SVG `<text>`, animated between cell centers during a tick. Scale ~60% of cell width.
- Tiles: geometric strokes/shapes inscribed in the cell, with an all-caps label rendered inside where space allows. Rotation is encoded by orientation of the shape.
- Labels are plain mechanics vocabulary only. **Forbidden**: anything ML-flavored (ATTENTION, EMBED, NEURAL, MODEL, LAYER, WEIGHT, etc.).
- No icons that resemble familiar objects. No skeuomorphism.
- Grid: faint dotted intersections at low opacity, never solid lines.

## Controls (mouse-only)

No keyboard input. All actions reachable through mouse alone.

**Selecting a tile to place:**
- Left-click a palette entry → it becomes the *active brush*. The brush is shown as a faint preview under the cursor when hovering the grid.
- Each rotatable component (BELT, WRITE, IF, COPY, HOLD) has a 4-dot rotation indicator on its palette entry; click the indicator (or scroll-wheel over the entry) to cycle rotation 0/1/2/3 before placing.

**Placing:**
- With a brush active, left-click an empty grid cell → place the tile.
- Hold left mouse button and drag across empty cells → place a continuous run of belts (rotation auto-aligns to drag direction). Drag-paint applies only to BELT.

**Modifying placed tiles:**
- Left-click an existing tile → opens an **inline tile popover** at that cell, with Rotate, Configure (if applicable), and Delete (✕) buttons.
- Right-click an existing tile → quick-rotate by 90° (no popover). Fast iteration shortcut.
- Click-and-drag an existing tile to another empty cell → move it. Drop on the palette area → delete it.

**Sim controls (toolbar buttons):**
- Step (advance one tick)
- Play / Pause toggle
- Reset (returns board to its pre-sim state, clears all items)
- Speed picker — discrete clicks: ×1, ×2, ×5, ×20

**Tile config dialog:**
- Opens via the Configure button in the tile popover.
- For WRITE / IF: a strip of clickable character buttons (A–Z, 0–9, space, plus any other chars used by the current level). Click one → it becomes the constant/predicate. Dialog auto-closes.
- The dialog floats next to the tile, never blocks the board.

## Screens & layouts

The game has **four** distinct screens. Modal overlays appear over screens 2 and 3.

### Screen 1 — Title / Level Select

Single screen, full viewport. Choose which level to play, see progress.

```
+------------------------------------------------------------+
|                                                            |
|                       B U I L D E R                        |
|                                                            |
|                                                            |
|         +-----------+  +-----------+  +-----------+        |
|         |    L1     |  |    L2     |  |    L3     |        |
|         |   PASS    |  |   SWAP    |  |  REVERSE  |        |
|         |  ✓ solved |  |  ✓ solved |  |   - - -   |        |
|         |  cyc 5    |  |  cyc 7    |  |           |        |
|         |  cmp 4    |  |  cmp 6    |  |           |        |
|         +-----------+  +-----------+  +-----------+        |
|                                                            |
|         +-----------+  +-----------+                       |
|         |    L4     |  |    L5     |                       |
|         |  FILTER   |  |  AMPLIFY  |                       |
|         |  - locked |  |  - locked |                       |
|         |           |  |           |                       |
|         +-----------+  +-----------+                       |
|                                                            |
+------------------------------------------------------------+
```

- Each tile is a card showing level number, name, status icon (solved ✓ / unsolved – – – / locked), and (if solved) the player's best three metrics.
- Locked levels grey out — they unlock as previous levels are solved (linear progression for V1).
- Clicking a non-locked card → enters Screen 3 for that level.
- 3 cards per row, simple rectangles with thin borders.

### Screen 2 — How To Play (one-time, on first launch)

Auto-opens on first ever load (then reachable via a small `?` button on Screen 1). Five short, illustrated panels showing: place a tile, rotate, delete, run sim, win condition. Each panel a static SVG diagram with one-line caption. Click "Got it" to dismiss → Screen 1.

This is bare-minimum onboarding. Mechanics-teaching is done by the level progression.

### Screen 3 — Game (the main puzzle screen)

Where the player spends 95% of their time. Single screen, full viewport, three regions.

```
+--------------------------------------------------------------+
|  [≡ menu]   L2  SWAP                       cycles  cmps  ftp |
|                                              -      0     0  |
+-------------+----------------------------------------+-------+
|  PALETTE    |                                        | TASK  |
|             |                                        |       |
|  [→ BELT ]  |          .   .   .   .   .   .         | IN    |
|   • • • •   |                                        | "BAT" |
|             |          .   .   .   .   .   .         |       |
|  [WRITE ◌]  |                                        | OUT=? |
|             |    [IN]  .   .   .   .   .   [OUT]     | "CAT" |
|  [IF ◌  ]   |                                        |       |
|             |          .   .   .   .   .   .         |-------|
|             |                                        | STATS |
|             |          .   .   .   .   .   .         |       |
|             |                                        | items 0|
|             |                                        | dest  0|
|             |                                        | coll  0|
|             |                                        |       |
+-------------+----------------------------------------+-------+
|             [Reset] [Step] [▶ Play]   speed: ×1 ×2 ×5 ×20    |
+--------------------------------------------------------------+
```

**Top bar (slim):**
- `≡ menu` button (left): dropdown — *Back to levels*, *Reset board*, *How to play*.
- Level name and number (centre-left): `L2  SWAP`.
- Live metrics readout (right): cycles, components, footprint — updating during sim.

**Left sidebar — Palette:**
- Vertical list of components available for *this level only*. Locked components don't appear.
- Each entry is a card-sized button with the tile's geometric symbol + label.
- Each rotatable entry has a 4-dot rotation indicator showing current orientation; clicking the dots or scroll-wheeling over the entry cycles rotation.
- The selected (active) palette entry is visibly outlined.
- IN and OUT do **not** appear in the palette — they are pre-placed by the level.

**Centre — Board:**
- The grid itself. Cells rendered as faint dotted intersections. Tiles drawn with thick black strokes. Items animate between cells during sim.
- Pre-placed IN/OUT tiles render with a slightly different border (immovable).
- Hover over a placed tile shows it slightly outlined; clicking opens the inline popover.

**Right sidebar — Task & Stats:**
- *Task panel* (top): level's input string and target output string in monospace.
- *Stats panel* (bottom): live side-stats (max items on board, total destroyed, total collisions, distinct chars at OUT, etc.).

**Bottom bar — Sim controls:**
- Reset, Step, Play/Pause toggle, Speed picker. All buttons large enough for comfortable mouse-clicking.

**Layout & responsive:**
- Designed for ≥1280×720. On smaller screens, right sidebar stacks below or hides behind a toggle. Mobile is post-V1.
- ~16px gutters; sidebars ~220px wide; bottom bar ~48px tall; top bar ~40px tall.

### Modal — Tile config dialog

Floats next to a selected tile. Small (≤ 240×180 px), white background, thin black border, no overlay-darkening. Grid of clickable char buttons. Closes on selection or click-outside.

### Modal — Win

Triggered on win condition. Centred over Screen 3 with a subtle background dim.

```
        +---------------------------------+
        |                                 |
        |        S O L V E D              |
        |                                 |
        |                                 |
        |        cycles      7            |
        |        components  6            |
        |        footprint   8            |
        |                                 |
        |   (best:  cycles 7 · cmp 6 · ftp 8) |
        |                                 |
        |        [ retry ]    [ next ]    |
        |                                 |
        +---------------------------------+
```

- Big "SOLVED" wordmark.
- Three metrics for *this run*, with personal-bests in parentheses underneath. New best marked.
- Two buttons: *retry* (re-enter same level, board preserved), *next* (advance to next unlocked level, or back to Level Select).

### Modal — Pause / menu (from `≡` button)

Small dropdown anchored to the menu button. Items: *Back to levels*, *Reset board*, *How to play*. Plain list, click outside to dismiss.

## Metrics

Three primary (Zach trio), shown prominently on win:
1. **Cycles** — ticks elapsed until win condition.
2. **Components** — count of player-placed tiles (BELT counts; IN/OUT placed by level do not).
3. **Footprint** — area of axis-aligned bounding box around all player-placed tiles.

Side stats (shown in HUD during sim, recorded but not used for ranking):
- Max simultaneous items on board
- Total collisions / overwrites
- Distinct chars seen at any OUT
- Total items destroyed (DELETE + collision losers)
- Total items emitted by all WRITEs

LocalStorage persists best-of-each per level.

## Levels (V1 — five concrete designs)

Each introduces a *distinct* category of challenge. Output length grows from 3 → 3 → 3 → 4 → 11 chars; the *kind* of thinking required changes at each step.

### L1 — `PASS` (routing)

- **Input stream 0:** `"DOG"`
- **Output sink 0 target:** `"DOG"`
- **Board:** 6×6
- **Pre-placed:** `IN(stream=0)` on left edge, `OUT(sink=0)` on right edge.
- **Player palette:** `BELT` (unlimited).
- **Challenge:** route the chars from `IN` to `OUT`. No transformation.
- **Teaches:** placing tiles, rotating, running the simulator, the win condition.
- **Par:** ~5 cycles, ~4 components, footprint ~4 cells.
- **Why distinct:** pure topology.

### L2 — `SWAP` (single transformation)

- **Input stream 0:** `"BAT"`
- **Output sink 0 target:** `"CAT"`
- **Board:** 8×8
- **Pre-placed:** `IN`, `OUT`.
- **Player palette:** `BELT`, `IF`, `WRITE`.
- **Challenge:** the first char `B` must become `C`; the rest pass through unchanged. Player needs to route conditionally.
- **Canonical solution:** `IN → IF(='B')`. Match-branch → `WRITE('C') → OUT`. Else-branch → `BELT… → OUT`. Two `OUT` tiles share sink 0.
- **Teaches:** `IF` as router, `WRITE` as transformer, multi-`OUT`-into-one-sink.
- **Par:** ~6 cycles, ~6 components.
- **Why distinct:** content-dependent logic.

### L3 — `REVERSE` (timing & parallelism — no IF, no WRITE)

- **Input stream 0:** `"FLY"`
- **Output sink 0 target:** `"YLF"`
- **Board:** 10×10
- **Pre-placed:** `IN`, `OUT`.
- **Player palette:** `BELT`, `HOLD`, `COPY`.
- **Challenge:** chars enter at ticks 0, 1, 2; must exit reversed. No `IF`, no `WRITE` — the only lever is **path length**. Three converging paths of different lengths so char #3 (shortest path) arrives at `OUT` first.
- **Canonical solution:** staircase of `HOLD` tiles forming a delay line, or `COPY`-tree with HOLD chains of different lengths.
- **Teaches:** timing as a degree of freedom. Path length = delay.
- **Par:** ~9 cycles, ~10 components.
- **Why distinct:** the only category of puzzle that's purely about timing and topology.

### L4 — `FILTER` (selective deletion, longer string)

- **Input stream 0:** `"AXBXCXDX"` (8 chars)
- **Output sink 0 target:** `"ABCD"` (4 chars)
- **Board:** 10×10
- **Pre-placed:** `IN`, `OUT`.
- **Player palette:** `BELT`, `IF`, `DELETE`, `HOLD`.
- **Challenge:** every other char is a junk char `X` to remove. Remaining chars must arrive at `OUT` in order.
- **Canonical solution:** `IN → IF('X')`. Match-branch → `DELETE`. Else-branch → `BELT… → OUT`. The sink doesn't care *when* chars arrive, only in what order.
- **Teaches:** `DELETE`, the sink's order-preserving (not tick-preserving) behavior, longer streams.
- **Par:** ~10 cycles, ~6 components.
- **Why distinct:** first level where output length ≠ input length.

### L5 — `AMPLIFY` (generation: short seed → long output, with spaces)

- **Input stream 0:** `"WIN"` (3 chars)
- **Output sink 0 target:** `"WIN WIN WIN"` (11 chars, two spaces)
- **Board:** 14×14
- **Pre-placed:** `IN`, `OUT`.
- **Player palette:** `BELT`, `WRITE`, `COPY`, `HOLD`, `IF`.
- **Challenge:** output is nearly 4× input length. `COPY` each input char multiple times; arrange arrival order. The two spaces don't exist in the input — produced by `WRITE(' ')` applied to copies of input chars (since `WRITE` is a transformer, not a generator).
- **Canonical solution:** `IN` produces chars at ticks 0, 1, 2. Each is `COPY`'d into a tree, producing 3+ copies. Two copies are fed through `WRITE(' ')` to become spaces. All paths converge at `OUT(sink=0)` with `HOLD` chains arranging the timing.
- **Teaches:** `COPY` as duplicator, `WRITE` as a way to create new content, large-board orchestration.
- **Par:** ~14 cycles, ~22 components.
- **Why distinct:** output is mostly *not* in the input. Generation, not transformation.

### Summary table

| # | Name | In | Out | New mechanics | Core challenge |
|---|---|---|---|---|---|
| L1 | PASS | `DOG` (3) | `DOG` (3) | BELT, IN/OUT | Routing |
| L2 | SWAP | `BAT` (3) | `CAT` (3) | IF, WRITE | Conditional transformation |
| L3 | REVERSE | `FLY` (3) | `YLF` (3) | HOLD | Pure timing |
| L4 | FILTER | `AXBXCXDX` (8) | `ABCD` (4) | DELETE | Selective culling |
| L5 | AMPLIFY | `WIN` (3) | `WIN WIN WIN` (11) | COPY | Generation |

Post-V1: haiku-tier endgame, `MAP` and `MERGE` components, multi-stream/multi-sink levels.

## Out of scope for V1

- Sound, music
- Mobile/touch (desktop browser only)
- Accounts, cloud sync, leaderboards
- Level editor UI for users
- TypeScript, bundler, automated tests
- A training/learning mechanic of any kind
- Color or imagery of any kind
- Keyboard shortcuts

## Implementation checklist

Tracks all currently-known tasks. Extended as new ones surface.

### M0 — Spec

- [x] SPEC.md initial draft
- [ ] Initial git commit on `main`

### M1 — Engine spike (L1 playable end-to-end)

- [x] `index.html` scaffold
- [x] `styles.css` base
- [x] App skeleton (single `src/app.js` for V1; no modules so it runs from `file://`)
- [x] State model (board, tiles, items, sinks, stats)
- [x] Grid model + coordinate / direction math
- [x] Component registry: `IN`, `OUT`, `BELT`, `WRITE` behaviors
- [x] Simulator: tick loop (read → write → win-check phases)
- [x] Collision rule: highest tile-id wins, overwrite semantics
- [x] Win detection (all streams exhausted, board empty, sinks match)
- [x] SVG renderer: grid, tiles, items, smooth tick animation
- [x] Mouse input: click-place, click-popover, drag-paint belts, right-click rotate
- [x] Sim controls toolbar: Reset / Step / Play-Pause / speed picker
- [x] HUD: live cycles, components, footprint + side stats
- [x] L1 `PASS` playable end-to-end with win modal

### M2 — Full primitive set + 5 levels

- [x] `DELETE` component
- [x] `COPY` component
- [x] `IF` component (configurable predicate)
- [x] `HOLD` component (1-tick delay buffer)
- [x] Tile config popover (constant for `WRITE`, predicate for `IF`)
- [x] Per-level palette filtering
- [x] L2 `SWAP`
- [x] L3 `REVERSE`
- [x] L4 `FILTER`
- [x] L5 `AMPLIFY`
- [x] Win modal with metrics + retry/next buttons
- [x] Visual pass on tile glyphs (final geometric language)

### M3 — Level system + persistence (V1 ship target)

- [x] Title / Level Select screen
- [x] localStorage: solved status + best metrics per level
- [x] localStorage: saved board layout per level
- [x] Undo / redo stack for board edits
- [x] First-launch How To Play screen
- [x] Pause / menu dropdown (back to levels, reset board, how to play)