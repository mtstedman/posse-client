import { getDb } from "../../../shared/storage/functions/index.js";
import { createAgentHandoffPacketTable } from "../../../shared/storage/functions/table-definitions.js";

export const AGENT_HANDOFF_PACKET_TABLE = "agent_handoff_packets";

class AgentHandoffSchema {
  #readyDbs = new WeakSet();

  ensure(db = getDb()) {
    if (this.#readyDbs.has(db)) return db;
    createAgentHandoffPacketTable(db);
    this.#readyDbs.add(db);
    return db;
  }
}

export const agentHandoffSchema = new AgentHandoffSchema();
