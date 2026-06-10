export function parseFanoutPayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

export function parseFanoutJobPayload(job) {
  const raw = job?.payload_json;
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parseFanoutPayload(parsed);
  } catch {
    return {};
  }
}

export function isShadowFanoutPayload(payload) {
  const parsed = parseFanoutPayload(payload);
  return parsed.fanout_shadow === true && ["child", "synth"].includes(parsed.role_mode);
}

export function isShadowFanoutJob(job) {
  return isShadowFanoutPayload(parseFanoutJobPayload(job));
}
