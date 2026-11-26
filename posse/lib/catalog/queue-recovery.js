// Shared payload mutation for shutdown and orphan recovery. Pure SQL data.
export const ASSESS_ONLY_PAYLOAD_SQL = `
  payload_json = CASE
    WHEN payload_json IS NULL OR trim(payload_json) = '' THEN json_set('{}', '$._assess_only', 1)
    WHEN json_valid(payload_json) THEN json_set(payload_json, '$._assess_only', 1)
    ELSE json_set(json_object('_legacy_invalid_payload_json', payload_json), '$._assess_only', 1)
  END
`;

export const FORCED_EXIT_REQUEUE_BUSY_MS = 1000;
