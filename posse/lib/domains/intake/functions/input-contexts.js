import fs from "fs";
import path from "path";

import { getRuntimeResourcesDir } from "../../runtime/functions/paths.js";

function splitCsv(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function listInputContextDirectories(projectDir = process.cwd()) {
  return inspectInputContextDirectories(projectDir).available;
}

export function inspectInputContextDirectories(projectDir = process.cwd()) {
  const root = path.join(getRuntimeResourcesDir(projectDir), "inputs");
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return {
      root,
      available: [],
      inventoryError: {
        code: String(err?.code || "INPUT_CONTEXT_READ_FAILED"),
        message: String(err?.message || "Unable to read input context directory"),
      },
    };
  }

  const available = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      relativeDir: path.relative(projectDir, path.join(root, entry.name)).replace(/\\/g, "/"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root, available, inventoryError: null };
}

export function resolveInputContextSelection(rawSelection, availableDirs) {
  const tokens = splitCsv(rawSelection).map((token) => token.trim());
  if (tokens.length === 0) return { selectedDirs: [], invalidTokens: [] };

  const byName = new Map();
  const byRelative = new Map();
  availableDirs.forEach((entry) => {
    byName.set(entry.name.toLowerCase(), { entry });
    byRelative.set(entry.relativeDir.toLowerCase(), { entry });
  });

  const selected = [];
  const seen = new Set();
  const invalid = [];

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (!normalized) continue;
    if (normalized === "none") continue;
    if (normalized === "all") {
      for (const entry of availableDirs) {
        if (seen.has(entry.relativeDir)) continue;
        seen.add(entry.relativeDir);
        selected.push(entry.relativeDir);
      }
      continue;
    }

    if (/^\d+$/.test(normalized)) {
      const idx = Number(normalized) - 1;
      const target = Number.isInteger(idx) && idx >= 0 && idx < availableDirs.length
        ? availableDirs[idx]
        : null;
      if (!target) {
        invalid.push(token);
        continue;
      }
      if (!seen.has(target.relativeDir)) {
        seen.add(target.relativeDir);
        selected.push(target.relativeDir);
      }
      continue;
    }

    const nameMatch = byName.get(normalized) || byRelative.get(normalized);
    if (!nameMatch) {
      invalid.push(token);
      continue;
    }
    if (!seen.has(nameMatch.entry.relativeDir)) {
      seen.add(nameMatch.entry.relativeDir);
      selected.push(nameMatch.entry.relativeDir);
    }
  }

  return { selectedDirs: selected, invalidTokens: invalid };
}

export function mergeSuspectedDirsWithInputContexts(baseSuspectedDirs, inputContextSelection, projectDir = process.cwd()) {
  const base = splitCsv(baseSuspectedDirs).map((item) => item.replace(/\\/g, "/"));
  const inventory = inspectInputContextDirectories(projectDir);
  const available = inventory.available;
  if (!inputContextSelection || !String(inputContextSelection).trim()) {
    return {
      merged: base,
      selected: [],
      invalidTokens: [],
      available,
      inventoryError: inventory.inventoryError,
    };
  }
  const { selectedDirs, invalidTokens } = resolveInputContextSelection(inputContextSelection, available);
  const mergedSet = new Set(base.map((item) => item.trim()).filter(Boolean));
  for (const dir of selectedDirs) mergedSet.add(dir);
  return {
    merged: [...mergedSet],
    selected: selectedDirs,
    invalidTokens,
    available,
    inventoryError: inventory.inventoryError,
  };
}

export function assertInputContextSelection(mergeResult, rawSelection) {
  const tokens = splitCsv(rawSelection);
  if (tokens.length === 0 || tokens.every((token) => token.toLowerCase() === "none")) return;

  if (mergeResult?.inventoryError) {
    const err = new Error(`Cannot resolve --input-contexts because the input context directory is unavailable (${mergeResult.inventoryError.code})`);
    err.code = "INPUT_CONTEXT_INVENTORY_UNAVAILABLE";
    throw err;
  }
  const invalid = Array.isArray(mergeResult?.invalidTokens) ? mergeResult.invalidTokens : [];
  if (invalid.length === 0) return;
  const available = (mergeResult.available || []).map((entry) => entry.name);
  const suffix = available.length > 0 ? ` Available contexts: ${available.join(", ")}.` : " No input contexts are available.";
  const err = new Error(`Unknown input context selection(s): ${invalid.join(", ")}.${suffix}`);
  err.code = "INVALID_INPUT_CONTEXT_SELECTION";
  throw err;
}
