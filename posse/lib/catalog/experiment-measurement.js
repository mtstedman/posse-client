// Reserved owner measurements cannot be supplied by a corpus prediction.
export const EXPERIMENT_LATENCY_METRIC = 'latency_ms';
export const EXPERIMENT_TIMED_CORPUS_PROTOCOL = 'jsonl.corpus.sequential-owner-latency.v1';
export const EXPERIMENT_LATENCY_DEFINITION = 'Owner monotonic elapsed milliseconds from immediately before writing one case to sandbox stdin until its matching prediction reaches owner stdout. Cases are delivered sequentially. Includes transport and scheduling; the first case may also include sandbox process startup. This is sandbox response latency, not mobile or device latency. Payload timing telemetry is never used.';
