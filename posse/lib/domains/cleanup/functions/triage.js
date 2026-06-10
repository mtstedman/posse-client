// lib/cleanup/triage.js
//
// Classification pass over a cleanup inventory. Calls a cheap-tier provider
// with the inventory + rubric, parses JSON back, and returns per-item
// { tier, reason, suggested_action } mappings. Read-only; no mutations.
//
// Falls back to a deterministic classifier when no provider is available so
// the cleanup command still works offline.

import { getProvider } from "../../providers/functions/provider.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";

const TIERS = ["safe-discard", "restore-suggested", "investigate"];

function uniqueKey(kind, id) {
  return `${kind}:${id}`;
}

function buildItemIndex(inventory) {
  const items = [];
  for (const s of inventory.snapshots) items.push({ key: uniqueKey("snapshot", s.id), kind: "snapshot", payload: s });
  for (const b of inventory.branches) items.push({ key: uniqueKey("branch", b.name), kind: "branch", payload: b });
  for (const w of inventory.worktrees) items.push({ key: uniqueKey("worktree", w.path), kind: "worktree", payload: w });
  if (inventory.mainTreeDirt.dirty) items.push({ key: uniqueKey("main_tree", "dirt"), kind: "main_tree", payload: inventory.mainTreeDirt });
  for (const st of inventory.stashes) items.push({ key: uniqueKey("stash", st.ref), kind: "stash", payload: st });
  return items;
}

function deterministicFallback(items) {
  const map = {};
  for (const item of items) {
    const p = item.payload;
    if (item.kind === "snapshot") {
      const old = p.ageMs > 7 * 24 * 3600 * 1000;
      map[item.key] = old
        ? { tier: "safe-discard", reason: `snapshot older than 7d (${p.ageHuman})`, suggested_action: "discard" }
        : { tier: "investigate", reason: `recent snapshot (${p.ageHuman}); review contents before discarding`, suggested_action: "inspect" };
    } else if (item.kind === "branch") {
      if (p.mergedToTarget) {
        map[item.key] = { tier: "safe-discard", reason: "branch already merged to target", suggested_action: "discard" };
      } else if (p.wiStatus && TERMINAL_WORK_ITEM_STATUSES.includes(p.wiStatus) && p.mergeState !== "pending_review") {
        map[item.key] = { tier: "investigate", reason: `WI ${p.wiStatus}; merge_state=${p.mergeState || "null"}`, suggested_action: "inspect" };
      } else {
        map[item.key] = { tier: "investigate", reason: `WI status=${p.wiStatus || "unknown"}`, suggested_action: "inspect" };
      }
    } else if (item.kind === "worktree") {
      if (p.statusUnknown) {
        map[item.key] = { tier: "investigate", reason: "could not read worktree git status", suggested_action: "inspect" };
        continue;
      }
      if (p.wiMissing) {
        map[item.key] = p.hasChanges
          ? { tier: "restore-suggested", reason: "no matching WI row; worktree has uncommitted changes", suggested_action: "snapshot" }
          : { tier: "safe-discard", reason: "no matching WI row; worktree clean", suggested_action: "discard" };
      } else if (p.wiTerminal) {
        map[item.key] = p.hasChanges
          ? { tier: "restore-suggested", reason: `WI ${p.wiStatus} with uncommitted changes`, suggested_action: "snapshot" }
          : { tier: "safe-discard", reason: `WI ${p.wiStatus}; worktree clean`, suggested_action: "discard" };
      } else {
        map[item.key] = { tier: "investigate", reason: `WI still active (${p.wiStatus})`, suggested_action: "keep" };
      }
    } else if (item.kind === "main_tree") {
      map[item.key] = { tier: "investigate", reason: `${p.fileCount} dirty file(s) in main tree`, suggested_action: "inspect" };
    } else if (item.kind === "stash") {
      map[item.key] = { tier: "restore-suggested", reason: "legacy posse-labeled stash; inspect contents before dropping", suggested_action: "inspect" };
    }
  }
  return map;
}

function renderPrompt(inventory, items) {
  const lines = [];
  lines.push("You are a posse cleanup triage assistant. Classify each leftover item below into one of three tiers:");
  lines.push("- safe-discard: clearly fine to delete (already merged, superseded, no user data)");
  lines.push("- restore-suggested: may contain user work that should be inspected or preserved");
  lines.push("- investigate: ambiguous; user should look before acting");
  lines.push("");
  lines.push("Respond with a single JSON object: { \"classifications\": [ { \"key\": string, \"tier\": string, \"reason\": string (≤120 chars), \"suggested_action\": \"discard\"|\"restore\"|\"inspect\"|\"keep\" } ] }");
  lines.push("Every item key from the inventory must appear exactly once. No prose outside the JSON.");
  lines.push("");
  lines.push(`Target branch: ${inventory.targetBranch || "(unknown)"}`);
  lines.push(`Captured at: ${inventory.capturedAt}`);
  lines.push("");
  lines.push("Items:");
  lines.push("```json");
  lines.push(JSON.stringify(items.map((i) => ({ key: i.key, kind: i.kind, ...i.payload })), null, 2));
  lines.push("```");
  return lines.join("\n");
}

function normalizeTier(raw) {
  if (typeof raw !== "string") return "investigate";
  const lower = raw.toLowerCase().replace(/_/g, "-");
  if (TIERS.includes(lower)) return lower;
  if (lower.includes("discard") || lower === "safe") return "safe-discard";
  if (lower.includes("restore") || lower.includes("preserve")) return "restore-suggested";
  return "investigate";
}

export async function triageInventory(inventory, { role = "planner", modelTier = "cheap", silent = true } = {}) {
  const items = buildItemIndex(inventory);
  if (items.length === 0) return { classifications: {}, via: "empty" };

  let provider;
  try { provider = getProvider(role); }
  catch { return { classifications: deterministicFallback(items), via: "fallback:no-provider" }; }

  const prompt = renderPrompt(inventory, items);
  let output = "";
  try {
    const res = await provider.callProvider(prompt, {
      role,
      modelTier,
      silent,
      allowWrite: false,
      maxTurns: 1,
      activity: "cleanup-triage",
    });
    output = res?.output || "";
  } catch {
    return { classifications: deterministicFallback(items), via: "fallback:provider-error" };
  }

  const parsed = provider.extractJson ? provider.extractJson(output) : null;
  const rawList = parsed && Array.isArray(parsed.classifications) ? parsed.classifications : null;
  if (!rawList) return { classifications: deterministicFallback(items), via: "fallback:parse-failed" };

  const indexed = {};
  for (const entry of rawList) {
    if (!entry || typeof entry.key !== "string") continue;
    indexed[entry.key] = {
      tier: normalizeTier(entry.tier),
      reason: typeof entry.reason === "string" ? entry.reason.slice(0, 200) : "",
      suggested_action: typeof entry.suggested_action === "string" ? entry.suggested_action : "inspect",
    };
  }
  for (const item of items) {
    if (!indexed[item.key]) {
      const fallback = deterministicFallback([item]);
      indexed[item.key] = fallback[item.key];
    }
  }
  return { classifications: indexed, via: "provider" };
}

export { buildItemIndex, deterministicFallback };
