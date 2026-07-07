// @ts-check
//
// Framed, colored boot progress card rendered to plain stdout while the TUI is
// not yet attached. One outer box, two labeled sections:
//
//   ╭─ posse ──────── boot · Ns ─╮
//   │  <hero readiness gauge>    │
//   │ ▌ boot ─────────────── N%  │   readiness groups, one collapsed row each
//   │     ✓ scheduler  ready…    │   (providers shows per-provider chips)
//   │ ▌ code ledger ─────── N%   │   per-language atlas-ledger × scip stage
//   │     <3-stage grid>         │   grid + global merge bar, then encode
//   ╰────────────────────────────╯
//
// The grid's three columns (atlas parse · scip generate · scip parse) are
// derived at render time from the two stored sides — SCIP is tracked as one
// side that walks idle → indexing (generate) → intaking (parse) → done.
//
// State lives in a `BootPanel` instance returned by `createBootPanel`. The
// caller drives it via `updateStep(label, patch)`, `updateLang(lang, side,
// patch)`, `updateZip`, `updateTree`, `updateEncode`. `lines()` returns the
// rendered rows.

const SECTION_ORDER = ["scheduler", "workspace", "providers"];
const SECTION_LABELS = {
  scheduler: "scheduler",
  workspace: "workspace",
  providers: "providers",
};
// A gentle "exploding pulse": a tiny dot / thin cross that blinks, swelling to
// an open starburst and contracting back — rather than a rotating |/\ wiggle.
// All open-weight glyphs (no heavy filled ✶/✻/✽) so no single frame "pops"
// brighter than the rest, and the cycle reads as a smooth breath. ·/✢ are the
// thin blink; ✺ is the open bloom.
const SPINNER_FRAMES = ["·", "✢", "✺", "✢"];
// Advance the spinner on a wall-clock cadence (not per render): boot fires
// bursts of forced renders during indexing, so a render-counter spinner would
// stutter/race. Time-based keeps the pulse steady regardless of render rate.
const SPINNER_FRAME_MS = 130;

// Strip ANSI escape sequences so we can measure visible width when ANSI
// colors push the string length past the column allotment.
const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const visibleLen = (s) => String(s || "").replace(ANSI_RE, "").length;
const padVisible = (s, width) => {
  const len = visibleLen(s);
  if (len >= width) return s;
  return `${s}${" ".repeat(width - len)}`;
};
const truncateVisible = (s, width) => {
  const str = String(s || "");
  if (visibleLen(str) <= width) return str;
  // Walk forward counting only visible chars, preserve escapes around them.
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < width - 1) {
    const ch = str[i];
    if (ch === "\x1b") {
      const end = str.indexOf("m", i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += ch;
    visible++;
    i++;
  }
  return `${out}…`;
};

// A "cascade" detail is the secondary message a step gets when it only failed
// because an upstream prerequisite wasn't ready (e.g. worktree cleanup
// "blocked: git not ready" after git itself failed). These are noise — the
// root failure already explains it — so they're kept out of both the rows and
// the error pipe. Match the actual root error ("not a git repository") stays.
const CASCADE_DETAIL_RE = /(?:^\s*blocked\b)|\bnot ready\b/iu;
const isCascadeDetail = (detail) => CASCADE_DETAIL_RE.test(String(detail || ""));

/**
 * @param {{
 *   C: Record<string, string>,
 *   columns?: () => number,
 * }} deps
 */
export function createBootPanel({ C, columns = () => 100, onChange = null }) {
  const startedAt = Date.now();

  // Serialized step list for the optional onChange mirror (bridge
  // instance_status). Kept tiny: identifiers and counters only.
  const serializeSteps = () =>
    [...steps.entries()].map(([label, step]) => ({
      label,
      status: step.status,
      ...(Number.isFinite(Number(step.percent)) ? { percent: Number(step.percent) } : {}),
      ...(step.detail ? { detail: String(step.detail) } : {}),
      section: step.section,
    }));

  const notifyChange = () => {
    if (typeof onChange !== "function") return;
    try {
      onChange(serializeSteps());
    } catch {
      // Status mirroring must never break boot rendering.
    }
  };

  /**
   * Each step row: { status: 'pending'|'running'|'ok'|'warning'|'failed'|'skipped'|'deferred',
   *                  detail: string, percent: number|null, section: string,
   *                  startedAt: number, finishedAt: number|null }
   * @type {Map<string, { status: string, detail: string, percent: number | null, section: string, startedAt: number, finishedAt: number | null }>}
   */
  const steps = new Map();
  // Insertion order per section dictates render order.
  /** @type {Map<string, string[]>} */
  const sectionOrder = new Map();

  /**
   * Per-language atlas + scip state.
   * side: { state: 'idle'|'indexing'|'intaking'|'parsing'|'encoding'|'done'|'skipped'|'deferred'|'failed',
   *         current: number, total: number, percent: number|null,
   *         detail: string, startedAt: number, finishedAt: number|null }
   * @type {Map<string, { atlas: any, scip: any }>}
   */
  const langs = new Map();
  /** @type {string[]} */
  const langOrder = [];

  /**
   * The post-intake "zip" (view merge) — a single global step that runs once
   * ATLAS + SCIP have landed in the ledger and folds both layers into the
   * searchable view, before the TUI starts.
   * @type {{ state: string, percent: number | null, detail: string, startedAt: number, finishedAt: number | null } | null}
   */
  let zip = null;

  const ensureLang = (lang) => {
    if (!langs.has(lang)) {
      langs.set(lang, { atlas: null, scip: null });
      langOrder.push(lang);
    }
    return langs.get(lang);
  };

  /**
   * @param {string} label
   * @param {{ section?: string, status?: string, detail?: string, percent?: number | null, startedAt?: number, finishedAt?: number | null, [k: string]: any }} [patch]
   */
  const updateStep = (label, patch = {}) => {
    const { section = "internal", ...rest } = patch;
    const previous = steps.get(label) || {
      status: "running",
      detail: "",
      percent: null,
      section,
      startedAt: Date.now(),
      finishedAt: null,
    };
    const merged = { ...previous, ...rest, section };
    // A pre-seeded pending step that's now actually starting: reset the clock
    // so its elapsed time counts from the real start, not from boot t=0.
    if (previous.status === "pending" && rest.status && rest.status !== "pending") {
      merged.startedAt = Date.now();
    }
    const terminalStatus = rest.status === "ok"
      || rest.status === "warning"
      || rest.status === "failed"
      || rest.status === "skipped"
      || rest.status === "deferred";
    if (rest.status && !terminalStatus) {
      merged.finishedAt = null;
    }
    if (terminalStatus && !merged.finishedAt) {
      merged.finishedAt = Date.now();
    }
    steps.set(label, merged);
    if (!sectionOrder.has(section)) sectionOrder.set(section, []);
    const arr = sectionOrder.get(section);
    if (!arr.includes(label)) arr.push(label);
    notifyChange();
  };

  const updateLang = (lang, side, patch = {}) => {
    if (!lang || (side !== "atlas" && side !== "scip")) return;
    const entry = ensureLang(lang);
    const previous = entry[side] || {
      state: "idle",
      current: 0,
      total: 0,
      percent: null,
      detail: "",
      startedAt: Date.now(),
      finishedAt: null,
    };
    const merged = { ...previous, ...patch };
    // Monotonic progress WITHIN a state: at phase edges the indexer can emit a
    // late "0/N" event (e.g. an encoding row that already hit 100% gets a fresh
    // 0/total just as the view/zip merge kicks off), which would visibly snap
    // the bar back to 0%. While the state is unchanged and still active, never
    // let percent/current regress — a real reset comes with a state change
    // (parsing→encoding) or a terminal state, both of which bypass this guard.
    const sameActiveState = merged.state === previous.state
      && previous.state !== "idle" && previous.state !== "waiting";
    if (sameActiveState) {
      if (Number.isFinite(previous.percent) && Number.isFinite(merged.percent) && merged.percent < previous.percent) {
        merged.percent = previous.percent;
      }
      if (Number.isFinite(previous.current) && Number.isFinite(merged.current)
        && merged.total === previous.total && merged.current < previous.current) {
        merged.current = previous.current;
      }
    }
    // Liveness stamp for the stale-cell pulse: a state change or forward
    // motion counts as advance; a same-value repaint (heartbeat) does not.
    const advanced = merged.state !== previous.state
      || (Number.isFinite(merged.percent) && merged.percent !== previous.percent)
      || (Number.isFinite(merged.current) && merged.current !== previous.current);
    merged.advancedAt = advanced ? Date.now() : (previous.advancedAt ?? Date.now());
    if (merged.state === "done" || merged.state === "skipped" || merged.state === "deferred" || merged.state === "failed") {
      if (!merged.finishedAt) merged.finishedAt = Date.now();
    }
    entry[side] = merged;
  };

  const updateZip = (patch = {}) => {
    const previous = zip || {
      state: "idle", percent: null, detail: "", startedAt: Date.now(), finishedAt: null,
    };
    const merged = { ...previous, ...patch };
    // First transition out of idle: start the clock now.
    if (previous.state === "idle" && patch.state && patch.state !== "idle" && !patch.startedAt) {
      merged.startedAt = Date.now();
    }
    if ((merged.state === "done" || merged.state === "skipped" || merged.state === "failed") && !merged.finishedAt) {
      merged.finishedAt = Date.now();
    }
    zip = merged;
  };

  /**
   * The tree-derived build (containment tree + scope sidecar + compression
   * seeds) — runs inside the view build right after the merge, before encode.
   * Rendered as its own bottom bar so a failing/skipped tree build is visible
   * instead of silently riding inside the merge bar.
   * @type {{ state: string, percent: number | null, detail: string, startedAt: number, finishedAt: number | null } | null}
   */
  let tree = null;
  const updateTree = (patch = {}) => {
    const previous = tree || {
      state: "idle", percent: null, detail: "", startedAt: Date.now(), finishedAt: null,
    };
    const merged = { ...previous, ...patch };
    if (previous.state === "idle" && patch.state && patch.state !== "idle" && !patch.startedAt) {
      merged.startedAt = Date.now();
    }
    // Monotonic within the building phase — late "0/N" ticks shouldn't snap back.
    if (merged.state === "building" && previous.state === "building"
      && Number.isFinite(previous.percent) && Number.isFinite(merged.percent)
      && merged.percent < previous.percent) {
      merged.percent = previous.percent;
    }
    if ((merged.state === "done" || merged.state === "skipped" || merged.state === "failed") && !merged.finishedAt) {
      merged.finishedAt = Date.now();
    }
    tree = merged;
  };

  /**
   * The embedding-encode pass — a single global step that runs AFTER the view
   * merge (zip), encoding the merged view's symbols into vectors. Rendered as
   * its own bottom bar next to zip so the real pipeline order reads clearly:
   * atlas parse (rows) → merge (zip bar) → encode (this bar).
   * @type {{ state: string, percent: number | null, detail: string, startedAt: number, finishedAt: number | null } | null}
   */
  let encode = null;
  const updateEncode = (patch = {}) => {
    const previous = encode || {
      state: "idle", percent: null, detail: "", startedAt: Date.now(), finishedAt: null,
    };
    const merged = { ...previous, ...patch };
    if (previous.state === "idle" && patch.state && patch.state !== "idle" && !patch.startedAt) {
      merged.startedAt = Date.now();
    }
    // Monotonic within the building phase — late "0/N" ticks shouldn't snap back.
    if (merged.state === "building" && previous.state === "building"
      && Number.isFinite(previous.percent) && Number.isFinite(merged.percent)
      && merged.percent < previous.percent) {
      merged.percent = previous.percent;
    }
    if ((merged.state === "done" || merged.state === "skipped" || merged.state === "failed") && !merged.finishedAt) {
      merged.finishedAt = Date.now();
    }
    encode = merged;
  };

  // === RENDER ===
  // A framed two-section card:
  //   ╭─ posse ──── boot · Ns ─╮
  //   │  <hero readiness gauge> │
  //   │ ▌ boot ──────────── N% │   collapsed readiness groups
  //   │ ▌ code ledger ───── N% │   atlas-ledger × scip stage grid + tail
  //   ╰────────────────────────╯
  // The width is fixed (never bounces as detail streams) and every glyph is
  // colour-guarded so partial `C` maps (tests) render plain instead of "undefined".
  const col = (k) => C[k] || "";
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const animFrame = () => Math.floor((Date.now() - startedAt) / SPINNER_FRAME_MS);
  const spinner = () => `${col("cyan")}${SPINNER_FRAMES[animFrame() % SPINNER_FRAMES.length]}${col("reset")}`;
  const formatElapsed = (ms) => (ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)}m`
    : `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`);

  // ---- geometry — a stable card whose width never bounces as detail streams.
  const CELL_BAR = 7;        // per-stage gauge width inside a grid cell
  const CELL_W = 12;         // bar(7) + space + 4-wide right-justified status
  const LABEL_INDENT = 6;
  const LANG_LABEL_W = 8;
  const COL_GAP = 3;
  const GRID_W = LABEL_INDENT + LANG_LABEL_W + 2 + CELL_W * 3 + COL_GAP * 2;
  const TAIL_BAR = 26;       // wide bar for the global merge / encode rows
  const PANEL_MIN_INNER = 66;
  const ATLAS_OFF = LABEL_INDENT + LANG_LABEL_W + 2;   // grid column offsets…
  const GEN_OFF = ATLAS_OFF + CELL_W + COL_GAP;
  const PARSE_OFF = GEN_OFF + CELL_W + COL_GAP;

  const innerWidth = () => {
    const target = Math.max(PANEL_MIN_INNER, GRID_W);
    const cols = Number(columns()) || 100;
    return Math.min(Math.max(40, cols - 4), target);
  };
  const line = (content) => {
    const w = innerWidth();
    return `${col("dim")}│${col("reset")}${padVisible(truncateVisible(content, w), w)}${col("dim")}│${col("reset")}`;
  };
  const blank = () => line("");

  let footer = "";
  let atlasNotice = [];
  // The old neural-network banner path still calls setFooter with an array of
  // banner rows. Ignore that retired shape, but keep a single-line footer for
  // boot actions such as the ONNX background ripcord.
  const setFooter = (value = "") => {
    if (Array.isArray(value)) return;
    footer = String(value || "").replace(/\s+/g, " ").trim();
  };
  const normalizeNoticeLine = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
  const setAtlasNotice = (value = "") => {
    const raw = Array.isArray(value) ? value : String(value || "").split(/\r?\n/u);
    atlasNotice = raw.map(normalizeNoticeLine).filter(Boolean).slice(0, 2);
  };

  // ---- gauges ----
  const gaugeBar = (percent, width, colorKey = "green") => {
    if (percent == null || !Number.isFinite(Number(percent))) {
      // Indeterminate — animate a moving block so it reads as active.
      const pos = animFrame() % width;
      let bar = "";
      for (let i = 0; i < width; i++) {
        bar += (i === pos || i === (pos + 1) % width)
          ? `${col(colorKey)}█${col("reset")}`
          : `${col("dim")}░${col("reset")}`;
      }
      return bar;
    }
    const filled = Math.round((clamp(percent) / 100) * width);
    return `${col(colorKey)}${"█".repeat(filled)}${col("reset")}${col("dim")}${"░".repeat(width - filled)}${col("reset")}`;
  };

  // A fixed 12-col grid cell: a 7-wide bar + a 4-wide right-justified status
  // field ("38%" / "✓" / "—" / …). kind ∈ active|done|wait|skip|fail|defer.
  const cell = (kind, percent, opts = {}) => {
    const colorKey = opts.colorKey || "green";
    let bar;
    let fieldRaw;
    let fieldColored;
    // A bar that has reached 100% reads as a check, not "100%" — a full stage
    // is done even before its terminal state event lands.
    if (kind === "active" && clamp(percent) >= 100) kind = "done";
    if (kind === "active") {
      const filled = Math.round((clamp(percent) / 100) * CELL_BAR);
      if (opts.pulse) {
        // Stale-progress pulse: the percent hasn't moved lately (silent
        // indexer tail, native convert hold), so blink the block at the fill
        // boundary — the cell reads as alive without inventing progress. The
        // controller's forced-render tick repaints often enough to animate.
        const on = animFrame() % 2 === 0;
        const idx = Math.min(filled, CELL_BAR - 1);
        let pulsed = "";
        for (let i = 0; i < CELL_BAR; i++) {
          const lit = i === idx ? on : i < filled;
          pulsed += lit ? `${col(colorKey)}█${col("reset")}` : `${col("dim")}░${col("reset")}`;
        }
        bar = pulsed;
      } else {
        bar = `${col(colorKey)}${"█".repeat(filled)}${col("reset")}${col("dim")}${"░".repeat(CELL_BAR - filled)}${col("reset")}`;
      }
      fieldRaw = `${clamp(percent)}%`;
      fieldColored = `${col("bold")}${col(colorKey)}${fieldRaw}${col("reset")}`;
    } else if (kind === "done") {
      bar = `${col("green")}${"█".repeat(CELL_BAR)}${col("reset")}`;
      fieldRaw = "✓";
      fieldColored = `${col("green")}✓${col("reset")}`;
    } else {
      bar = `${col("dim")}${"░".repeat(CELL_BAR)}${col("reset")}`;
      const glyphs = { wait: ["—", "dim"], skip: ["⊘", "dim"], fail: ["✗", "red"], defer: ["/", "yellow"] };
      const [g, ck] = glyphs[kind] || ["—", "dim"];
      fieldRaw = g;
      fieldColored = `${col(ck)}${g}${col("reset")}`;
    }
    const lead = " ".repeat(Math.max(0, 4 - visibleLen(fieldRaw)));
    return `${bar} ${lead}${fieldColored}`;
  };

  // Per-language stage "kinds" — the grid shows three columns derived from the
  // two stored sides. SCIP is stored as one side that walks
  // idle → indexing (generate) → intaking (parse) → done; split it back out.
  // Active cells whose progress hasn't advanced lately carry a pulse flag so
  // the bar can blink instead of reading as frozen.
  const STALE_PULSE_MS = 3000;
  const activeOpts = (side) => {
    const at = Number(side?.advancedAt);
    return { pulse: Number.isFinite(at) && Date.now() - at > STALE_PULSE_MS };
  };
  const atlasKind = (a) => {
    if (!a) return ["wait", null];
    if (a.state === "done") return ["done", 100];
    if (a.state === "skipped") return ["skip", null];
    if (a.state === "failed") return ["fail", null];
    if (a.state === "deferred") return ["defer", null];
    if (a.state === "waiting" || a.state === "idle") return ["wait", null];
    return ["active", Number.isFinite(a.percent) ? a.percent : 0, activeOpts(a)];
  };
  const scipGenKind = (s) => {
    if (!s) return ["wait", null];
    if (s.state === "skipped") return ["skip", null];
    if (s.state === "deferred") return ["defer", null];
    if (s.state === "failed") return ["fail", null];
    if (s.state === "done" || s.state === "intaking") return ["done", 100];
    if (s.state === "indexing") return ["active", Number.isFinite(s.percent) ? s.percent : 0, activeOpts(s)];
    return ["wait", null];
  };
  const scipParseKind = (s) => {
    if (!s) return ["wait", null];
    if (s.state === "skipped") return ["skip", null];
    if (s.state === "deferred") return ["defer", null];
    if (s.state === "failed") return ["fail", null];
    if (s.state === "done") return ["done", 100];
    if (s.state === "intaking") return ["active", Number.isFinite(s.percent) ? s.percent : 0, activeOpts(s)];
    return ["wait", null];
  };

  // ---- runtime band status ----
  // The boot section is a CHECKLIST of discrete gates (scheduler lock,
  // workspace, provider auth) — not smooth progress — so it carries a word
  // status, never a gauge: "ready" once every group resolves, "needs attn" if
  // anything failed, else "<ready>/<total>" groups so far. The real continuous
  // percentage lives on the atlas-ledger band below, where it actually means
  // something. A group = one rendered runtime row (scheduler / workspace /
  // providers).
  const isStepResolved = (s) => s.status === "ok" || s.status === "warning" || s.status === "skipped" || s.status === "deferred";
  const runtimeGroups = () => {
    const groups = [];
    for (const section of SECTION_ORDER) {
      const labels = sectionOrder.get(section) || [];
      const stepList = labels.map((l) => steps.get(l)).filter(Boolean);
      if (stepList.length > 0) groups.push(stepList);
    }
    return groups;
  };
  const runtimeStatusText = () => {
    const groups = runtimeGroups();
    if (groups.length === 0) return `${col("dim")}…${col("reset")}`;
    if (groups.some((g) => g.some((s) => s.status === "failed"))) {
      return `${col("red")}needs attn${col("reset")}`;
    }
    const hasWarning = groups.some((g) => g.some((s) => s.status === "warning"));
    const ready = groups.filter((g) => g.every(isStepResolved)).length;
    if (ready === groups.length && hasWarning) return `${col("yellow")}warnings${col("reset")}`;
    if (ready === groups.length) return `${col("green")}ready${col("reset")}`;
    return `${col("dim")}${ready}/${groups.length}${col("reset")}`;
  };

  // ---- bands / borders ----
  const bandRow = (label, statText, spineKey) => {
    const w = innerWidth();
    const prefix = `  ${col(spineKey)}▌${col("reset")} ${col("bold")}${label}${col("reset")} `;
    const suffix = ` ${col("dim")}${statText}${col("reset")}  `;
    const dashN = Math.max(1, w - visibleLen(prefix) - visibleLen(suffix));
    return line(`${prefix}${col("dim")}${"─".repeat(dashN)}${col("reset")}${suffix}`);
  };
  const topBorder = () => {
    const w = innerWidth();
    const right = `boot · ${formatElapsed(Date.now() - startedAt)}`;
    // visible width between corners = "─ "(2)+"posse "(6)+dashN+" "(1)+right+" ─"(2)
    const dashN = Math.max(1, w - (11 + visibleLen(right)));
    return `${col("dim")}╭─ ${col("reset")}${col("bold")}${col("cyan")}posse${col("reset")}${col("dim")} ${"─".repeat(dashN)} ${right} ─╮${col("reset")}`;
  };
  const bottomBorder = () => `${col("dim")}╰${"─".repeat(innerWidth())}╯${col("reset")}`;

  // ---- boot section: one collapsed row per readiness group ----
  const sectionGlyph = (stepList) => {
    if (stepList.some((s) => s.status === "failed")) return `${col("red")}✗${col("reset")}`;
    if (stepList.some((s) => s.status === "running" || s.status === "pending")) return spinner();
    if (stepList.some((s) => s.status === "warning")) return `${col("yellow")}!${col("reset")}`;
    if (stepList.length > 0 && stepList.every((s) => s.status === "ok")) return `${col("green")}✓${col("reset")}`;
    if (stepList.length > 0 && stepList.every((s) => s.status === "skipped")) return `${col("dim")}⊘${col("reset")}`;
    return spinner();
  };
  const chipFor = (label, padTo = 0) => {
    const s = steps.get(label);
    const g = s.status === "ok" ? `${col("green")}✓${col("reset")}`
      : s.status === "warning" ? `${col("yellow")}!${col("reset")}`
        : s.status === "failed" ? `${col("red")}✗${col("reset")}`
          : s.status === "skipped" ? `${col("dim")}⊘${col("reset")}`
            : s.status === "deferred" ? `${col("yellow")}/${col("reset")}`
              : `${col("dim")}…${col("reset")}`;
    const lbl = padTo > 0 ? padVisible(label, padTo) : label;
    return `${lbl} ${g}`;
  };
  // Body for a section with work still in flight: lead with whatever is
  // actively running (animated, with its live detail) so the checklist always
  // shows what it's doing, then pending steps, then already-resolved ones as
  // plain chips. Without this, fixed insertion order leaves finished chips on
  // the left and pushes the running step past the truncated right edge.
  // In-flight non-provider group (scheduler / workspace): one moving line, not a
  // list. Sequential phases (lock → orphan → pre-loop) share a row, so showing
  // every step as a chip overflowed and truncated mid-word. Instead surface the
  // single current activity (the running step's live detail); between steps show
  // a quiet done/total so the row still reads as advancing. The leading section
  // glyph already spins, so the body carries no spinner of its own.
  const runningSectionBody = (labels) => {
    const entries = labels.map((l) => [l, steps.get(l)]).filter(([, s]) => s);
    // Most-recently-STARTED running step wins (ties → later insertion), not
    // first-inserted: the background dependency check stays "running" for most
    // of boot, and by insertion order it would pin the row to "checking
    // packages" while git ready / worktree cleanup advance invisibly behind
    // it — making a healthy boot read as frozen.
    const running = entries.filter(([, s]) => s.status === "running");
    const active = running.length > 0
      ? running.reduce((latest, entry) => (entry[1].startedAt >= latest[1].startedAt ? entry : latest))
      : null;
    if (active) return active[1].detail || active[0];
    const done = entries.filter(([, s]) => isStepResolved(s)).length;
    if (done > 0 && done < entries.length) {
      return `${col("dim")}${done}/${entries.length} done${col("reset")}`;
    }
    return `${col("dim")}starting…${col("reset")}`;
  };
  const sectionElapsed = (stepList) => {
    const starts = stepList.map((s) => s.startedAt).filter(Number.isFinite);
    const ends = stepList.map((s) => s.finishedAt).filter(Number.isFinite);
    if (starts.length === 0 || ends.length === 0) return "";
    return formatElapsed(Math.max(...ends) - Math.min(...starts));
  };
  const renderBootSection = () => {
    const out = [];
    for (const section of SECTION_ORDER) {
      const labels = sectionOrder.get(section) || [];
      const stepList = labels.map((l) => steps.get(l)).filter(Boolean);
      if (stepList.length === 0) continue;
      const glyph = sectionGlyph(stepList);
      const name = padVisible(SECTION_LABELS[section] || section, 10);
      const allOk = stepList.every((s) => s.status === "ok");
      const allResolved = stepList.every(isStepResolved);
      const hasWarning = stepList.some((s) => s.status === "warning");
      const allSkipped = stepList.every((s) => s.status === "skipped");
      if (section === "providers") {
        // All authed: a clean dotted name list — the row's own ✓ already
        // carries the health, so per-name glyphs are just noise. Anything
        // not-ok: per-provider chips ordered worst-first, so a failure survives
        // truncation; the full reason still renders in the notes section below.
        const provs = labels.map((l) => [l, steps.get(l)]).filter(([, s]) => s);
        const anyNotOk = provs.some(([, s]) => s.status !== "ok");
        let body;
        if (!anyNotOk) {
          body = provs.map(([l]) => l).join(`${col("dim")} · ${col("reset")}`);
        } else {
          const rank = (status) => (status === "failed" ? 0
            : status === "warning" ? 1
              : status === "deferred" ? 2
                : (status === "running" || status === "pending") ? 3 : 4);
          body = provs
            .sort((a, b) => rank(a[1].status) - rank(b[1].status))
            .map(([l]) => chipFor(l))
            .join("   ");
        }
        out.push(line(`    ${glyph} ${name} ${body}`));
        continue;
      }
      let body;
      if (allOk) {
        const el = sectionElapsed(stepList);
        body = `${col("dim")}ready${el ? ` · ${el}` : ""}${col("reset")}`;
      } else if (hasWarning && allResolved) {
        body = `${col("yellow")}warning${col("reset")}`;
      } else if (allSkipped) {
        body = `${col("dim")}skipped${col("reset")}`;
      } else {
        body = runningSectionBody(labels);
      }
      out.push(line(`    ${glyph} ${name} ${body}`));
    }
    return out;
  };

  // ---- code ledger: atlas-ledger × scip 3-stage grid + merge/encode tail ----
  const placeCols = (items) => {
    const w = innerWidth();
    const buf = new Array(w).fill(" ");
    for (const [text, off] of items) {
      for (let i = 0; i < text.length && off + i < w; i++) buf[off + i] = text[i];
    }
    return buf.join("");
  };
  const fracOf = (kind, percent) => {
    if (kind === "active") return clamp(percent) / 100;
    if (kind === "wait") return 0;
    return 1; // done / skip / fail / defer all count as resolved
  };
  const tailFrac = (st) => {
    if (!st || st.state === "idle") return 0;
    if (st.state === "done" || st.state === "skipped" || st.state === "failed") return 1;
    return Number.isFinite(st.percent) ? clamp(st.percent) / 100 : 0;
  };
  // Once the view merge or embedding encode phase has started, the
  // per-language ledger inputs have necessarily landed. Cache-hot boot paths
  // may never emit atlas parse progress for a language, so render those waiting
  // cells as resolved instead of making the ledger header look stuck while the
  // independent embedding tail is still encoding.
  const ledgerInputsLanded = () => {
    const activeTail = (st) => st && st.state && st.state !== "idle";
    return activeTail(zip) || activeTail(tree) || activeTail(encode);
  };
  const resolveWaitingAfterLedgerInput = (kind) => {
    if (!ledgerInputsLanded()) return kind;
    return kind[0] === "wait" ? ["done", 100] : kind;
  };
  const effectiveAtlasKind = (entry) => resolveWaitingAfterLedgerInput(atlasKind(entry));
  const effectiveScipGenKind = (entry) => resolveWaitingAfterLedgerInput(scipGenKind(entry));
  const effectiveScipParseKind = (entry) => resolveWaitingAfterLedgerInput(scipParseKind(entry));
  const codeLedgerPercent = (visibleLangs) => {
    let units = 0;
    let sum = 0;
    for (const lang of visibleLangs) {
      const e = langs.get(lang);
      sum += fracOf(...effectiveAtlasKind(e.atlas)); units += 1;
      sum += fracOf(...effectiveScipGenKind(e.scip)); units += 1;
      sum += fracOf(...effectiveScipParseKind(e.scip)); units += 1;
    }
    sum += tailFrac(zip); units += 1;
    // The tree refresh only emits events when a view build actually runs (and
    // only from builders new enough to emit them) — count it as a unit once it
    // has started so its absence can't cap the band below 100%.
    if (tree && tree.state !== "idle") { sum += tailFrac(tree); units += 1; }
    return units === 0 ? 0 : Math.round((sum / units) * 100);
  };
  const tailRow = (label, st) => {
    const labelCell = `${col("dim")}${padVisible(label, LANG_LABEL_W)}${col("reset")}`;
    const prefix = `${" ".repeat(LABEL_INDENT)}${labelCell}  `;
    if (!st || st.state === "idle") {
      return line(`${prefix}${col("dim")}${"░".repeat(TAIL_BAR)}${col("reset")}  ${col("dim")}waiting${col("reset")}`);
    }
    if (st.state === "done") {
      const el = formatElapsed((st.finishedAt || Date.now()) - st.startedAt);
      const tail = st.detail ? ` ${col("dim")}· ${st.detail}${col("reset")}` : "";
      return line(`${prefix}${col("green")}${"█".repeat(TAIL_BAR)}${col("reset")}  ${col("green")}✓${col("reset")} ${col("dim")}${el}${col("reset")}${tail}`);
    }
    if (st.state === "skipped") {
      return line(`${prefix}${col("dim")}${"░".repeat(TAIL_BAR)}${col("reset")}  ${col("dim")}⊘ ${st.detail || "skipped"}${col("reset")}`);
    }
    if (st.state === "failed") {
      return line(`${prefix}${col("dim")}${"░".repeat(TAIL_BAR)}${col("reset")}  ${col("red")}✗ ${st.detail || "failed"}${col("reset")}`);
    }
    const pctTxt = Number.isFinite(st.percent)
      ? `${col("bold")}${col("green")}${clamp(st.percent)}%${col("reset")}`
      : `${col("dim")}…${col("reset")}`;
    const detail = st.detail ? ` ${col("dim")}${st.detail}${col("reset")}` : "";
    return line(`${prefix}${gaugeBar(st.percent, TAIL_BAR, "green")}  ${pctTxt}${detail}`);
  };
  const renderCodeLedger = () => {
    const visibleLangs = langOrder.filter((l) => {
      const entry = langs.get(l);
      return entry && (entry.atlas || entry.scip);
    });
    if (visibleLangs.length === 0) return { rows: [], percent: 0 };
    const rows = [];
    // Super-headers ("atlas ledger" over one stage, "scip" over two), a rule
    // beneath each, then the per-stage labels.
    rows.push(line(`${col("bold")}${col("dim")}${placeCols([["atlas", ATLAS_OFF], ["scip", GEN_OFF]])}${col("reset")}`));
    rows.push(line(`${col("dim")}${placeCols([["─".repeat(CELL_W), ATLAS_OFF], ["─".repeat(CELL_W * 2 + COL_GAP), GEN_OFF]])}${col("reset")}`));
    rows.push(line(`${col("dim")}${placeCols([["parse", ATLAS_OFF], ["generate", GEN_OFF], ["parse", PARSE_OFF]])}${col("reset")}`));
    for (const lang of visibleLangs) {
      const e = langs.get(lang);
      const a = cell(...effectiveAtlasKind(e.atlas));
      const g = cell(...effectiveScipGenKind(e.scip));
      const p = cell(...effectiveScipParseKind(e.scip));
      const labelCell = `${col("dim")}${padVisible(lang, LANG_LABEL_W)}${col("reset")}`;
      rows.push(line(`${" ".repeat(LABEL_INDENT)}${labelCell}  ${a}${" ".repeat(COL_GAP)}${g}${" ".repeat(COL_GAP)}${p}`));
    }
    return { rows, percent: codeLedgerPercent(visibleLangs) };
  };

  // The notes section — error/warning explanations that can't ride inline
  // without bouncing the fixed-width rows. Failed (✗, red), warning (!,
  // yellow), and skipped (⊘, yellow); cascade "blocked/not ready" reasons filtered (the root
  // failure already explains them).
  const renderNotes = () => {
    const w = innerWidth();
    const noteLines = [];
    for (const section of SECTION_ORDER) {
      for (const label of (sectionOrder.get(section) || [])) {
        const step = steps.get(label);
        if (!step || !step.detail || isCascadeDetail(step.detail)) continue;
        if (!["failed", "warning", "skipped"].includes(step.status)) continue;
        const c = step.status === "failed" ? col("red") : col("yellow");
        const ic = step.status === "failed"
          ? `${col("red")}✗${col("reset")}`
          : step.status === "warning"
            ? `${col("yellow")}!${col("reset")}`
            : `${col("yellow")}⊘${col("reset")}`;
        const body = `  ${ic} ${label} ${col("dim")}·${col("reset")} ${c}${step.detail}${col("reset")}`;
        noteLines.push(line(truncateVisible(body, w)));
      }
    }
    if (noteLines.length === 0) return [];
    const divider = line(`  ${col("dim")}${"─".repeat(Math.max(0, w - 4))}${col("reset")}`);
    return [divider, ...noteLines];
  };
  const renderFooter = () => (footer ? [line(`  ${footer}`)] : []);
  const renderAtlasNotice = () => atlasNotice.map((text, index) => {
    const marker = index === 0 ? `${col("yellow")}!${col("reset")}` : " ";
    return line(`  ${marker} ${text}`);
  });

  const lines = () => {
    const out = [];
    out.push(topBorder());
    out.push(blank());
    out.push(bandRow("runtime", runtimeStatusText(), "cyan"));
    out.push(blank());
    out.push(...renderBootSection());
    const notes = renderNotes();
    if (notes.length > 0) {
      out.push(blank());
      out.push(...notes);
    }
    const ledger = renderCodeLedger();
    if (ledger.rows.length > 0) {
      out.push(blank());
      out.push(bandRow("atlas ledger", `${ledger.percent}%`, "magenta"));
      out.push(blank());
      out.push(...ledger.rows);
      out.push(blank());
      out.push(tailRow("merge", zip));
      out.push(tailRow("tree", tree));
      out.push(tailRow("encode", encode));
      const atlasNoticeRows = renderAtlasNotice();
      if (atlasNoticeRows.length > 0) {
        out.push(blank());
        out.push(...atlasNoticeRows);
      }
    }
    const footerRows = renderFooter();
    if (footerRows.length > 0) {
      out.push(blank());
      out.push(...footerRows);
    }
    out.push(blank());
    out.push(bottomBorder());
    return out;
  };

  return {
    updateStep,
    updateLang,
    updateZip,
    updateTree,
    updateEncode,
    setFooter,
    setAtlasNotice,
    lines,
    /**
     * Iterate the per-language matrix entries — used by the caller to
     * finalize any rows left in `waiting` when ATLAS boot returns from a
     * warm-cache skip path (no per-language events fire in that case).
     *
     * @returns {Iterable<[string, { atlas: any, scip: any }]>}
     */
    languageEntries: () => langs.entries(),
    get stepCount() { return steps.size; },
    get langCount() { return langs.size; },
    elapsedMs: () => Date.now() - startedAt,
  };
}
