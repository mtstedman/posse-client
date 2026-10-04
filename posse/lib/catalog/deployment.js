// Canonical repository-local deployment receipt contract. Deployment owners
// write this ignored runtime file only after their exact-revision health checks
// pass; publication telemetry binds it to the durable push receipt.
export const DEPLOYMENT_RECEIPT_FILENAME = "deployment-receipt.json";
export const DEPLOYMENT_RECEIPT_SCHEMA_VERSION = 1;
export const DEPLOYMENT_RECEIPT_STATUS = "verified";
export const DEPLOYMENT_RECEIPT_MAX_BYTES = 32 * 1024;

export const DEPLOYMENT_STATES = Object.freeze({
  VERIFIED: "verified",
  STALE: "stale",
  UNVERIFIED: "unverified",
});
