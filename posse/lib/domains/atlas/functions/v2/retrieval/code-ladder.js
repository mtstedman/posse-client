// @ts-check
//
// Iris/code-mode ladder validator. Default mode is advisory so existing agents
// get policy signal without sudden hard failures.

const RUNG_BY_ACTION = Object.freeze({
  "symbol.card": 1,
  "code.skeleton": 2,
  "code.lens": 3,
  "code.window": 4,
});

const LADDER_STATE_LIMIT = 5000;
const LADDER_TTL_MS = 60 * 60 * 1000;

// Bounded advisory-policy cache keyed by session/target. This is the narrow
// module-level mutable state exception allowed for lib/functions helpers.
/** @type {Map<string, { seen: Set<number>, updatedAt: number }>} */
const LADDER_STATE = new Map();

/**
 * @param {{ action: keyof typeof RUNG_BY_ACTION, sessionId?: string | null, symbolId?: string | null, file?: string | null }} args
 */
export function recordCodeLadderStep(args) {
  const rung = RUNG_BY_ACTION[args.action];
  if (!rung) return;
  pruneLadderState();
  for (const key of ladderKeys(args)) {
    const entry = LADDER_STATE.get(key) || { seen: new Set(), updatedAt: 0 };
    entry.seen.add(rung);
    entry.updatedAt = Date.now();
    LADDER_STATE.delete(key);
    LADDER_STATE.set(key, entry);
  }
  pruneLadderState();
}

/**
 * @param {{ action: keyof typeof RUNG_BY_ACTION, sessionId?: string | null, symbolId?: string | null, file?: string | null, enforce?: boolean }} args
 */
export function validateCodeLadder(args) {
  const rung = RUNG_BY_ACTION[args.action];
  const requiredRungs = rung > 1
    ? Array.from({ length: rung - 1 }, (_, index) => index + 1)
    : [];
  if (requiredRungs.length === 0) {
    return { ok: true, complied: true, mode: args.enforce ? "enforce" : "warn", warnings: [], requiredRung: null, missingRungs: [] };
  }
  pruneLadderState();
  const seen = new Set();
  for (const key of ladderKeys(args)) {
    const entry = LADDER_STATE.get(key);
    if (!entry) continue;
    entry.updatedAt = Date.now();
    for (const value of entry.seen) seen.add(value);
  }
  const missingRungs = requiredRungs.filter((required) => !seen.has(required));
  const complied = missingRungs.length === 0;
  const missingActions = missingRungs.map(actionForRung);
  const warnings = complied ? [] : [`${args.action} was requested before ${formatActionList(missingActions)} for this target/session.`];
  return {
    ok: complied || !args.enforce,
    complied,
    mode: args.enforce ? "enforce" : "warn",
    warnings,
    requiredRung: missingRungs[0] ?? null,
    missingRungs,
  };
}

/**
 * @param {any} envelope
 * @param {ReturnType<typeof validateCodeLadder>} ladder
 * @param {{ action: keyof typeof RUNG_BY_ACTION, sessionId?: string | null, symbolId?: string | null, file?: string | null }} recordArgs
 */
export function annotateCodeLadder(envelope, ladder, recordArgs) {
  if (envelope?.ok && ladder.complied) recordCodeLadderStep(recordArgs);
  if (ladder.warnings.length > 0) {
    envelope.meta = {
      ...(envelope.meta || {}),
      ladderPolicy: {
        mode: ladder.mode,
        ok: ladder.ok,
        warnings: ladder.warnings,
        requiredRung: ladder.requiredRung,
      },
    };
  }
  return envelope;
}

export function __resetCodeLadderForTests() {
  LADDER_STATE.clear();
}

/**
 * @param {{ sessionId?: string | null, symbolId?: string | null, file?: string | null }} args
 */
function ladderKeys(args) {
  // Record/read all available scopes. Callers should pass both symbolId and
  // file when known so later rungs can match through pair, symbol, or file.
  const sessionId = String(args.sessionId || "default").trim() || "default";
  const symbolId = String(args.symbolId || "").trim();
  const file = String(args.file || "").trim();
  const keys = [];
  if (symbolId && file) keys.push(`${sessionId}\0pair\0${symbolId}\0${file}`);
  if (symbolId) keys.push(`${sessionId}\0symbol\0${symbolId}`);
  if (file) keys.push(`${sessionId}\0file\0${file}`);
  if (keys.length === 0) keys.push(`${sessionId}\0*`);
  return [...new Set(keys)];
}

function actionForRung(rung) {
  for (const [action, value] of Object.entries(RUNG_BY_ACTION)) {
    if (value === rung) return action;
  }
  return `rung ${rung}`;
}

/**
 * @param {string[]} actions
 */
function formatActionList(actions) {
  if (actions.length <= 1) return actions[0] || "a prior rung";
  if (actions.length === 2) return `${actions[0]} and ${actions[1]}`;
  return `${actions.slice(0, -1).join(", ")}, and ${actions[actions.length - 1]}`;
}

function pruneLadderState() {
  const now = Date.now();
  for (const [key, entry] of LADDER_STATE) {
    if (now - entry.updatedAt <= LADDER_TTL_MS) continue;
    LADDER_STATE.delete(key);
  }
  while (LADDER_STATE.size > LADDER_STATE_LIMIT) {
    const oldest = LADDER_STATE.keys().next().value;
    if (oldest == null) break;
    LADDER_STATE.delete(String(oldest));
  }
}
