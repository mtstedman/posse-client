// @ts-check
//
// download_file: the artificer's scoped lane for external files. The harness
// downloads each public HTTPS URL byte-exact and lands it atomically at a
// destination the job's create scope already allows. A model never chooses
// headers, a request body, or a destination outside that scope, and every
// redirect hop is re-checked. The connection is pinned to the address that
// passed the public-address check, so a second DNS answer cannot redirect it.

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

import {
  DOWNLOAD_FILE_LIMITS,
  DOWNLOAD_FILE_MEDIA_TYPE_ALIASES,
  DOWNLOAD_FILE_MEDIA_TYPES,
  DOWNLOAD_FILE_OBSERVATION_TYPE,
  DOWNLOAD_FILE_USER_AGENT,
} from "../../../catalog/web-research.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { guardToolWriteLock } from "../../queue/functions/write-lock-guard.js";
import { protectedMutablePathReason, relativePathFromCwd } from "../../runtime/functions/protected-paths.js";
import { detectImageFormat } from "../../../shared/tools/functions/toolkit/image-codec.js";
import { isSensitiveEnvFileOrTargetPath, safePath } from "../../../shared/tools/functions/toolkit/path-policy.js";
import { isLocalHostName, isPublicAddress } from "./source-snapshots.js";

const TOOL_NAME = "download_file";
const REQUEST_HEADERS = Object.freeze({
  "user-agent": DOWNLOAD_FILE_USER_AGENT,
  accept: "image/png, image/jpeg, image/webp, image/gif, application/json, text/csv, text/plain, text/html;q=0.9",
  "accept-encoding": "identity",
});
const ALL_EXTENSIONS = new Set(Object.values(DOWNLOAD_FILE_MEDIA_TYPES).flatMap((entry) => entry.extensions));

class ItemError extends Error {
  /**
   * @param {string} reason
   * @param {{ budget?: boolean }} [options]
   */
  constructor(reason, { budget = false } = {}) {
    super(reason);
    this.reason = reason;
    this.budget = budget;
  }
}

/** @param {string} host */
async function defaultLookup(host) {
  return await dns.promises.lookup(host, { all: true, verbatim: true });
}

function addressFamily(address) {
  return net.isIPv6(address) ? 6 : 4;
}

/**
 * Resolve a host and require every answer to be public.
 * @param {string} host
 * @param {(host: string) => Promise<Array<{ address: string, family?: number }>>} lookup
 */
async function resolvePublicHost(host, lookup) {
  let addresses;
  try {
    addresses = await lookup(host);
  } catch {
    throw new ItemError(`could not resolve ${host}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new ItemError(`could not resolve ${host}`);
  if (!addresses.every((entry) => isPublicAddress(entry?.address))) {
    throw new ItemError(`${host} resolves to a non-public address`);
  }
  return addresses;
}

/**
 * Check one URL (initial or redirect hop) before any request is sent.
 * @param {string} raw
 * @param {(host: string) => Promise<Array<{ address: string, family?: number }>>} lookup
 */
async function assertDownloadableUrl(raw, lookup) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ItemError("url is not an absolute URL");
  }
  if (parsed.protocol !== "https:") throw new ItemError("only https:// URLs can be downloaded");
  if (parsed.username || parsed.password) throw new ItemError("credentials in URLs are not allowed");
  if (parsed.toString().length > DOWNLOAD_FILE_LIMITS.maxUrlChars) {
    throw new ItemError(`url exceeds ${DOWNLOAD_FILE_LIMITS.maxUrlChars} characters`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLocalHostName(host)) throw new ItemError("local host names are not allowed");
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new ItemError("non-public addresses are not allowed");
  } else {
    await resolvePublicHost(host, lookup);
  }
  return parsed;
}

/**
 * The production transport: node:https whose socket connects only to an
 * address that passed the public-address check at connect time.
 * @param {(host: string) => Promise<Array<{ address: string, family?: number }>>} lookup
 */
export function createPinnedHttpsFetch(lookup = defaultLookup) {
  /** @type {any} */
  const pinnedLookup = (hostname, options, callback) => {
    resolvePublicHost(hostname, lookup).then((addresses) => {
      const answers = addresses.map((entry) => ({
        address: entry.address,
        family: entry.family || addressFamily(entry.address),
      }));
      if (options?.all) callback(null, answers);
      else callback(null, answers[0].address, answers[0].family);
    }, (error) => callback(error));
  };
  /**
   * @param {string} url
   * @param {{ signal?: AbortSignal, headers?: Record<string, string> }} init
   */
  return (url, { signal, headers } = {}) => new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers,
      signal,
      lookup: pinnedLookup,
      agent: false,
    }, (response) => {
      resolve({
        status: response.statusCode || 0,
        headers: { get: (name) => {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : (value ?? null);
        } },
        body: response,
      });
    });
    request.on("error", (error) => reject(error instanceof ItemError ? error : new ItemError(
      signal?.aborted ? "download timed out" : `download failed: ${String(error?.message || error).slice(0, 160)}`,
    )));
    request.end();
  });
}

function discardBody(response) {
  const body = response?.body;
  try {
    if (typeof body?.cancel === "function") body.cancel().catch(() => {});
    else if (typeof body?.destroy === "function") body.destroy();
  } catch {
    // Discarding is best effort.
  }
}

/** @param {string | null} contentType */
export function normalizeDownloadMediaType(contentType) {
  const media = String(contentType || "").split(";")[0].trim().toLowerCase();
  return DOWNLOAD_FILE_MEDIA_TYPE_ALIASES[media] || media;
}

/**
 * @typedef {object} PreparedItem
 * @property {string} url
 * @property {string} path
 * @property {string} [error]
 * @property {string} [absolute]
 * @property {string} [extension]
 * @property {string | null} [expected]
 * @property {string | null} [sha256]
 */

/**
 * Validate one requested item and its destination before any network call.
 * @param {any} raw
 * @param {{ cwd: string, scopePredicates: any, writeGuard: (absPath: string, displayPath: string) => string | null }} options
 * @returns {PreparedItem}
 */
function prepareItem(raw, { cwd, scopePredicates, writeGuard }) {
  const url = typeof raw?.url === "string" ? raw.url.trim() : "";
  const displayPath = typeof raw?.path === "string" ? raw.path.trim() : "";
  const base = { url, path: displayPath };
  if (!url) return { ...base, error: "url is required" };
  if (url.length > DOWNLOAD_FILE_LIMITS.maxUrlChars) {
    return { ...base, error: `url exceeds ${DOWNLOAD_FILE_LIMITS.maxUrlChars} characters` };
  }
  if (!displayPath || displayPath.includes("\0")) return { ...base, error: "path is required" };
  if (displayPath.length > DOWNLOAD_FILE_LIMITS.maxPathChars) {
    return { ...base, error: `path exceeds ${DOWNLOAD_FILE_LIMITS.maxPathChars} characters` };
  }
  const expected = raw?.expected_media_type == null ? null : String(raw.expected_media_type).trim().toLowerCase();
  if (expected && !DOWNLOAD_FILE_MEDIA_TYPES[expected]) {
    return { ...base, error: `expected_media_type must be one of ${Object.keys(DOWNLOAD_FILE_MEDIA_TYPES).join(", ")}` };
  }
  const sha256 = raw?.sha256 == null ? null : String(raw.sha256).trim().toLowerCase();
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) return { ...base, error: "sha256 must be 64 hex characters" };

  const extension = path.extname(displayPath).toLowerCase();
  if (!ALL_EXTENSIONS.has(extension)) {
    return { ...base, error: `destination extension ${extension || "(none)"} is not allowed; use one of ${[...ALL_EXTENSIONS].join(", ")}` };
  }
  if (expected && !DOWNLOAD_FILE_MEDIA_TYPES[expected].extensions.includes(extension)) {
    return { ...base, error: `destination extension ${extension} does not match expected_media_type ${expected}` };
  }

  let absolute;
  try {
    absolute = safePath(cwd, displayPath, scopePredicates);
  } catch (error) {
    return { ...base, error: `blocked - ${error?.message || error}` };
  }
  if (isSensitiveEnvFileOrTargetPath(absolute)) return { ...base, error: "blocked - .env files cannot be written" };
  const protectedReason = protectedMutablePathReason(relativePathFromCwd(cwd, absolute));
  if (protectedReason) return { ...base, error: `blocked - ${displayPath} is protected: ${protectedReason}` };
  let existing = null;
  try {
    existing = fs.lstatSync(absolute);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    return { ...base, error: "blocked - the destination exists and is not a file" };
  }
  // The create scope is the only writable destination; replacing an existing
  // file additionally needs the edit grant, exactly as write_file does.
  if (!scopePredicates?.canCreate?.(absolute) || (existing && !scopePredicates?.canEdit?.(absolute))) {
    return { ...base, error: `blocked - ${displayPath} is outside the allowed creation scope` };
  }
  const guardError = writeGuard(absolute, displayPath);
  if (guardError) return { ...base, error: String(guardError).replace(/^Error:\s*/, "") };
  return { ...base, absolute, extension, expected, sha256 };
}

/**
 * Shared byte budget across the concurrent items of one call.
 * @param {number} jobBytesUsed
 */
function createByteBudget(jobBytesUsed) {
  let callUsed = 0;
  return {
    get callUsed() { return callUsed; },
    remaining() {
      return Math.max(0, Math.min(
        DOWNLOAD_FILE_LIMITS.maxBytesPerCall - callUsed,
        DOWNLOAD_FILE_LIMITS.maxBytesPerJob - jobBytesUsed - callUsed,
      ));
    },
    /** @param {number} bytes */
    reserve(bytes) {
      if (bytes > this.remaining()) return false;
      callUsed += bytes;
      return true;
    },
    /** @param {number} bytes */
    refund(bytes) {
      callUsed = Math.max(0, callUsed - bytes);
    },
  };
}

function firstMissingAncestor(directory) {
  let missing = null;
  let cursor = directory;
  while (!fs.existsSync(cursor)) {
    missing = cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return missing;
}

function removeEmptyDirectories(directory, stopAt) {
  if (!stopAt) return;
  let cursor = directory;
  for (;;) {
    try {
      fs.rmdirSync(cursor);
    } catch {
      return;
    }
    if (cursor === stopAt) return;
    cursor = path.dirname(cursor);
  }
}

/**
 * Download one prepared item. Throws ItemError with a model-visible reason.
 * @param {any} item
 * @param {{ fetchImpl: any, lookup: any, signal: AbortSignal, budget: ReturnType<typeof createByteBudget> }} options
 */
async function downloadItem(item, { fetchImpl, lookup, signal, budget }) {
  let current = item.url;
  for (let hop = 0; hop <= DOWNLOAD_FILE_LIMITS.maxRedirects; hop += 1) {
    const parsed = await assertDownloadableUrl(current, lookup);
    let response;
    try {
      response = await fetchImpl(parsed.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { ...REQUEST_HEADERS },
      });
    } catch (error) {
      if (error instanceof ItemError) throw error;
      throw new ItemError(signal.aborted ? "download timed out" : `download failed: ${String(error?.message || error).slice(0, 160)}`);
    }
    const status = Number(response?.status) || 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      discardBody(response);
      if (!location) throw new ItemError(`HTTP ${status} without a Location header`);
      let next;
      try {
        next = new URL(location, parsed);
      } catch {
        throw new ItemError(`HTTP ${status} with an invalid Location header`);
      }
      if (next.protocol !== "https:") throw new ItemError("redirect to a non-HTTPS URL");
      current = next.toString();
      continue;
    }
    if (status !== 200) {
      discardBody(response);
      throw new ItemError(`HTTP ${status}`);
    }
    return await saveResponse(item, response, { finalUrl: parsed.toString(), status, signal, budget });
  }
  throw new ItemError(`more than ${DOWNLOAD_FILE_LIMITS.maxRedirects} redirects`);
}

/**
 * Stream an accepted response to a temp file beside the destination, then
 * rename it into place. Nothing is left behind on failure.
 */
async function saveResponse(item, response, { finalUrl, status, signal, budget }) {
  const encoding = String(response.headers.get("content-encoding") || "").trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    discardBody(response);
    throw new ItemError(`content-encoding ${encoding} is not accepted`);
  }
  const mediaType = normalizeDownloadMediaType(response.headers.get("content-type"));
  const policy = DOWNLOAD_FILE_MEDIA_TYPES[mediaType];
  if (!policy) {
    discardBody(response);
    throw new ItemError(`media type ${mediaType || "(none)"} is not allowed`);
  }
  if (item.expected && mediaType !== item.expected) {
    discardBody(response);
    throw new ItemError(`media type ${mediaType} does not match expected_media_type ${item.expected}`);
  }
  if (!policy.extensions.includes(item.extension)) {
    discardBody(response);
    throw new ItemError(`media type ${mediaType} cannot be saved as ${item.extension}; use ${policy.extensions.join(" or ")}`);
  }
  const itemLimit = Math.min(DOWNLOAD_FILE_LIMITS.maxBytesPerItem, budget.remaining());
  const declared = Number.parseInt(String(response.headers.get("content-length") || ""), 10);
  if (Number.isFinite(declared) && declared > itemLimit) {
    discardBody(response);
    throw itemLimit < DOWNLOAD_FILE_LIMITS.maxBytesPerItem
      ? new ItemError(`file is ${declared} bytes; only ${itemLimit} bytes remain in the download budget`, { budget: true })
      : new ItemError(`file is ${declared} bytes; the per-file limit is ${DOWNLOAD_FILE_LIMITS.maxBytesPerItem}`);
  }

  const directory = path.dirname(item.absolute);
  const createdRoot = firstMissingAncestor(directory);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(item.absolute)}.${process.pid}.${crypto.randomUUID()}.part`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let head = Buffer.alloc(0);
  let handle = null;
  let committed = false;
  try {
    handle = await fs.promises.open(temp, "wx");
    if (!response.body) throw new ItemError("response has no body");
    for await (const chunk of response.body) {
      if (signal.aborted) throw new ItemError("download timed out");
      const buffer = Buffer.from(chunk);
      if (bytes + buffer.length > DOWNLOAD_FILE_LIMITS.maxBytesPerItem) {
        throw new ItemError(`file exceeds the per-file limit of ${DOWNLOAD_FILE_LIMITS.maxBytesPerItem} bytes`);
      }
      if (!budget.reserve(buffer.length)) {
        throw new ItemError("the per-call or per-job download byte budget is exhausted", { budget: true });
      }
      bytes += buffer.length;
      hash.update(buffer);
      if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)]);
      await handle.write(buffer);
    }
    if (signal.aborted) throw new ItemError("download timed out");
    await handle.close();
    handle = null;
    if (bytes === 0) throw new ItemError("response body is empty");
    if (policy.imageFormat && detectImageFormat(head) !== policy.imageFormat) {
      throw new ItemError(`bytes are not a ${policy.imageFormat.toUpperCase()} image although the server said ${mediaType}`);
    }
    const sha256 = hash.digest("hex");
    if (item.sha256 && item.sha256 !== sha256) throw new ItemError(`sha256 mismatch: got ${sha256}`);
    fs.renameSync(temp, item.absolute);
    committed = true;
    return { url: item.url, final_url: finalUrl, status, content_type: mediaType, bytes, sha256, path: item.path };
  } catch (error) {
    budget.refund(bytes);
    if (error instanceof ItemError) throw error;
    throw new ItemError(signal.aborted
      ? "download timed out"
      : `download failed: ${String(error?.message || error).slice(0, 160)}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed) {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
      removeEmptyDirectories(directory, createdRoot);
      discardBody(response);
    }
  }
}

function recordProvenance(context, results, totals, record) {
  const items = results.map((result) => (result.error
    ? { url: result.url, path: result.path, error: result.error }
    : { ...result }));
  try {
    record({
      work_item_id: context?.work_item_id ?? null,
      job_id: context?.job_id ?? null,
      attempt_id: context?.attempt_id ?? null,
      observation_type: DOWNLOAD_FILE_OBSERVATION_TYPE,
      summary: `Downloaded ${totals.downloaded}/${results.length} files (${totals.bytes} bytes)`,
      detail: {
        tool: TOOL_NAME,
        agent_call_id: context?.agent_call_id ?? null,
        fetched_at: totals.fetchedAt,
        downloaded: totals.downloaded,
        failed: totals.failed,
        bytes: totals.bytes,
        items,
      },
    });
  } catch {
    // Provenance is telemetry; it must not change the tool result.
  }
}

/**
 * Execute one download_file call.
 * @param {any} args
 * @param {{
 *   cwd: string,
 *   scopePredicates: any,
 *   jobState: { downloadBytes?: number },
 *   context?: Record<string, any>,
 *   fetchImpl?: any,
 *   lookup?: (host: string) => Promise<Array<{ address: string, family?: number }>>,
 *   signal?: AbortSignal | null,
 *   writeGuard?: (absPath: string, displayPath: string) => string | null,
 *   record?: (observation: any) => unknown,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<string>}
 */
export async function downloadFilesWithinScope(args, {
  cwd,
  scopePredicates,
  jobState,
  context = {},
  fetchImpl = null,
  lookup = defaultLookup,
  signal = null,
  writeGuard = (_absolute, displayPath) => guardToolWriteLock(TOOL_NAME, displayPath, cwd),
  record = recordObservation,
  now = () => new Date(),
}) {
  const requested = Array.isArray(args?.items) ? args.items : null;
  if (!requested || requested.length === 0) return "Error: download_file requires a non-empty items array.";
  if (requested.length > DOWNLOAD_FILE_LIMITS.maxItemsPerCall) {
    return `Error: download_file accepts at most ${DOWNLOAD_FILE_LIMITS.maxItemsPerCall} items per call; split the list across calls.`;
  }
  const jobBytesUsed = Math.max(0, Number(jobState?.downloadBytes) || 0);
  if (jobBytesUsed >= DOWNLOAD_FILE_LIMITS.maxBytesPerJob) {
    return `Error: download_file per-job byte budget (${DOWNLOAD_FILE_LIMITS.maxBytesPerJob} bytes) is exhausted.`;
  }
  const fetchFn = fetchImpl || createPinnedHttpsFetch(lookup);
  const budget = createByteBudget(jobBytesUsed);
  const fetchedAt = now().toISOString();

  const seen = new Set();
  const prepared = requested.map((raw) => {
    const item = prepareItem(raw, { cwd, scopePredicates, writeGuard });
    if (item.error) return item;
    if (seen.has(item.absolute)) return { url: item.url, path: item.path, error: "duplicate destination path in this call" };
    seen.add(item.absolute);
    return item;
  });

  const callTimeout = AbortSignal.timeout(DOWNLOAD_FILE_LIMITS.callTimeoutMs);
  const callSignal = signal ? AbortSignal.any([signal, callTimeout]) : callTimeout;
  const results = new Array(prepared.length);
  let next = 0;
  const worker = async () => {
    while (next < prepared.length) {
      const index = next;
      next += 1;
      const item = prepared[index];
      if (item.error) {
        results[index] = { url: item.url, path: item.path, error: item.error };
        continue;
      }
      if (callSignal.aborted) {
        results[index] = { url: item.url, path: item.path, error: signal?.aborted ? "call canceled" : "call time budget exhausted; retry this item in another call" };
        continue;
      }
      if (budget.remaining() <= 0) {
        results[index] = { url: item.url, path: item.path, error: "the per-call or per-job download byte budget is exhausted" };
        continue;
      }
      const itemSignal = AbortSignal.any([callSignal, AbortSignal.timeout(DOWNLOAD_FILE_LIMITS.itemTimeoutMs)]);
      try {
        results[index] = await downloadItem(item, { fetchImpl: fetchFn, lookup, signal: itemSignal, budget });
      } catch (error) {
        const reason = error instanceof ItemError ? error.reason : `download failed: ${String(error?.message || error).slice(0, 160)}`;
        results[index] = { url: item.url, path: item.path, error: reason };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(DOWNLOAD_FILE_LIMITS.concurrency, prepared.length) },
    () => worker(),
  ));

  const committedBytes = results.reduce((sum, result) => sum + (result.error ? 0 : result.bytes), 0);
  if (jobState) jobState.downloadBytes = jobBytesUsed + committedBytes;
  const downloaded = results.filter((result) => !result.error).length;
  const totals = { downloaded, failed: results.length - downloaded, bytes: committedBytes, fetchedAt };
  recordProvenance(context, results, totals, record);
  return JSON.stringify({
    downloaded,
    failed: totals.failed,
    bytes: committedBytes,
    job_bytes_remaining: Math.max(0, DOWNLOAD_FILE_LIMITS.maxBytesPerJob - jobBytesUsed - committedBytes),
    results,
  });
}
