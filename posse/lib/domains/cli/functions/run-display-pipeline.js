/** True when the pipeline snapshot carries a live session or paired work. */
export function pipelineHasSession(data) {
  return Array.isArray(data) && data.some((row) => row?.session_summary || row?.peer_read_only);
}
