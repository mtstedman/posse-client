import crypto from "node:crypto";

function canonicalToolName(value) {
  const name = String(value || "").trim();
  if (name.startsWith("tools.")) return name.slice("tools.".length);
  if (name.startsWith("tools_")) return name.slice("tools_".length);
  return name;
}

export function toolSchemaTelemetry(schema = {}) {
  const canonical = {
    name: canonicalToolName(schema?.name),
    description: String(schema?.description || ""),
    parameters: schema?.parameters || schema?.inputSchema || {},
  };
  const serialized = JSON.stringify(canonical);
  return {
    name: canonical.name,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    chars: serialized.length,
  };
}
