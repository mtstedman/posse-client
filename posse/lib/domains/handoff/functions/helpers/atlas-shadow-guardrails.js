// @ts-check
//
// Shadow-only ATLAS research guardrails. These classify handoffs that matched
// recent A/B miss patterns and emit telemetry, but never alter prompts, tool
// permissions, or fallback behavior.

const MODE_VALUES = new Set(["off", "shadow"]);

const DEPLOY_PROVENANCE_RE = /\b(?:deploy(?:ment)?|cron|crontab|nginx|apache|vhost|systemd|supervisor|docker(?:file)?|compose|k8s|kubernetes|helm|hook|webhook|publish\s+hook|scheduler|scheduled|shell\s+script|\.sh\b|config(?:uration)?\s+path|live\s+copy|stale\s+copy|root\s+stub)\b/i;
const EXACT_COUNT_RE = /\b(?:exact\s+count|count\s+(?:of|every|all)|every\s+(?:caller|reference|write|path|file|store|table|record)|all\s+(?:callers?|references?|writes?|paths?|files?|stores?|tables?|records?)|inventory|inventor(?:y|ies)|enumerate|fan[-\s]?in|who\s+(?:calls|writes|reads|uses)|caller\s+count|reference\s+count|write\s+inventory|persistence\s+write)\b/i;
const NEGATIVE_EVIDENCE_RE = /\b(?:negative[-\s]evidence|decoys?|same[-\s]?name|name\s+collision|duplicate|stub|root\s+stub|stale|dead|offline|batch|test[-\s]?only|not\s+(?:live|used|production|reachable)|exclude|excluded|distinguish\s+(?:included|live|real)|false\s+positive)\b/i;
const TOKEN_PRESSURE_RE = /\b(?:trace|deep|multi[-\s]?hop|ordered\s+path|write\s+path|persistence|inventory|every|all|prove|evidence|decoy|negative[-\s]evidence|provenance)\b/i;

/**
 * @param {any} packet
 * @param {{ mode?: string | null }} [opts]
 */
export function buildAtlasShadowGuardrails(packet = {}, opts = {}) {
  const mode = normalizeAtlasShadowGuardrailMode(opts.mode);
  const taskText = collectTaskText(packet);
  const lanes = [];

  if (mode === "off") {
    return {
      mode,
      triggered: false,
      lanes,
      task_text_chars: taskText.length,
      matched_terms: [],
      recommendations: [],
    };
  }

  if (DEPLOY_PROVENANCE_RE.test(taskText)) {
    lanes.push({
      id: "deploy_provenance",
      reason: "Task asks for live/deploy/config provenance where source-only indexing has missed shell/config hook copies.",
      recommended_first_tools: ["tree.branch", "code.structure", "code.survey"],
      native_exception: "Allow direct native reads for non-indexed deploy/config/shell artifacts after naming the provenance gap.",
    });
  }

  if (EXACT_COUNT_RE.test(taskText)) {
    lanes.push({
      id: "exact_count_inventory",
      reason: "Task asks for exact counts or exhaustive inventory, where per-file laddering has over/under-counted.",
      recommended_first_tools: ["code.structure", "code.survey"],
      native_exception: "Escalate only specific unresolved count gaps to targeted native reads.",
    });
  }

  if (NEGATIVE_EVIDENCE_RE.test(taskText)) {
    lanes.push({
      id: "negative_evidence",
      reason: "Task asks to separate live evidence from decoys, duplicates, or stale/offline paths.",
      recommended_first_tools: ["code.structure", "code.survey", "code.lens"],
      native_exception: "Window only the top decoy and live-target files that remain ambiguous.",
    });
  }

  if (TOKEN_PRESSURE_RE.test(taskText) && lanes.length > 0) {
    lanes.push({
      id: "token_pressure",
      reason: "Task shape is prone to repeated lens/window loops and cache-read accumulation.",
      recommended_first_tools: ["code.structure", "code.survey"],
      native_exception: "After repeated ladder calls on one target, summarize the remaining gap or switch to one targeted fallback read.",
    });
  }

  const uniqueLanes = dedupeLanes(lanes);
  return {
    mode,
    triggered: uniqueLanes.length > 0,
    lanes: uniqueLanes,
    task_text_chars: taskText.length,
    matched_terms: uniqueLanes.map((lane) => lane.id),
    recommendations: uniqueLanes.map((lane) => ({
      lane: lane.id,
      first_tools: lane.recommended_first_tools,
      native_exception: lane.native_exception,
    })),
  };
}

export function normalizeAtlasShadowGuardrailMode(value = "shadow") {
  const raw = String(value || "shadow").trim().toLowerCase();
  return MODE_VALUES.has(raw) ? raw : "shadow";
}

function collectTaskText(packet = {}) {
  const raw = packet?._raw_payload && typeof packet._raw_payload === "object"
    ? packet._raw_payload
    : {};
  return [
    packet.title,
    packet.description,
    packet.instructions,
    packet.task_spec,
    raw.task_spec,
    raw.instructions,
    raw.description,
    raw.axis,
    raw.question,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
}

function dedupeLanes(lanes) {
  const seen = new Set();
  const out = [];
  for (const lane of lanes) {
    if (!lane?.id || seen.has(lane.id)) continue;
    seen.add(lane.id);
    out.push(lane);
  }
  return out;
}
