// Prompt and output logs use the same attribution filters and JSONL reader.
export function readRecentAgentLogEntries(log, {
  limit = 50,
  jobId = null,
  role = null,
  agentCallId = null,
} = {}) {
  return log.readRecentEntries({
    limit,
    parseLine: JSON.parse,
    predicate: (record) => {
      if (agentCallId != null && record.agent_call_id !== agentCallId) return false;
      if (jobId != null && record.job_id !== jobId) return false;
      if (role && record.role !== role) return false;
      return true;
    },
  });
}
