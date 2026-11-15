// @ts-check
// A member's job that the host's session console has taken into the host's
// queue but nothing has started yet (no `posse go` is running). The console
// says so once per job instead of leaving the member's job blocked and
// re-sent while the host does not know it exists.

import { getDb } from "../../../shared/storage/functions/index.js";
import { shortInstanceId } from "./session-console.js";

/**
 * Jobs this executor imported that are still waiting in its queue, not yet
 * announced. Marks them announced.
 *
 * @param {{ instanceId: string, announced: Set<string>, peers?: Array<any>, db?: any }} args
 * @returns {string[]} one line per newly pending job
 */
export function newPendingSessionJobLines({ instanceId, announced, peers = [], db = getDb() }) {
  if (!instanceId) return [];
  const rows = db.prepare(`
    SELECT d.offer_key, d.originator_instance_id, d.local_job_id, j.title, j.job_type
    FROM work_item_delegations d JOIN jobs j ON j.id = d.local_job_id
    WHERE d.executor_instance_id = ? AND d.state = 'imported' AND j.status = 'queued'
    ORDER BY d.local_job_id
  `).all(instanceId);
  const lines = [];
  for (const row of rows) {
    if (announced.has(row.offer_key)) continue;
    announced.add(row.offer_key);
    const peer = peers.find((candidate) => candidate?.instance_id === row.originator_instance_id);
    const who = String(peer?.label || "").trim() || `machine ${shortInstanceId(row.originator_instance_id)}`;
    const title = String(row.title || "").replace(/\s+/gu, " ").slice(0, 80);
    lines.push(`${who} has a pending ${row.job_type} job: "${title}" (#${row.local_job_id}). `
      + "It is in your queue; type go to run it.");
  }
  return lines;
}
