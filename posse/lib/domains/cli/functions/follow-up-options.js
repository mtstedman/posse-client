import { parsePositiveIntegerFlag } from "./flags.js";
import { followUpMetadata } from "../../planning/functions/follow-up-context.js";

export function followUpMetadataFromArgs(argv = process.argv) {
  const args = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length);
  const id = parsePositiveIntegerFlag(args, "--follow-up", () => new Error("--follow-up requires an existing work-item ID"));
  const index = args.indexOf("--follow-up-kind");
  const raw = args.find(arg => arg.startsWith("--follow-up-kind="))?.slice("--follow-up-kind=".length)
    ?? (index >= 0 ? args[index + 1] : undefined);
  if (index >= 0 && (raw == null || raw.startsWith("--"))) throw new Error("--follow-up-kind requires gap, regression or enhancement");
  if (raw != null && id == null) throw new Error("--follow-up-kind requires --follow-up");
  return followUpMetadata(id, raw ?? "gap");
}
