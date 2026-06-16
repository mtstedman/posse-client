// @ts-check
//
// HeartbeatAuthManager — the single authority for native-binary authentication.
//
// The key-gated Rust binaries (posse-atlas / posse-git / posse-remote) authenticate
// against the central heartbeat endpoint. Two pieces of material reach them:
//
//   1. The heartbeat AUTH ENVELOPE — non-secret config: the heartbeat URL, the
//      PINNED PUBLIC verification key (+ its sha256), and the JWT audience. A
//      binary needs this to validate the signed heartbeat it fetches; it carries
//      NO secret and is safe to embed in a child boot payload or process argv.
//   2. The legacy POSSE_KEY identity — historically passed as `--posse-key`. The
//      binaries now authenticate from the heartbeat envelope; the key is a
//      transitional compatibility path. In a "keyless" context (e.g. the MCP
//      sidecar, which never receives POSSE_KEY) the binary authenticates from
//      the envelope alone.
//
// Before this class, every leaf call site resolved both pieces independently
// (resolvePosseKey + nativeAuthFromSettings), so one logical retrieval spawned
// several differently-authenticated processes, each re-reading settings, and the
// MCP sidecar silently re-derived (and degraded) its own auth. This class owns
// resolution once, caches the envelope, and hands DERIVED material to consumers.
// Leaf call sites ask the manager; they never call resolvePosseKey() or
// nativeAuthFromSettings() directly.

import { nativeHeartbeatAuthFromSettings } from "../functions/auth.js";
import { resolvePosseKey } from "../../../domains/remote/functions/client.js";

export class HeartbeatAuthManager {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv | null,
   *   keyless?: boolean,
   *   posseKey?: string | null,
   *   keyResolver?: (() => string | null) | null,
   *   envelope?: Record<string, unknown> | null,
   *   envelopeResolver?: (() => (Record<string, unknown> | null)) | null,
   *   getSettingFn?: (key: string) => unknown,
   * }} [opts]
   */
  constructor({
    env = null,
    keyless = false,
    posseKey = null,
    keyResolver = null,
    envelope = undefined,
    envelopeResolver = null,
    getSettingFn = undefined,
  } = {}) {
    this._env = env || null;
    // Keyless: never resolve or emit a raw POSSE_KEY. The binary authenticates
    // from the heartbeat envelope alone.
    this._keyless = keyless === true;
    this._posseKey = posseKey || null;
    this._keyResolver = keyResolver || null;
    this._envelopeResolver = envelopeResolver || null;
    this._getSettingFn = getSettingFn || null;
    // A pre-resolved, authoritative envelope (e.g. reconstructed from a child
    // capability). When provided it is used verbatim and never re-derived;
    // `undefined` means "derive from settings/env and cache".
    this._fixedEnvelope = envelope !== undefined ? (envelope || null) : undefined;
    /** @type {Record<string, unknown> | null | undefined} */
    this._cachedEnvelope = undefined;
  }

  /**
   * The non-secret heartbeat auth envelope, cached after first resolution. This
   * is what leaves attach as `request.auth` and what is embedded (via
   * {@link getCapability}) in a child boot payload. Pass `{ refresh: true }` to
   * force re-resolution (e.g. after a settings change).
   *
   * @param {{ refresh?: boolean }} [opts]
   * @returns {Record<string, unknown> | null}
   */
  getNativeAuthEnvelope({ refresh = false } = {}) {
    if (this._fixedEnvelope !== undefined) {
      return this._fixedEnvelope && Object.keys(this._fixedEnvelope).length > 0
        ? this._fixedEnvelope
        : null;
    }
    if (refresh || this._cachedEnvelope === undefined) {
      const resolved = this._envelopeResolver
        ? this._envelopeResolver()
        : nativeHeartbeatAuthFromSettings(this._getSettingFn ? { getSettingFn: this._getSettingFn } : {});
      this._cachedEnvelope = resolved && typeof resolved === "object" && Object.keys(resolved).length > 0
        ? /** @type {Record<string, unknown>} */ (resolved)
        : null;
    }
    return this._cachedEnvelope;
  }

  /**
   * Resolve the legacy POSSE_KEY for the optional `--posse-key` compatibility
   * arg. This is the ONLY place a native launch resolves the key. Precedence:
   * an explicit per-call key (e.g. the remote binary's API key) always wins;
   * otherwise, in keyless mode return null so the binary authenticates from the
   * envelope alone; otherwise a constructor-pinned key, then an injected
   * resolver, then POSSE_KEY (env, then Windows-persisted).
   *
   * @param {{ optKey?: string, env?: NodeJS.ProcessEnv }} [opts]
   * @returns {string | null}
   */
  getLaunchKey({ optKey, env } = {}) {
    if (optKey) return optKey;
    if (this._keyless) return null;
    if (this._posseKey) return this._posseKey;
    if (this._keyResolver) return this._keyResolver() || null;
    return resolvePosseKey(env || this._env || process.env) || null;
  }

  /** @returns {boolean} */
  get keyless() {
    return this._keyless;
  }

  /**
   * A serializable, NON-SECRET capability for seeding a child-scoped manager
   * (e.g. embedded in the MCP boot payload). Contains only the heartbeat
   * envelope — never POSSE_KEY.
   *
   * @returns {{ envelope: Record<string, unknown> | null }}
   */
  getCapability() {
    return { envelope: this.getNativeAuthEnvelope() };
  }

  /**
   * Reconstruct a child-scoped manager from a capability produced by
   * {@link getCapability}. Keyless by default: a child must authenticate from
   * the passed envelope and never resolve a raw POSSE_KEY. A missing/empty
   * envelope falls back to settings/env derivation (still keyless), so a child
   * is never left with no auth.
   *
   * @param {{ envelope?: Record<string, unknown> | null } | null | undefined} capability
   * @param {{ keyless?: boolean }} [opts]
   * @returns {HeartbeatAuthManager}
   */
  static fromCapability(capability, { keyless = true } = {}) {
    const envelope = capability && typeof capability === "object"
      && capability.envelope && typeof capability.envelope === "object"
      && Object.keys(capability.envelope).length > 0
      ? /** @type {Record<string, unknown>} */ (capability.envelope)
      : undefined;
    return new HeartbeatAuthManager(
      envelope !== undefined ? { envelope, keyless } : { keyless },
    );
  }
}

/**
 * Shared process-wide manager. Production wires this singleton through
 * BinaryManager into every NativeBinary so the whole runtime resolves native
 * auth exactly once. Construct a fresh instance only in tests or for a
 * child-scoped capability.
 */
export const heartbeatAuthManager = new HeartbeatAuthManager();
