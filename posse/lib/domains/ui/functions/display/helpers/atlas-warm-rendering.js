// Shared ATLAS warm rendering helpers for the terminal display.

import { C } from "../../../../../shared/format/functions/colors.js";
import { describeAtlasWarmJob } from "../../../../atlas/functions/v2/process-indicators.js";


const ATLAS_WARM_FAMILY_ORDER = ["reindex", "scip", "warm", "replay", "cleanup"];


const ATLAS_WARM_FAMILY_LABELS = {
  reindex: "Code map",
  scip: "SCIP restage",
  warm: "Context prep",
  replay: "Merge replay",
  cleanup: "Cleanup",
};



export function atlasWarmFamily(info) {
  const purpose = String(info?.purpose || "");
  if (purpose === "main-incremental" || purpose === "main-full") return "reindex";
  if (purpose === "scip-restage") return "scip";
  if (purpose === "main-merge") return "replay";
  if (purpose === "wi-cleanup") return "cleanup";
  return "warm";
}



export function atlasWarmQueueGroups(jobs = []) {
  const groups = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const info = describeAtlasWarmJob(job);
    const family = atlasWarmFamily(info);
    const eventCount = Math.max(1, Number(info.eventCount || 1));
    if (!groups.has(family)) {
      groups.set(family, {
        family,
        label: ATLAS_WARM_FAMILY_LABELS[family] || "Context prep",
        jobs: [],
        active: 0,
        activeEvents: 0,
        queued: 0,
        queuedEvents: 0,
      });
    }
    const group = groups.get(family);
    group.jobs.push(job);
    if (job?.status === "running" || job?.status === "leased") {
      group.active++;
      group.activeEvents += eventCount;
    }
    if (job?.status === "queued" || job?.status === "blocked") {
      group.queued++;
      group.queuedEvents += eventCount;
    }
  }
  return [...groups.values()].sort((a, b) =>
    ATLAS_WARM_FAMILY_ORDER.indexOf(a.family) - ATLAS_WARM_FAMILY_ORDER.indexOf(b.family));
}



export function atlasWarmQueuedEventCount(group) {
  const coalescedBehindRunning = Math.max(0, Number(group.activeEvents || 0) - Number(group.active || 0));
  return Number(group.queuedEvents || 0) + coalescedBehindRunning;
}



function atlasWarmQueueActivityParts(group, { activeWord = "active" } = {}) {
  const parts = [];
  if (group.active > 0) {
    parts.push(`${C.bold}${group.active}${C.reset}${C.dim} ${activeWord}${C.reset}`);
  }
  const queuedEvents = atlasWarmQueuedEventCount(group);
  if (queuedEvents > 0) {
    parts.push(`${C.bold}${queuedEvents}${C.reset}${C.dim} queued${C.reset}`);
  }
  return parts;
}



function atlasWarmQueueSummaryParts(group, { activeWord = "active", labelColor = C.cyan } = {}) {
  return [
    `${labelColor}${group.label}${C.reset}`,
    ...atlasWarmQueueActivityParts(group, { activeWord }),
  ];
}



export function formatAtlasWarmQueueSummary(group, opts = {}) {
  return atlasWarmQueueSummaryParts(group, opts).join(`${C.dim} · ${C.reset}`);
}



export function formatAtlasWarmQueueRow(group, { activeWord = "active", labelColor = C.cyan } = {}) {
  const label = String(group.label || "Context prep").padEnd(12);
  const parts = atlasWarmQueueActivityParts(group, { activeWord });
  const status = parts.length > 0 ? parts.join(`${C.dim}  ${C.reset}`) : `${C.dim}idle${C.reset}`;
  return `${labelColor}${label}${C.reset} ${status}`;
}



export function atlasWarmStatusWords(info) {
  switch (atlasWarmFamily(info)) {
    case "reindex":
      return {
        active: "reindexing",
        queued: "reindex queued",
        failed: "reindex failed",
        succeeded: "reindexed",
      };
    case "replay":
      return {
        active: "replaying",
        queued: "replay queued",
        failed: "replay failed",
        succeeded: "replayed",
      };
    case "cleanup":
      return {
        active: "cleaning",
        queued: "cleanup queued",
        failed: "cleanup failed",
        succeeded: "cleaned",
      };
    default:
      return {
        active: "warming",
        queued: "warm queued",
        failed: "warm failed",
        succeeded: "warmed",
      };
  }
}
