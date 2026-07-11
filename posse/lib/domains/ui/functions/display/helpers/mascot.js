// Tiny western working indicator for the Posse TUI.
//
// The source art is a 34x12 pixel raster using:
//   R = rider pixels
//   H = horse pixels
//   . = transparent
//
// It renders into 17x3 Braille cells, so it fits beside the 3-row title
// without adding a dependency or changing the terminal layout.
// The whole silhouette uses one color because Braille cells cannot color
// sub-pixels independently; splitting rider and horse colors creates flicker
// when both share a cell during animation.
//
// Anatomy notes for future pixel surgeons: the ears are two separate 1-dot
// spikes, the eye is a deliberate HOLE in the head (an unset pixel reads as
// an eye at Braille density), and the body must stay solid — a single
// missing interior pixel renders as a line through the horse.

const NO_COLOR = {
  reset: "",
  dim: "",
  orange: "",
  yellow: "",
  brightWhite: "",
  white: "",
};

export const POSSE_MASCOT_CELL_WIDTH = 17;
export const POSSE_MASCOT_CELL_HEIGHT = 3;

const RIGHT_FRAME_A = [
  "............RRRR..................",
  "..........RRRRRRRR................",
  ".............RR..........H.H......",
  "............RRR.........HHHHH.....",
  "............RR......HHHHH.HHHH....",
  "......HHHHHRRHHHHHHHHHHHHHH.......",
  "....HH.HHHHHHHHHHHHHHHHHH.........",
  "...HH.....HHHHHHHHHHHHHHH.........",
  "..HH......HHHHHHH....H............",
  "....H...H.......H...H.............",
  "...H....H.......H....H............",
  "..H......H.......H....H...........",
];

const RIGHT_FRAME_B = [
  "............RRRR..................",
  "..........RRRRRRRR................",
  ".............RR..........H.H......",
  "............RRR.........HHHHH.....",
  "............RR......HHHHH.HHHH....",
  "......HHHHHRRHHHHHHHHHHHHHH.......",
  "....HH.HHHHHHHHHHHHHHHHHH.........",
  "...HH.....HHHHHHHHHHHHHHH.........",
  "...HH.....HHHHHHH...H.............",
  "......H..H.....H..H.H.............",
  "......HH......H...HH..............",
  ".....H.H......H...H.H.............",
];

function mirrorRaster(rows) {
  return rows.map((row) => [...row].reverse().join(""));
}

const RASTER_FRAMES = {
  rA: RIGHT_FRAME_A,
  rB: RIGHT_FRAME_B,
  lA: mirrorRaster(RIGHT_FRAME_A),
  lB: mirrorRaster(RIGHT_FRAME_B),
};

const BRAILLE_DOTS = [
  [0, 0, 0x01], [1, 0, 0x02], [2, 0, 0x04], [3, 0, 0x40],
  [0, 1, 0x08], [1, 1, 0x10], [2, 1, 0x20], [3, 1, 0x80],
];

function assertRasterShape(rows) {
  if (!Array.isArray(rows) || rows.length !== POSSE_MASCOT_CELL_HEIGHT * 4) {
    throw new Error("Posse mascot raster height is invalid");
  }
  for (const row of rows) {
    if (typeof row !== "string" || row.length !== POSSE_MASCOT_CELL_WIDTH * 2) {
      throw new Error("Posse mascot raster width is invalid");
    }
  }
}

function brailleChar(bits) {
  return bits === 0 ? " " : String.fromCodePoint(0x2800 + bits);
}

function rasterToBrailleCells(rows) {
  assertRasterShape(rows);
  const out = [];
  for (let y = 0; y < rows.length; y += 4) {
    const line = [];
    for (let x = 0; x < rows[0].length; x += 2) {
      let bits = 0;
      let layer = null;
      for (const [dy, dx, bit] of BRAILLE_DOTS) {
        const pixel = rows[y + dy]?.[x + dx] || ".";
        if (pixel === ".") continue;
        bits |= bit;
        if (pixel === "R") layer = "rider";
        else if (!layer) layer = "horse";
      }
      line.push({ ch: brailleChar(bits), layer });
    }
    out.push(line);
  }
  return out;
}

const BRAILLE_FRAMES = Object.fromEntries(
  Object.entries(RASTER_FRAMES).map(([key, rows]) => [key, rasterToBrailleCells(rows)])
);

function cellColor(layer, colors) {
  if (layer === "dust") return colors.dim || "";
  if (layer === "mascot") return colors.orange || colors.yellow || colors.brightWhite || colors.white || "";
  return "";
}

function paintCells(cells, colors = NO_COLOR) {
  const palette = { ...NO_COLOR, ...colors };
  let active = "";
  let out = "";

  for (const cell of cells) {
    const next = cellColor(cell.layer, palette);
    if (next !== active) {
      if (active) out += palette.reset;
      if (next) out += next;
      active = next;
    }
    out += cell.ch;
  }

  if (active) out += palette.reset;
  return out;
}

function makeLane(width) {
  return Array.from({ length: POSSE_MASCOT_CELL_HEIGHT }, () =>
    Array.from({ length: width }, () => ({ ch: " ", layer: null, priority: 0 })));
}

function putCell(lane, row, col, ch, layer, priority) {
  if (row < 0 || row >= lane.length) return;
  if (col < 0 || col >= lane[row].length) return;
  if (!ch || ch === " ") return;
  if (priority < lane[row][col].priority) return;
  lane[row][col] = { ch, layer, priority };
}

function putText(lane, row, col, text, layer, priority) {
  let x = col;
  for (const ch of String(text || "")) {
    putCell(lane, row, x, ch, layer, priority);
    x++;
  }
}

function putSprite(lane, rows, col, layer, priority) {
  for (let row = 0; row < POSSE_MASCOT_CELL_HEIGHT; row++) {
    const cells = rows[row] || [];
    for (let i = 0; i < cells.length; i++) {
      const cell = typeof cells[i] === "string" ? { ch: cells[i] } : cells[i];
      putCell(lane, row, col + i, cell.ch, layer || cell.layer, priority);
    }
  }
}

function dustFrame(tick) {
  return [" . ", "  .", " .' ", "   "][Math.floor(tick / 2) % 4];
}

function addDust(lane, { position, direction, tick }) {
  const dust = dustFrame(tick);
  if (!dust.trim()) return null;
  const dustWidth = dust.length;
  const row = POSSE_MASCOT_CELL_HEIGHT - 1;

  if (direction === "right") {
    putText(lane, row, position - dustWidth - 1, dust, "dust", 2);
    return;
  }
  putText(lane, row, position + POSSE_MASCOT_CELL_WIDTH + 1, dust, "dust", 2);
}

function renderLane(lane, colors = NO_COLOR) {
  return lane.map((cells) => paintCells(cells, colors));
}

function composeLane(spriteCells, { laneWidth, position, direction, tick, colors }) {
  const safeLane = Math.max(POSSE_MASCOT_CELL_WIDTH, laneWidth | 0);
  const safePosition = Math.max(0, Math.min(position | 0, safeLane - POSSE_MASCOT_CELL_WIDTH));
  const lane = makeLane(safeLane);
  addDust(lane, { position: safePosition, direction, tick });
  putSprite(lane, spriteCells, safePosition, "mascot", 4);
  return renderLane(lane, colors);
}

export function renderPosseMascotFrame({ tick = 0, laneWidth = 0, colors = NO_COLOR } = {}) {
  const safeLane = laneWidth | 0;
  if (safeLane < POSSE_MASCOT_CELL_WIDTH + 4) return null;

  const travel = Math.max(1, safeLane - POSSE_MASCOT_CELL_WIDTH);
  const period = travel * 2;
  const phase = ((tick % period) + period) % period;
  const movingRight = phase <= travel;
  const position = movingRight ? phase : period - phase;
  const leg = Math.floor(tick / 2) % 2 === 0 ? "A" : "B";
  const direction = movingRight ? "right" : "left";
  const key = `${movingRight ? "r" : "l"}${leg}`;

  return composeLane(BRAILLE_FRAMES[key], {
    laneWidth: safeLane,
    position,
    direction,
    tick,
    colors,
  });
}

export function renderPosseMascotSprite({ direction = "right", leg = "A", colors = NO_COLOR } = {}) {
  const facing = direction === "left" ? "l" : "r";
  const frameLeg = leg === "B" ? "B" : "A";
  return BRAILLE_FRAMES[`${facing}${frameLeg}`].map((cells) => paintCells(cells, colors));
}
