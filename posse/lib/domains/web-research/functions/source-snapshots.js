// @ts-check
//
// Byte-exact snapshots of raw web sources a web research child nominates.
// A model never transcribes the data: the harness downloads the file, keeps
// it under the work item's artifact root, and surfaces it as a durable
// work-item hash ref that the planner cites and later agents read.

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  WEB_RESEARCH_LIMITS,
  WEB_RESEARCH_OBSERVATION_TYPES,
  WEB_SOURCE_SNAPSHOT_LIMITS,
  WEB_SOURCE_SNAPSHOT_OBJECT_TYPE,
  WEB_SOURCE_SNAPSHOT_STATUSES,
} from "../../../catalog/web-research.js";
import { workItemArtifactRoot } from "../../artifacts/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";
import {
  issueHashRefTraversalForContext,
  surfaceHashRefForContext,
} from "../../queue/functions/hash-refs.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";

const SNAPSHOT_DIR = "sources";
const BLOCKED_HOST_SUFFIXES = Object.freeze([".localhost", ".local", ".internal", ".home.arpa"]);

class SnapshotError extends Error {
  /**
   * @param {string} status
   * @param {string} reason
   */
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function rejected(reason) {
  return new SnapshotError(WEB_SOURCE_SNAPSHOT_STATUSES.REJECTED, reason);
}

function failed(reason) {
  return new SnapshotError(WEB_SOURCE_SNAPSHOT_STATUSES.FAILED, reason);
}

function ipv4Octets(address) {
  const parts = String(address).split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isPublicIpv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && octets[2] === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved
  return true;
}

// Eight 16-bit groups of a valid IPv6 address, including a trailing dotted
// IPv4 part.
function ipv6Groups(value) {
  let text = value;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = ipv4Octets(dotted[2]);
    if (!octets) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (text.includes("::") ? missing < 1 : missing !== 0) return null;
  return [...left, ...Array(text.includes("::") ? missing : 0).fill("0"), ...right]
    .map((group) => Number.parseInt(group, 16));
}

function ipv4FromGroups(high, low) {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// Only globally routable addresses may be fetched: a nominated URL comes from
// a model reading untrusted web content, so it must not reach this machine's
// loopback, the local network, or cloud metadata endpoints. IPv4 embedded in
// IPv6 (mapped, compatible, NAT64, 6to4) is judged by its IPv4 address; the
// URL parser rewrites `[::ffff:127.0.0.1]` to the hex form `[::ffff:7f00:1]`.
export function isPublicAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  if (net.isIPv4(value)) return isPublicIpv4(value);
  if (!net.isIPv6(value)) return false;
  const groups = ipv6Groups(value);
  if (!groups || groups.some((group) => !Number.isInteger(group))) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return isPublicIpv4(ipv4FromGroups(g6, g7)); // ::ffff:0:0/96 mapped
    return false; // ::, ::1, and deprecated IPv4-compatible ::/96
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIpv4(ipv4FromGroups(g6, g7)); // NAT64 64:ff9b::/96
  }
  if (g0 === 0x2002) return isPublicIpv4(ipv4FromGroups(g1, g2)); // 6to4 2002::/16
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // deprecated site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
  return true;
}

// Host names that name this machine or a local network rather than a public
// site.
export function isLocalHostName(host) {
  const name = String(host || "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return !name || name === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function normalizeMediaType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

export function isAllowedSnapshotMediaType(contentType) {
  const media = normalizeMediaType(contentType);
  if (!media) return false;
  if (WEB_SOURCE_SNAPSHOT_LIMITS.allowedMediaTypes.includes(media)) return true;
  if (WEB_SOURCE_SNAPSHOT_LIMITS.allowedMediaTypePrefixes.some((prefix) => media.startsWith(prefix))) return true;
  return WEB_SOURCE_SNAPSHOT_LIMITS.allowedMediaTypeSuffixes.some((suffix) => media.endsWith(suffix));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || failed("aborted");
}

async function waitForLookup(host, lookup, signal) {
  throwIfAborted(signal);
  if (!signal) return lookup(host);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || failed("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      throwIfAborted(signal);
      return lookup(host, { signal });
    }), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * @param {string} rawUrl
 * @param {{ lookup?: (host: string, options?: {signal: AbortSignal}) => Promise<Array<{address: string}>>, signal?: AbortSignal | null }} [deps]
 */
async function assertFetchableUrl(rawUrl, { lookup = defaultLookup, signal = null } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw rejected("not an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw rejected("only http(s) sources can be snapshotted");
  if (parsed.username || parsed.password) throw rejected("credentials in source URLs are not allowed");
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLocalHostName(host)) {
    throw rejected("local host names are not allowed");
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw rejected("non-public addresses are not allowed");
    return parsed;
  }
  let addresses;
  try {
    addresses = await waitForLookup(host, lookup, signal);
  } catch {
    throwIfAborted(signal);
    throw failed(`could not resolve ${host}`);
  }
  throwIfAborted(signal);
  if (!Array.isArray(addresses) || addresses.length === 0) throw failed(`could not resolve ${host}`);
  if (!addresses.every((entry) => isPublicAddress(entry?.address))) {
    throw rejected(`${host} resolves to a non-public address`);
  }
  return parsed;
}

async function defaultLookup(host) {
  return await dns.promises.lookup(host, { all: true, verbatim: true });
}

async function readCappedBody(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw rejected(`source is ${declared} bytes; the snapshot limit is ${maxBytes}`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw rejected(`source exceeds the ${maxBytes}-byte snapshot limit`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw rejected(`source exceeds the ${maxBytes}-byte snapshot limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download one source, following redirects manually so every hop is checked.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, lookup?: any, signal?: AbortSignal | null, maxBytes?: number }} [deps]
 */
export async function downloadWebSource(url, {
  fetchImpl = globalThis.fetch,
  lookup = defaultLookup,
  signal = null,
  maxBytes = WEB_SOURCE_SNAPSHOT_LIMITS.maxBytes,
} = {}) {
  if (typeof fetchImpl !== "function") throw failed("fetch is unavailable");
  const timeout = AbortSignal.timeout(WEB_SOURCE_SNAPSHOT_LIMITS.fetchTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = url;
  for (let hop = 0; hop <= WEB_SOURCE_SNAPSHOT_LIMITS.maxRedirects; hop += 1) {
    throwIfAborted(combined);
    const parsed = await assertFetchableUrl(current, { lookup, signal: combined });
    throwIfAborted(combined);
    let response;
    try {
      response = await fetchImpl(parsed.toString(), {
        method: "GET",
        redirect: "manual",
        signal: combined,
        headers: { accept: "application/json, text/csv, text/plain, application/xml;q=0.9, */*;q=0.1" },
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || failed("aborted");
      throw failed(timeout.aborted ? "download timed out" : `download failed: ${String(error?.message || error).slice(0, 160)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw failed(`HTTP ${response.status} without a Location header`);
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!response.ok) throw failed(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!isAllowedSnapshotMediaType(contentType)) {
      throw rejected(`media type ${normalizeMediaType(contentType) || "(none)"} is not a text or data file`);
    }
    const bytes = await readCappedBody(response, maxBytes);
    throwIfAborted(combined);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw rejected("source is not valid UTF-8 text");
    }
    return { finalUrl: parsed.toString(), contentType: normalizeMediaType(contentType), bytes, text };
  }
  throw failed(`more than ${WEB_SOURCE_SNAPSHOT_LIMITS.maxRedirects} redirects`);
}

function snapshotFileName(finalUrl, sha256) {
  let base = "source";
  try {
    base = path.posix.basename(new URL(finalUrl).pathname) || "source";
  } catch {
    // keep the default
  }
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "source";
  return `${sha256.slice(0, 12)}-${safe}`;
}

function writeSnapshotFile(directory, fileName, bytes) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, fileName);
  if (fs.existsSync(target)) return target;
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, target);
  return target;
}

function workItemIdFrom(context = {}) {
  const value = Number(context.work_item_id ?? context.workItemId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Normalize nominated sources from a web_research_handoff. Invalid entries
 * are dropped with a reason instead of rejecting the child's whole handoff.
 * @param {unknown} value
 */
export function normalizeNominatedSources(value) {
  if (value == null) return { sources: [], dropped: [] };
  if (!Array.isArray(value)) return { sources: [], dropped: [{ index: null, reason: "sources must be an array" }] };
  const sources = [];
  const dropped = [];
  const seen = new Set();
  value.forEach((raw, index) => {
    if (sources.length >= WEB_RESEARCH_LIMITS.maxSources) {
      dropped.push({ index, reason: `at most ${WEB_RESEARCH_LIMITS.maxSources} sources` });
      return;
    }
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, WEB_RESEARCH_LIMITS.maxSourceLabelChars) : "";
    let normalized;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
      normalized = parsed.toString();
    } catch {
      dropped.push({ index, reason: "url must be an absolute HTTP(S) URL" });
      return;
    }
    if (normalized.length > 2_000) {
      dropped.push({ index, reason: "url exceeds 2000 characters" });
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    sources.push({ url: normalized, label: label || normalized });
  });
  return { sources, dropped };
}

function recordSnapshotObservation(context, result) {
  try {
    recordObservation({
      work_item_id: context.work_item_id ?? context.workItemId ?? null,
      job_id: context.job_id ?? context.jobId ?? null,
      attempt_id: context.attempt_id ?? context.attemptId ?? null,
      observation_type: WEB_RESEARCH_OBSERVATION_TYPES.SOURCE_SNAPSHOT,
      summary: result.status === WEB_SOURCE_SNAPSHOT_STATUSES.CAPTURED
        ? `Snapshot ${result.ref} of ${result.url} (${result.bytes} bytes)`
        : `Source ${result.url} ${result.status}: ${result.reason}`,
      detail: { ...result },
    });
  } catch {
    // Telemetry must not change the research result.
  }
}

/**
 * Snapshot nominated sources as durable work-item refs, visible to the
 * parent call through an issued traversal. Never throws for one source: each
 * returns a status the planner can see.
 * @param {Array<{url: string, label: string}>} sources
 * @param {{ context?: Record<string, any>, projectDir?: string | null, fetchImpl?: typeof fetch, lookup?: any, signal?: AbortSignal | null, dispatchId?: string | null }} [options]
 */
export async function captureWebSources(sources, {
  context = {},
  projectDir = null,
  fetchImpl = globalThis.fetch,
  lookup = defaultLookup,
  signal = null,
  dispatchId = null,
} = {}) {
  const results = [];
  const workItemId = workItemIdFrom(context);
  let remainingBytes = WEB_SOURCE_SNAPSHOT_LIMITS.maxTotalBytesPerDispatch;
  for (const source of sources) {
    throwIfAborted(signal);
    const base = { url: source.url, label: source.label };
    let result;
    if (!workItemId) {
      result = { ...base, status: WEB_SOURCE_SNAPSHOT_STATUSES.SKIPPED, reason: "no work item scope for a durable snapshot" };
    } else if (remainingBytes <= 0) {
      result = { ...base, status: WEB_SOURCE_SNAPSHOT_STATUSES.SKIPPED, reason: "per-dispatch snapshot byte budget exhausted" };
    } else {
      try {
        const download = await downloadWebSource(source.url, {
          fetchImpl,
          lookup,
          signal,
          maxBytes: Math.min(WEB_SOURCE_SNAPSHOT_LIMITS.maxBytes, remainingBytes),
        });
        throwIfAborted(signal);
        remainingBytes -= download.bytes.length;
        const sha256 = crypto.createHash("sha256").update(download.bytes).digest("hex");
        const directory = path.join(workItemArtifactRoot(workItemId, projectDir), SNAPSHOT_DIR);
        const filePath = writeSnapshotFile(directory, snapshotFileName(download.finalUrl, sha256), download.bytes);
        const descriptor = {
          kind: "web_source_snapshot",
          url: source.url,
          final_url: download.finalUrl,
          content_type: download.contentType,
          bytes: download.bytes.length,
          sha256,
        };
        const surfaced = surfaceHashRefForContext(context, {
          payloadText: download.text,
          objectType: WEB_SOURCE_SNAPSHOT_OBJECT_TYPE,
          source: "tool:dispatch_agent.web_source",
          note: `${source.label} — ${download.finalUrl}`.slice(0, 300),
          descriptor,
          sizeChars: download.text.length,
          recomputable: false,
          metadata: {
            line_semantics: "materialized",
            citable: true,
            url: source.url,
            final_url: download.finalUrl,
            content_type: download.contentType,
            bytes: download.bytes.length,
            sha256,
            file_path: filePath,
            label: source.label,
            web_research_dispatch_id: dispatchId,
            // A snapshot is the only durable copy of external data the plan
            // relies on; it must not be evicted under hash-store pressure.
            handoff_evidence_pinned: true,
            ...hashRefModelVisibility(context, { visibility: "hidden", ranges: [] }),
          },
        }, { ownerScope: "work_item" });
        if (!surfaced?.ok || !surfaced.entry?.ref) throw failed(`could not store snapshot ref (${surfaced?.error || "unknown"})`);
        /** @type {any} issueHashRefTraversalForContext's options are inferred from its defaults only. */
        const traversal = {
          ref: surfaced.entry.ref,
          sourceRef: surfaced.entry.ref,
          selector: { mode: "full" },
          sourceContentHash: surfaced.entry.content_hash || null,
        };
        issueHashRefTraversalForContext(context, traversal);
        result = {
          ...base,
          status: WEB_SOURCE_SNAPSHOT_STATUSES.CAPTURED,
          ref: surfaced.entry.ref,
          final_url: download.finalUrl,
          content_type: download.contentType,
          bytes: download.bytes.length,
          sha256,
          file: filePath,
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        const status = error instanceof SnapshotError ? error.status : WEB_SOURCE_SNAPSHOT_STATUSES.FAILED;
        const reason = error instanceof SnapshotError ? error.reason : String(error?.message || error).slice(0, 200);
        result = { ...base, status, reason };
      }
    }
    recordSnapshotObservation(context, result);
    results.push(result);
  }
  return results;
}
