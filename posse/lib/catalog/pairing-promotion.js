// @ts-check



export const PROTOCOL = "posse.pairing_promotion.v2";

export const LEGACY_PROTOCOL = "posse.pairing_promotion.v1";

export const SHA_RE = /^[0-9a-f]{40,64}$/iu;

export const MAX_REBUILDS = 3;

export const SUMMARY_MAX_COMMITS = 20;

export const SUMMARY_MAX_FILES = 25;

// Author names and subjects come from members' commits and reach the host's
// terminal as they decide; control characters could hide or rewrite lines, and
// bidirectional overrides could reorder what a line appears to say.
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export const STALE_APPROVAL_MESSAGE = "Origin moved after this candidate was frozen; run `posse session integrate` "
  + "to rebuild it on the new origin and approve that instead";
