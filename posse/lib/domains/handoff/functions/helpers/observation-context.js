// Bind background handoff work to the packet it serves. Ambient parent
// context can belong to a different job when callbacks finish out of order.

export function handoffPrefetchObservationContext(packet = {}, parent = {}) {
  const sameParentJob = packet.job_id != null
    && packet.job_id === parent.job_id
    && packet.work_item_id === parent.work_item_id;
  return {
    work_item_id: packet.work_item_id ?? parent.work_item_id ?? null,
    job_id: packet.job_id ?? parent.job_id ?? null,
    attempt_id: packet.attempt_id ?? (sameParentJob ? parent.attempt_id : null) ?? null,
    agent_call_id: packet.agent_call_id ?? (sameParentJob ? parent.agent_call_id : null) ?? null,
    role: packet.recipient ?? parent.role ?? null,
  };
}
