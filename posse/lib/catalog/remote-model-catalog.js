// @ts-check



export const MODEL_CATALOG_SCHEMA_VERSION = 1;

export const MODEL_CATALOG_SETTING_KEY = "model_catalog_json";

export const MODEL_CATALOG_FETCHED_AT_SETTING_KEY = "model_catalog_fetched_at";

export const MAX_MODELS_PER_PROVIDER = 200;

export const MAX_ALIASES_PER_MODEL = 8;

export const MAX_MODEL_ID_LENGTH = 128;

export const MAX_CATALOG_VERSION_LENGTH = 100;

export const MAX_PERSISTED_JSON_BYTES = 512 * 1024;

export const MAX_PRICE_PER_MILLION_USD = 10_000;

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._\[\]:-]*$/i;
