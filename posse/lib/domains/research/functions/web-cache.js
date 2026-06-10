import crypto from "crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getArtifactsByWorkItem, storeArtifact } from "../../queue/functions/index.js";

const WEB_CACHE_ARTIFACT_TYPE = "web_fetch_cache";

export function normalizeWebCacheUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export function webCacheKey(url) {
  const normalized = normalizeWebCacheUrl(url);
  return normalized
    ? crypto.createHash("sha256").update(normalized).digest("hex")
    : "";
}

function safeJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function excerptForUrl(output, url) {
  const normalized = normalizeWebCacheUrl(url);
  const host = (() => {
    try { return new URL(normalized).hostname; } catch { return ""; }
  })();
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (line.includes(url) || (host && line.includes(host))))
    .slice(0, 6);
  return lines.join("\n").slice(0, 2000);
}

function observedFetchUrls(jobId) {
  if (!jobId) return [];
  const rows = getDb().prepare(`
    SELECT detail_json
    FROM job_observations
    WHERE job_id = ? AND observation_type = 'tool.web_fetch'
  `).all(jobId);
  return rows
    .map((row) => safeJson(row.detail_json, {}))
    .map((detail) => String(detail?.url || "").trim())
    .filter(Boolean);
}

export function getWebFetchCacheEntries(workItemId) {
  if (!workItemId) return [];
  return getArtifactsByWorkItem(workItemId, WEB_CACHE_ARTIFACT_TYPE)
    .map((artifact) => {
      const json = safeJson(artifact.content_json, {});
      return {
        artifactId: artifact.id,
        jobId: artifact.job_id,
        url: json.url || artifact.url || "",
        normalizedUrl: json.normalized_url || normalizeWebCacheUrl(json.url || artifact.url || ""),
        urlHash: json.url_hash || webCacheKey(json.url || artifact.url || ""),
        excerpt: artifact.content_long || json.evidence_excerpt || "",
      };
    })
    .filter((entry) => entry.normalizedUrl);
}

export function buildWebFetchCachePreload(workItemId, { maxEntries = 8 } = {}) {
  const entries = getWebFetchCacheEntries(workItemId).slice(-maxEntries);
  if (entries.length === 0) return "";
  return [
    "PREVIOUSLY FETCHED URLS FOR THIS WORK ITEM:",
    "- Prefer this cached evidence over re-fetching the same URL. Re-fetch only when the cached excerpt is insufficient or stale for the claim.",
    ...entries.map((entry) => [
      `- artifact #${entry.artifactId}: ${entry.normalizedUrl}`,
      entry.excerpt ? `  excerpt: ${entry.excerpt.replace(/\s+/g, " ").slice(0, 500)}` : "",
    ].filter(Boolean).join("\n")),
    "",
  ].join("\n");
}

export function cacheResearchWebFetches({ workItemId, jobId, attemptId = null, output = "" } = {}) {
  if (!workItemId || !jobId) return [];
  const existing = new Set(getWebFetchCacheEntries(workItemId).map((entry) => entry.urlHash));
  const urls = [];
  const seen = new Set();
  for (const rawUrl of observedFetchUrls(jobId)) {
    const normalizedUrl = normalizeWebCacheUrl(rawUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    urls.push({ rawUrl, normalizedUrl });
  }
  const stored = [];
  for (const { rawUrl, normalizedUrl } of urls) {
    const urlHash = webCacheKey(normalizedUrl);
    if (!urlHash || existing.has(urlHash)) continue;
    existing.add(urlHash);
    const excerpt = excerptForUrl(output, rawUrl) || (rawUrl !== normalizedUrl ? excerptForUrl(output, normalizedUrl) : "");
    stored.push(storeArtifact({
      work_item_id: workItemId,
      job_id: jobId,
      attempt_id: attemptId,
      artifact_type: WEB_CACHE_ARTIFACT_TYPE,
      url: rawUrl,
      content_long: excerpt,
      content_json: {
        kind: WEB_CACHE_ARTIFACT_TYPE,
        url: rawUrl,
        normalized_url: normalizedUrl,
        url_hash: urlHash,
        source_job_id: jobId,
        evidence_excerpt: excerpt,
      },
      sha256: urlHash,
    }));
  }
  return stored;
}
