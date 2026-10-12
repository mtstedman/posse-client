// @ts-check
import { readonlySet } from "./readonly-collections.js";



export const VERIFICATION_PLAN_SCHEMA_VERSION = 1;

export const VERIFICATION_PLAN_CONFIG = "posse.verification.json";

export const STAGES = Object.freeze(["fast", "required", "canonical"]);

export const INTENTS = readonlySet(["test", "lint", "typecheck", "contract"]);

export const CHECK_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
