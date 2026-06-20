// @ts-check
//
// HeartbeatAuthManager — the single authority for native-binary authentication.
//
// The key-gated Rust binaries (posse-atlas / posse-git / posse-remote) authenticate
// against the central heartbeat endpoint. Native auth has one owner here:
//
//   The heartbeat AUTH ENVELOPE — non-secret config: the heartbeat URL, the
//   PINNED PUBLIC verification key (+ its sha256), and the JWT audience. A
//   binary needs this to validate the signed heartbeat it fetches; it carries
//   NO secret and is safe to embed in a child boot payload.
//
// Current compiled helpers still require the raw remote API key as their
// `--posse-key` launch credential. This class owns that compatibility key too,
// so legacy leaf paths (`opts.key`, ad hoc env reads, per-call resolvers) stay
// deleted while the native wrapper has one authority to consume.
//
// Before this class, every leaf call site resolved both pieces independently
// (resolvePosseKey + nativeAuthFromSettings), so one logical retrieval could
// spawn several differently-authenticated processes. This class owns resolution
// once, caches the envelope, and hands DERIVED material to consumers. Leaf call
// sites ask the manager; they never call nativeHeartbeatAuthFromSettings()
// directly.

import { nativeHeartbeatAuthFromSettings } from "../functions/auth.js";
import { resolvePosseKey } from "../../../domains/remote/functions/client.js";

export class HeartbeatAuthManager {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv | null,
   *   envelope?: Record<string, unknown> | null,
   *   envelopeResolver?: (() => (Record<string, unknown> | null)) | null,
   *   getSettingFn?: (key: string) => unknown,
   *   posseKey?: string | null,
   * }} [opts]
   */
  constructor({
    env = null,
    envelope = undefined,
    envelopeResolver = null,
    getSettingFn = undefined,
    posseKey = undefined,
  } = {}) {
    this._env = env || null;
    this._envelopeResolver = envelopeResolver || null;
    this._getSettingFn = getSettingFn || null;
    this._fixedLaunchKey = posseKey !== undefined ? (String(posseKey || "").trim() || null) : undefined;
    /** @type {string | null | undefined} */
    this._cachedLaunchKey = undefined;
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
   * Current compiled native helpers still accept their remote API credential
   * only as `--posse-key`. Resolve it here, once, so all native launch auth is
   * manager-owned and leaf call sites never read env or pass ad hoc keys.
   *
   * @param {{ refresh?: boolean }} [opts]
   * @returns {string | null}
   */
  getLaunchKey({ refresh = false } = {}) {
    if (this._fixedLaunchKey !== undefined) return this._fixedLaunchKey;
    if (refresh || this._cachedLaunchKey === undefined) {
      this._cachedLaunchKey = resolvePosseKey(this._env || process.env) || null;
    }
    return this._cachedLaunchKey;
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
   * {@link getCapability}. A child authenticates from the passed envelope. A
   * missing/empty envelope falls back to settings/env derivation, so a child is
   * never left with no auth.
   *
   * @param {{ envelope?: Record<string, unknown> | null } | null | undefined} capability
   * @returns {HeartbeatAuthManager}
   */
  static fromCapability(capability) {
    const envelope = capability && typeof capability === "object"
      && capability.envelope && typeof capability.envelope === "object"
      && Object.keys(capability.envelope).length > 0
      ? /** @type {Record<string, unknown>} */ (capability.envelope)
      : undefined;
    return new HeartbeatAuthManager(
      envelope !== undefined ? { envelope } : {},
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
