// @ts-check
import { INSTALLATION_POLICY } from "./installation-policy.js";



export const PHP_SCIP_ENV_STAMP_FILENAME = ".posse-scip-env.json";

export const PHP_SCIP_ENV_STAMP_SCHEMA = 1;

export const PHP_SCIP_ENV_INPUTS = Object.freeze(["composer.json", "composer.lock", "patch-scip-php.mjs"]);

/** @typedef {"modern" | "legacy"} PhpScipTrackId */

/**
 * @typedef {{
 *   id: PhpScipTrackId,
 *   dir: string,
 *   minPhp: string,
 *   description: string,
 * }} PhpScipTrack
 */

/** @type {Readonly<Record<PhpScipTrackId, Readonly<PhpScipTrack>>>} */
export const PHP_SCIP_TRACKS = INSTALLATION_POLICY.phpScipTracks;

/** Preference order when no installer decision is recorded. */
/** @type {readonly PhpScipTrackId[]} */
export const PHP_SCIP_TRACK_ORDER = Object.freeze(["modern", "legacy"]);
