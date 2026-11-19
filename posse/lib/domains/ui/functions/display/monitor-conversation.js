// Chat-style rows for the monitor's CONVERSATION box, rendered from one
// posse.agent_conversation.v1 page (entries oldest -> newest): agent messages
// labelled with role and job, operator messages with their delivery receipt,
// gates with the operator's answer as their reply, attempt dividers, and under
// each message a one-line digest of the tool calls folded beneath it. Failed
// and rejected calls are always listed; open ("working...") groups pin to the
// floor. Pure: the renderer class reads the projection and owns the toggle.
import { C } from "../../../../shared/format/functions/colors.js";
import {
  AGENT_CONVERSATION_BOUNDS,
  AGENT_CONVERSATION_ENTRY_KIND as KIND,
  AGENT_CONVERSATION_ENTRY_KINDS,
} from "../../../../catalog/agent-conversation.js";
import { roleBrandColor } from "./helpers/brand.js";
import { displayColumnWidth, fit, stripAnsi, _sanitizeDisplayLine } from "./helpers/formatters.js";
import { compactTime, fmtDur, monitorPulse, roleLabel } from "./monitor-presentation.js";

const KNOWN_KINDS = new Set(AGENT_CONVERSATION_ENTRY_KINDS);
const MESSAGE_KINDS = new Set([KIND.AGENT_MESSAGE, KIND.OPERATOR_MESSAGE, KIND.GATE]);
// The open group shows its newest calls; the rest stay one keypress away.
const OPEN_GROUP_TAIL_CALLS = 6;
const OPERATOR_BODY_LINES = 8;
const NOTE_LINES = 2;
// The ask box picks a choice with one digit, so it numbers at most nine.
const DIGIT_CHOICES = 9;

function clean(value) {
  return _sanitizeDisplayLine(value ?? "").replace(/\s+/gu, " ").trim();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function columns(value) {
  return displayColumnWidth(stripAnsi(value));
}

// Truncate to `width` columns; shorter rows are returned as they are.
function clip(line, width) {
  return columns(line) > width ? fit(line, width) : line;
}

function splitAtColumns(word, cap) {
  const chars = Array.from(word);
  let used = 0;
  let index = 0;
  for (; index < chars.length; index++) {
    const charWidth = displayColumnWidth(chars[index]);
    if (used + charWidth > cap) break;
    used += charWidth;
  }
  index = Math.max(1, index);
  return [chars.slice(0, index).join(""), chars.slice(index).join("")];
}

// Greedy word wrap by display columns; a word wider than the line is broken.
function wrapText(text, width, maxLines = Infinity) {
  const cap = Math.max(4, width | 0);
  const lines = [];
  let line = "";
  for (let word of clean(text).split(" ").filter(Boolean)) {
    while (columns(word) > cap) {
      if (line) { lines.push(line); line = ""; }
      const [head, rest] = splitAtColumns(word, cap);
      lines.push(head);
      word = rest;
    }
    if (!word) continue;
    if (!line) line = word;
    else if (columns(line) + 1 + columns(word) <= cap) line = `${line} ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = `${columns(last) + 1 > cap ? splitAtColumns(last, cap - 1)[0] : last}…`;
    return kept;
  }
  return lines;
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** "dev #5", or "researcher #5 call 4" for a child call's entry. */
export function monitorConversationAgentLabel(entry = {}) {
  const role = roleLabel(entry.role || entry.job_type || "agent");
  const job = entry.job_id ? ` #${entry.job_id}` : "";
  const call = entry.parent_agent_call_id && entry.agent_call_id ? ` call ${entry.agent_call_id}` : "";
  return `${role}${job}${call}`;
}

/**
 * The operator message's receipt (decision D3: a superseded message reads
 * "replaced"). `reason` is set for decisions the agent explained.
 */
export function monitorNudgeReceipt(delivery = {}) {
  const state = String(delivery?.state || "");
  const reason = clean(delivery?.reason) || null;
  switch (state) {
    case "queued": return { text: "queued", color: C.yellow, reason: null };
    case "signaled": return { text: "signaled", color: C.yellow, reason: null };
    case "retrieved": {
      const tool = clean(delivery?.delivered_with_tool);
      return { text: tool ? `delivered with ${tool}` : "delivered", color: C.cyan, reason: null };
    }
    case "accepted": return { text: "accepted", color: C.green, reason: null };
    case "rejected": return { text: "rejected", color: C.red, reason };
    case "deferred": return { text: "deferred", color: C.yellow, reason };
    case "superseded": return { text: "replaced", color: C.dim, reason: null };
    case "expired": return { text: reason ? `expired · ${reason}` : "expired", color: C.dim, reason: null };
    default: return { text: state || "sent", color: C.dim, reason: null };
  }
}

function answerableGate(entry) {
  return entry?.kind === KIND.GATE && entry.state === "open" && entry.capability === "question.answer"
    && Array.isArray(entry.choices) && entry.choices.length > 0;
}

/**
 * The gate `[a] answer` opens from an agent's conversation: its newest open
 * gate that can be answered by choice, else its newest open gate whose prompt
 * is already queued (`promptedGateJobIds`). Null when it asks nothing.
 */
export function monitorConversationAnswerGate(entries, { promptedGateJobIds = [] } = {}) {
  const prompted = new Set((promptedGateJobIds || []).map(Number));
  const open = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.kind === KIND.GATE && entry.state === "open" && Number(entry.gate_job_id) > 0);
  const gate = open.findLast(answerableGate) || open.findLast((entry) => prompted.has(Number(entry.gate_job_id)));
  return gate ? Number(gate.gate_job_id) : null;
}

/** The page's entries the box can render; unknown kinds are dropped, never fatal. */
export function monitorConversationEntries(page) {
  const entries = Array.isArray(page?.entries) ? page.entries : [];
  return entries.filter((entry) => entry && typeof entry === "object" && KNOWN_KINDS.has(entry.kind));
}

function groupCounts(group) {
  const items = Array.isArray(group?.items) ? group.items : [];
  return {
    calls: Number(group?.call_count) || 0,
    subagents: items.filter((item) => item?.type === "subagent").length,
    notes: items.filter((item) => item?.type === "note").length,
    failed: Number(group?.failed_count) || 0,
    rejected: Number(group?.rejected_count) || 0,
    running: Number(group?.running_count) || 0,
  };
}

// "Read ×3, Edit ×2 +1" within `budget` columns, or "" when nothing fits.
function byToolText(group, budget) {
  const entries = (Array.isArray(group?.by_tool) ? group.by_tool : [])
    .map((entry) => `${clean(entry?.tool) || "tool"} ×${Number(entry?.count) || 0}`);
  let text = "";
  let shown = 0;
  for (const part of entries) {
    const next = text ? `${text}, ${part}` : part;
    const rest = entries.length - shown - 1;
    if (columns(next) + (rest > 0 ? ` +${rest}`.length : 0) > budget) break;
    text = next;
    shown += 1;
  }
  const dropped = entries.length - shown;
  if (dropped > 0 && text) return `${text} +${dropped}`;
  if (dropped > 0) return columns(`+${dropped} tools`) <= budget ? `+${dropped} tools` : "";
  return text;
}

/**
 * One-line digest of a tool group: "▸ 7 calls · Read ×3, Edit ×2 · 1 failed · 2m10s".
 * `lead` is the colored prefix; the per-tool tally gives way first when the
 * line is narrow, so the counts and failures survive.
 */
export function monitorToolGroupDigest(group, { lead = "", width = 80, span = true } = {}) {
  const sep = `${C.dim} · ${C.reset}`;
  if (group?.retained === false) return clip(`${lead}${C.dim}tool calls not retained${C.reset}`, width);
  const counts = groupCounts(group);
  const head = [
    counts.calls > 0 ? plural(counts.calls, "call") : null,
    counts.subagents > 0 ? plural(counts.subagents, "sub-agent") : null,
  ].filter(Boolean).join(" · ") || (counts.notes > 0 ? plural(counts.notes, "note") : plural(0, "call"));
  const spanMs = span ? (timeMs(group?.last_at) ?? 0) - (timeMs(group?.first_at) ?? 0) : 0;
  const tail = [
    counts.failed > 0 ? `${C.red}${counts.failed} failed${C.reset}` : null,
    counts.rejected > 0 ? `${C.yellow}${counts.rejected} rejected${C.reset}` : null,
    counts.running > 0 ? `${C.cyan}${counts.running} running${C.reset}` : null,
    spanMs > 0 ? `${C.dim}${fmtDur(spanMs)}${C.reset}` : null,
  ].filter(Boolean);
  const fixed = `${lead}${head}${tail.map((part) => `${sep}${part}`).join("")}`;
  const tools = byToolText(group, width - columns(fixed) - 3);
  return clip(`${lead}${head}${tools ? `${sep}${tools}` : ""}${tail.map((part) => `${sep}${part}`).join("")}`, width);
}

function isListedFailure(item) {
  return item?.type === "call" && !item.benign && (item.status === "failed" || item.status === "rejected");
}

function detailLines(item, width, indent) {
  const error = clean(item?.error);
  if (!error || !isListedFailure(item)) return [];
  const rejected = item.status === "rejected";
  const color = rejected ? C.yellow : C.red;
  const first = `${indent}  ${color}↳ ${rejected ? "reason:" : "error:"}${C.reset} `;
  const next = " ".repeat(columns(first));
  return wrapText(error, width - columns(first), 3).map((chunk, index) => clip(`${index === 0 ? first : next}${chunk}`, width));
}

function callLines(item, ctx, indent) {
  const { width } = ctx;
  if (item.type === "note") {
    const prefix = `${indent}${C.dim}┆ `;
    return wrapText(item.text, width - columns(prefix), NOTE_LINES).map((chunk) => clip(`${prefix}${chunk}${C.reset}`, width));
  }
  if (item.type === "subagent") {
    const parts = [
      roleLabel(item.role || "agent"),
      clean(item.child_kind).replaceAll("_", " ") || null,
      clean(item.status) || null,
      plural(Number(item.call_count) || 0, "call"),
    ].filter(Boolean);
    return [clip(`${indent}${C.magenta}↳${C.reset} ${C.magenta}${parts[0]}${C.reset}${C.dim} · ${parts.slice(1).join(" · ")}${C.reset}`, width)];
  }
  const duration = Number.isFinite(item.duration_ms) ? fmtDur(item.duration_ms) : "";
  let glyph;
  let status;
  if (item.status === "running") {
    const startedAt = timeMs(item.at);
    const elapsed = startedAt != null && ctx.now >= startedAt ? fmtDur(ctx.now - startedAt) : "";
    glyph = `${C.cyan}${monitorPulse(ctx.spinIdx)}${C.reset}`;
    status = `${C.cyan}running${elapsed ? ` ${elapsed}` : ""}${C.reset}`;
  } else if (item.benign) {
    glyph = `${C.dim}·${C.reset}`;
    status = `${C.dim}not found${C.reset}`;
  } else if (item.status === "failed") {
    glyph = `${C.red}✕${C.reset}`;
    status = `${C.red}failed${C.reset}${duration ? ` ${C.dim}${duration}${C.reset}` : ""}`;
  } else if (item.status === "rejected") {
    glyph = `${C.yellow}⊘${C.reset}`;
    status = `${C.yellow}rejected${C.reset}${duration ? ` ${C.dim}${duration}${C.reset}` : ""}`;
  } else {
    glyph = `${C.green}✓${C.reset}`;
    status = duration ? `${C.dim}${duration}${C.reset}` : "";
  }
  const tool = clean(item.tool) || "tool";
  const toolColor = /^atlas\b/u.test(tool) ? C.magenta : C.blue;
  const prefix = `${indent}${glyph} ${toolColor}${tool}${C.reset} `;
  const budget = width - columns(prefix) - (status ? columns(status) + 1 : 0);
  const target = clean(item.target);
  const body = budget >= 4 ? fit(target, budget) : "";
  return [
    clip(`${prefix}${body}${status ? ` ${status}` : ""}`, width),
    ...detailLines(item, width, indent),
  ];
}

function omittedLine(phrase, ctx, indent) {
  return clip(`${indent}${C.dim}⋯ ${phrase}${C.reset}`, ctx.width);
}

// Item rows below a digest. collapsed: failures only. tail: failures plus the
// newest calls (notes other than the latest stay folded). all: every item.
function groupItemLines(group, ctx, { mode, indent = "   " } = {}) {
  const items = Array.isArray(group?.items) ? group.items : [];
  if (mode === "all") {
    const out = [];
    const omitted = Number(group?.omitted_items) || 0;
    items.forEach((item, index) => {
      // The projection keeps a long group's first and last calls and drops
      // the middle; mark the gap where it was.
      if (omitted > 0 && index === Math.min(AGENT_CONVERSATION_BOUNDS.GROUP_ITEMS_HEAD, items.length)) {
        out.push(omittedLine(`${plural(omitted, "more item")} not kept`, ctx, indent));
      }
      out.push(...callLines(item, ctx, indent));
    });
    if (omitted > 0 && items.length <= AGENT_CONVERSATION_BOUNDS.GROUP_ITEMS_HEAD) {
      out.push(omittedLine(`${plural(omitted, "more item")} not kept`, ctx, indent));
    }
    return out;
  }
  if (mode === "tail") {
    const actions = items.map((item, index) => ({ item, index })).filter(({ item }) => item?.type !== "note");
    const tail = new Set(actions.slice(-OPEN_GROUP_TAIL_CALLS).map(({ index }) => index));
    const hidden = actions.length - tail.size
      - actions.filter(({ item, index }) => !tail.has(index) && isListedFailure(item)).length;
    const out = hidden > 0 ? [omittedLine(`${plural(hidden, "earlier call")} folded · [e] expands`, ctx, indent)] : [];
    for (const { item, index } of actions) {
      if (tail.has(index) || isListedFailure(item)) out.push(...callLines(item, ctx, indent));
    }
    return out;
  }
  return items.filter(isListedFailure).flatMap((item) => callLines(item, ctx, indent));
}

function latestNote(group) {
  const items = Array.isArray(group?.items) ? group.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "note" && clean(items[index].text)) return items[index];
  }
  return null;
}

function attachedGroupLines(group, ctx) {
  const mode = ctx.expanded ? "all" : "collapsed";
  const marker = ctx.expanded ? "▾" : "▸";
  return [
    monitorToolGroupDigest(group, { lead: ` ${C.dim}└ ${marker}${C.reset} `, width: ctx.width }),
    ...(group.retained === false ? [] : groupItemLines(group, ctx, { mode })),
  ];
}

function standaloneGroupLines(group, ctx) {
  const mode = ctx.expanded ? "all" : "collapsed";
  const marker = ctx.expanded ? "▾" : "▸";
  const label = monitorConversationAgentLabel(group);
  return [
    monitorToolGroupDigest(group, { lead: ` ${C.dim}${marker} ${label} ·${C.reset} `, width: ctx.width }),
    ...(group.retained === false ? [] : groupItemLines(group, ctx, { mode })),
  ];
}

// The open group is the agent's current turn: its newest calls stay in view
// on a TTY (all of them once expanded) under the latest commentary note;
// without a TTY it folds to its digest like every other group.
function openGroupLines(group, ctx) {
  const label = monitorConversationAgentLabel(group);
  const lead = ` ${C.cyan}${monitorPulse(ctx.spinIdx)} ${label} working…${C.reset} `;
  const mode = !ctx.interactive ? "collapsed" : ctx.expanded ? "all" : "tail";
  // Expanded lists notes inline; otherwise only the latest one shows.
  const note = mode === "all" ? null : latestNote(group);
  return [
    monitorToolGroupDigest(group, { lead, width: ctx.width, span: false }),
    ...(note ? callLines(note, ctx, "   ") : []),
    ...groupItemLines(group, ctx, { mode }),
  ];
}

function railLines(text, ctx, color, { maxLines = Infinity, style = "" } = {}) {
  const prefix = ` ${color}▏${C.reset} `;
  return wrapText(text, ctx.width - columns(prefix), maxLines)
    .map((chunk) => clip(`${prefix}${style ? `${style}${chunk}${C.reset}` : chunk}`, ctx.width));
}

function header(glyphLabel, chips, time, suffix, width) {
  const chipText = chips ? `${C.dim} · ${chips}${C.reset}` : "";
  const timeText = time ? `  ${C.dim}${time}${C.reset}` : "";
  const suffixText = suffix ? `  ${suffix}` : "";
  return clip(` ${glyphLabel}${chipText}${timeText}${suffixText}`, width);
}

function agentMessageLines(entry, ctx) {
  const color = roleBrandColor(entry.role, C.cyan);
  const status = clean(entry.status);
  const statusChip = status && status !== "running"
    ? (["blocked", "waiting"].includes(status) ? `${C.yellow}${status}${C.reset}${C.dim}` : status)
    : null;
  const chips = [clean(entry.phase) || null, statusChip].filter(Boolean).join(" · ");
  return [
    header(`${color}◦ ${monitorConversationAgentLabel(entry)}${C.reset}`, chips, compactTime(entry.occurred_at), "", ctx.width),
    ...railLines(entry.summary, ctx, color),
    ...(clean(entry.detail) ? railLines(entry.detail, ctx, color, { style: C.dim }) : []),
  ];
}

function operatorLines({ origin, at, receipt = null, body, reasonText = null }, ctx) {
  const originText = clean(origin);
  const lines = [
    header(`${C.yellow}› you${C.reset}`, originText, compactTime(at), receipt ? `${receipt.color}${receipt.text}${C.reset}` : "", ctx.width),
    ...railLines(body, ctx, C.yellow, { maxLines: OPERATOR_BODY_LINES }),
  ];
  if (reasonText) {
    const first = `   ${receipt?.color || C.dim}↳ `;
    lines.push(...wrapText(reasonText, ctx.width - columns(first), 3)
      .map((chunk, index) => clip(`${index === 0 ? first : "     "}${chunk}${C.reset}`, ctx.width)));
  }
  return lines;
}

function operatorMessageLines(entry, ctx) {
  const receipt = monitorNudgeReceipt(entry.delivery);
  return operatorLines({ origin: entry.origin, at: entry.occurred_at, receipt, body: entry.body, reasonText: receipt.reason }, ctx);
}

function gateStateChip(state) {
  if (state === "open") return `${C.yellow}${C.bold}waiting on you${C.reset}`;
  if (state === "pending") return `${C.yellow}pending${C.reset}`;
  if (state === "answered") return `${C.green}answered${C.reset}`;
  if (state === "rejected") return `${C.red}rejected${C.reset}`;
  return `${C.dim}${clean(state) || "closed"}${C.reset}`;
}

// "[1] Approve  [2] Reject ⚠": an answerable gate's choices, numbered with
// the digit that picks each one in the ask box; a destructive choice is
// marked. While the gate's prompt is queued its own choice list sets the
// numbers (a choice it does not offer gets none), so a number shown here
// always picks that choice. The gate [a] opens also says how to answer it.
function gateChoiceLines(entry, ctx) {
  if (!answerableGate(entry)) return [];
  const choices = entry.choices.filter((choice) => clean(choice?.choice_id));
  const prompt = ctx.promptChoices.get(Number(entry.gate_job_id));
  const digitFor = (choice, index) => {
    const position = prompt ? prompt.indexOf(String(choice.choice_id)) + 1 : index + 1;
    return position >= 1 && position <= DIGIT_CHOICES ? position : null;
  };
  const tokens = choices.slice(0, DIGIT_CHOICES).map((choice, index) => {
    const digit = digitFor(choice, index);
    const label = clean(choice.label) || clean(choice.choice_id);
    const destructive = choice.danger === "destructive" || choice.requires_confirmation === true;
    const color = destructive ? C.red : choice.danger === "caution" ? C.yellow : "";
    return `${digit ? `${C.cyan}[${digit}]${C.reset} ` : ""}${color}${label}${destructive ? " ⚠" : ""}${color ? C.reset : ""}`;
  });
  if (choices.length > DIGIT_CHOICES) tokens.push(`${C.dim}+${choices.length - DIGIT_CHOICES} more${C.reset}`);
  const digits = choices.slice(0, DIGIT_CHOICES).map(digitFor).filter(Boolean);
  if (Number(entry.gate_job_id) === ctx.answerGateJobId && digits.length > 0) {
    tokens.push(`${C.dim}· [a] then ${Math.min(...digits)}-${Math.max(...digits)}${C.reset}`);
  }
  const indent = "   ";
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const next = line ? `${line}  ${token}` : `${indent}${token}`;
    if (line && columns(next) > ctx.width) {
      lines.push(line);
      line = `${indent}${token}`;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((row) => clip(row, ctx.width));
}

function gateLines(entry, group, ctx) {
  const asker = entry.actor === "agent" && entry.job_id ? `${monitorConversationAgentLabel(entry)} asks` : "posse asks";
  const kind = clean(entry.gate_kind).replaceAll("_", " ") || "question";
  const title = clean(entry.title);
  const prompt = clean(entry.prompt_summary);
  const lines = [
    header(`${C.yellow}? ${asker}${C.reset}`, kind, compactTime(entry.occurred_at), gateStateChip(entry.state), ctx.width),
    ...(title ? railLines(title, ctx, C.yellow, { style: C.bold }) : []),
    ...(prompt && prompt !== title ? railLines(prompt, ctx, C.yellow) : []),
    ...gateChoiceLines(entry, ctx),
  ];
  if (group) lines.push(...attachedGroupLines(group, ctx));
  const answer = entry.answer && typeof entry.answer === "object" ? entry.answer : null;
  if (answer) {
    const label = clean(answer.label);
    const text = clean(answer.operator_text);
    const body = label && text ? `${label} — ${text}` : label || text;
    if (body) lines.push(...operatorLines({ origin: answer.origin, at: answer.answered_at, body }, ctx));
  }
  return lines;
}

function jobMarkerLines(entry, ctx) {
  const attempt = Number(entry.attempt_number) || 0;
  const provider = [clean(entry.provider), clean(entry.model)].filter(Boolean).join(" ");
  const parts = [
    `${roleLabel(entry.role || entry.job_type || "agent")}${entry.job_id ? ` #${entry.job_id}` : ""}`,
    attempt > 1 ? `attempt ${attempt}` : null,
    entry.phase === "ended" ? clean(entry.outcome) || null : null,
    provider || null,
    clean(entry.title) || null,
  ].filter(Boolean);
  // " ── " + text + " " + fill, with at least two fill columns.
  const text = stripAnsi(clip(parts.join(" · "), Math.max(4, ctx.width - 7))).trimEnd();
  const fill = Math.max(2, ctx.width - columns(text) - 5);
  return [clip(` ${C.dim}── ${text} ${"─".repeat(fill)}${C.reset}`, ctx.width)];
}

function flatten(line) {
  const text = stripAnsi(line);
  return text ? `${C.dim}${text}${C.reset}` : text;
}

/**
 * Render a conversation for the monitor box.
 *
 * @param {Array<object>} entries posse.agent_conversation.v1 entries, oldest first
 * @param {{width:number, interactive?:boolean, expanded?:boolean, spinIdx?:number,
 *   now?:number, hasOlder?:boolean, answerGateJobId?:number|null,
 *   promptChoices?:Map<number,string[]>}} options
 *   interactive: a TTY can toggle groups; without one every group stays
 *   collapsed to its digest. expanded: list every call of every group.
 *   answerGateJobId: the gate `[a] answer` opens; its choices carry the hint.
 *   promptChoices: gate job id -> the queued prompt's choice ids, in order.
 * @returns {{rows:string[], messageCount:number}}
 */
export function buildMonitorConversationRows(entries, {
  width,
  interactive = false,
  expanded = false,
  spinIdx = 0,
  now = Date.now(),
  hasOlder = false,
  answerGateJobId = null,
  promptChoices = new Map(),
} = {}) {
  const ctx = {
    width: Math.max(8, width | 0),
    interactive: interactive === true,
    expanded: interactive === true && expanded === true,
    spinIdx: spinIdx | 0,
    now: Number(now) || Date.now(),
    answerGateJobId: Number(answerGateJobId) || null,
    promptChoices: promptChoices instanceof Map ? promptChoices : new Map(),
  };
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === "object");
  const groupsById = new Map(list.filter((entry) => entry.kind === KIND.TOOL_GROUP).map((entry) => [entry.entry_id, entry]));
  // A group folds under the message or gate it closes when that entry is on
  // this page; otherwise it stands on its own line at its place in time.
  const attachedTo = new Map();
  for (const entry of list) {
    if (!MESSAGE_KINDS.has(entry.kind) || !entry.tool_group_id) continue;
    const group = groupsById.get(entry.tool_group_id);
    if (group && group.state !== "open") attachedTo.set(entry.entry_id, group);
  }
  const attachedIds = new Set([...attachedTo.values()].map((group) => group.entry_id));

  const blocks = [];
  const floor = [];
  for (const entry of list) {
    if (entry.kind === KIND.TOOL_GROUP) {
      if (entry.state === "open") floor.push(entry);
      else if (!attachedIds.has(entry.entry_id)) blocks.push({ message: false, lines: standaloneGroupLines(entry, ctx) });
      continue;
    }
    if (entry.kind === KIND.JOB_MARKER) blocks.push({ message: false, marker: true, lines: jobMarkerLines(entry, ctx) });
    else if (entry.kind === KIND.AGENT_MESSAGE) {
      const group = attachedTo.get(entry.entry_id);
      blocks.push({ message: true, lines: [...agentMessageLines(entry, ctx), ...(group ? attachedGroupLines(group, ctx) : [])] });
    } else if (entry.kind === KIND.OPERATOR_MESSAGE) blocks.push({ message: true, lines: operatorMessageLines(entry, ctx) });
    else if (entry.kind === KIND.GATE) blocks.push({ message: true, lines: gateLines(entry, attachedTo.get(entry.entry_id), ctx) });
  }

  // Chat floor: history above the newest message is dimmed and set off by a
  // rule; the newest message and anything after it read as live.
  let liveFrom = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].message) { liveFrom = index; break; }
  }
  const rows = [];
  if (hasOlder) rows.push(clip(` ${C.dim}⋯ earlier conversation not loaded${C.reset}`, ctx.width));
  blocks.forEach((block, index) => {
    const history = liveFrom > 0 && index < liveFrom;
    if (index === liveFrom && liveFrom > 0) rows.push("", ` ${C.dim}${"╌".repeat(Math.max(3, ctx.width - 1))}${C.reset}`);
    else if (index > 0 && (block.message || block.marker)) rows.push("");
    rows.push(...(history ? block.lines.map(flatten) : block.lines));
  });
  for (const group of floor) {
    if (rows.length > 0) rows.push("");
    rows.push(...openGroupLines(group, ctx));
  }
  return {
    rows: rows.map((row) => clip(row, ctx.width)),
    messageCount: list.filter((entry) => MESSAGE_KINDS.has(entry.kind)).length,
  };
}
