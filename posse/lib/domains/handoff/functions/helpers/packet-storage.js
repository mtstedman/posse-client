import { packetEvidence } from "./packet-evidence.js";

function failStoredPacket(message) {
  const error = new Error(message);
  error.code = "AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED";
  throw error;
}

function mapStoredClaimEvidence(claim, mapEvidence) {
  const detail = claim?.[1];
  if (!detail || typeof detail !== "object") return claim;
  const mapped = { ...detail };
  for (const lane of ["evidence", "proof", "support"]) {
    if (Array.isArray(detail[lane])) mapped[lane] = detail[lane].map(mapEvidence);
  }
  if (Array.isArray(detail.decoy)) {
    mapped.decoy = detail.decoy.map(([evidence, reason]) => [mapEvidence(evidence), reason]);
  }
  return [claim[0], mapped];
}

function mapStoredPacketEvidence(packet, mapEvidence) {
  return {
    ...packet,
    handoffs: (packet.handoffs || []).map((handoff) => ({
      ...handoff,
      report: {
        ...handoff.report,
        claims: (handoff.report?.claims || []).map((claim) => mapStoredClaimEvidence(claim, mapEvidence)),
      },
    })),
  };
}

export function serializeStoredAgentHandoffPacket(packet) {
  const evidenceCatalog = packetEvidence(packet);
  if (evidenceCatalog.length === 0) return JSON.stringify(packet);
  const evidenceIds = new Map(evidenceCatalog.map((evidence, index) => [evidence.selector, index]));
  const stored = mapStoredPacketEvidence(packet, (evidence) => ({
    evidence_id: evidenceIds.get(evidence.selector),
  }));
  stored.evidence_catalog = evidenceCatalog;
  return JSON.stringify(stored);
}

export function parseStoredAgentHandoffPacket(materializedJson) {
  const stored = JSON.parse(materializedJson);
  if (!Array.isArray(stored.evidence_catalog)) return stored;
  const selectors = new Set();
  for (const evidence of stored.evidence_catalog) {
    const selector = String(evidence?.selector || "");
    if (!selector || selectors.has(selector)) {
      failStoredPacket("Stored agent_handoff evidence catalog is invalid");
    }
    selectors.add(selector);
  }
  const packet = mapStoredPacketEvidence(stored, (pointer) => {
    const evidenceId = Number(pointer?.evidence_id);
    const evidence = Number.isInteger(evidenceId) && evidenceId >= 0
      ? stored.evidence_catalog[evidenceId]
      : null;
    if (!evidence) {
      failStoredPacket("Stored agent_handoff evidence pointer is missing");
    }
    return evidence;
  });
  delete packet.evidence_catalog;
  return packet;
}

