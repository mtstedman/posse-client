export function formatTokens(value, { unknown = "?", zero = "0" } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return unknown;
  const rounded = Math.max(0, Math.round(n));
  if (rounded === 0) return zero;
  if (rounded >= 1_000_000_000) return `${(rounded / 1_000_000_000).toFixed(2)}B`;
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}K`;
  return String(rounded);
}

export function formatSignedTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  const sign = n > 0 ? "+" : "-";
  return `${sign}${formatTokens(Math.abs(Math.round(n)))}`;
}

export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

export function formatUsdOrNull(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return formatUsd(amount);
}

export function formatDuration(value, { unknown = "?", zero = "0s" } = {}) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return unknown;
  if (ms <= 0) return zero;
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - totalMinutes * 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - totalHours * 60;
  if (totalHours < 24) return `${totalHours}h${minutes > 0 ? ` ${minutes}m` : ""}`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours - days * 24;
  return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
}

export function formatRelativeTime(targetIso) {
  if (!targetIso) return "?";
  const deltaMs = Date.parse(targetIso) - Date.now();
  if (!Number.isFinite(deltaMs)) return "?";
  const absMs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "" : " ago";
  if (absMs >= 24 * 60 * 60 * 1000) return `${Math.round(absMs / (24 * 60 * 60 * 1000))}d${suffix}`;
  if (absMs >= 60 * 60 * 1000) return `${Math.round(absMs / (60 * 60 * 1000))}h${suffix}`;
  if (absMs >= 60 * 1000) return `${Math.round(absMs / (60 * 1000))}m${suffix}`;
  return `${Math.max(1, Math.round(absMs / 1000))}s${suffix}`;
}
