import { createWorkItem } from "../../queue/functions/index.js";
import { projectBridgeWorkItem } from "./state-snapshot.js";

const MAX_WORK_ITEM_DESCRIPTION_CHARS = 20_000;

export function addBridgeWorkItem(args = {}, context = {}) {
  const description = String(args.description || "").trim();
  if (!description) return { ok: false, reason: "invalid_description" };
  if (description.length > MAX_WORK_ITEM_DESCRIPTION_CHARS) {
    return { ok: false, reason: "invalid_description", message: "description is too long" };
  }

  const title = (
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || description
  ).slice(0, 100);
  const item = createWorkItem(title, description, "normal", {
    source: "bridge",
    requested_by: String(context.actor || "bridge"),
    mode: "build",
  });

  return {
    work_item: projectBridgeWorkItem(item),
  };
}

export async function startBridgeRun(args = {}, context = {}) {
  if (typeof context.startPosse !== "function") {
    return { ok: false, reason: "run_launcher_unavailable" };
  }
  return context.startPosse(args);
}
