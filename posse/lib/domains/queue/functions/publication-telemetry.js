import fs from "node:fs";
import path from "node:path";

import {
  DEPLOYMENT_RECEIPT_FILENAME,
  DEPLOYMENT_RECEIPT_MAX_BYTES,
  DEPLOYMENT_RECEIPT_SCHEMA_VERSION,
  DEPLOYMENT_RECEIPT_STATUS,
  DEPLOYMENT_STATES,
} from "../../../catalog/deployment.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { PUSH_OFFER_SUBTYPE } from "./common.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function object(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function deploymentReceipt() {
  const receiptPath = path.join(getRuntimeRoot(), DEPLOYMENT_RECEIPT_FILENAME);
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > DEPLOYMENT_RECEIPT_MAX_BYTES) {
      return { invalid: "Deployment receipt is not a bounded regular file." };
    }
    const receipt = object(fs.readFileSync(receiptPath, "utf8"));
    const revision = String(receipt.revision || "").trim().toLowerCase();
    const verifiedAt = String(receipt.verified_at || "").trim();
    const healthChecks = Array.isArray(receipt.health_checks)
      ? receipt.health_checks.map((check) => String(check || "").trim()).filter(Boolean)
      : [];
    if (receipt.schema_version !== DEPLOYMENT_RECEIPT_SCHEMA_VERSION
      || receipt.status !== DEPLOYMENT_RECEIPT_STATUS
      || !COMMIT_PATTERN.test(revision)
      || !verifiedAt
      || !Number.isFinite(Date.parse(verifiedAt))
      || healthChecks.length === 0
      || healthChecks.length > 20) {
      return { invalid: "Deployment receipt failed schema validation." };
    }
    return {
      revision,
      verified_at: verifiedAt,
      health_checks: healthChecks.slice(0, 20),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { invalid: "Deployment receipt could not be read." };
  }
}

function verifiedReceiptTelemetry(receipt, detail) {
  return {
    deployment_state: DEPLOYMENT_STATES.VERIFIED,
    deployment_head: receipt.revision,
    deployed_at: receipt.verified_at,
    health_checks: receipt.health_checks,
    deployment_detail: detail,
  };
}

function deploymentTelemetry({ pushed, pushedHead, pushedAt = null }) {
  const receipt = deploymentReceipt();
  if (!receipt) {
    return {
      deployment_state: DEPLOYMENT_STATES.UNVERIFIED,
      deployment_detail: "No deployment receipt has been recorded.",
    };
  }
  if (receipt.invalid) {
    return {
      deployment_state: DEPLOYMENT_STATES.UNVERIFIED,
      deployment_detail: receipt.invalid,
    };
  }
  if (!pushed || !COMMIT_PATTERN.test(pushedHead)) {
    return {
      deployment_state: DEPLOYMENT_STATES.UNVERIFIED,
      deployment_head: receipt.revision,
      deployed_at: receipt.verified_at,
      health_checks: receipt.health_checks,
      deployment_detail: "The deployment receipt cannot be bound to a recorded remote push.",
    };
  }
  if (receipt.revision !== pushedHead) {
    const receiptTime = Date.parse(receipt.verified_at);
    const pushTime = Date.parse(String(pushedAt || ""));
    if (pushed && Number.isFinite(pushTime) && receiptTime > pushTime) {
      return {
        ...verifiedReceiptTelemetry(receipt, "A newer exact-revision deployment receipt supersedes the older Posse push record."),
        supersedes_publication: true,
      };
    }
    return {
      deployment_state: DEPLOYMENT_STATES.STALE,
      deployment_head: receipt.revision,
      deployed_at: receipt.verified_at,
      health_checks: receipt.health_checks,
      deployment_detail: `Deployment receipt is for ${receipt.revision.slice(0, 12)}, not pushed commit ${pushedHead.slice(0, 12)}.`,
    };
  }
  return verifiedReceiptTelemetry(receipt, "Deployment health checks verified the exact pushed commit.");
}

export function getPublicationTelemetry() {
  try {
    const row = getDb().prepare(`
      SELECT id, status, payload_json, result_json, created_at, updated_at
      FROM jobs
      WHERE job_type = 'human_input'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.subtype') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(PUSH_OFFER_SUBTYPE);
    if (!row) {
      const receipt = deploymentReceipt();
      if (receipt && !receipt.invalid) {
        return {
          publication_state: "pushed",
          ...verifiedReceiptTelemetry(receipt, "The exact-revision deployment receipt is the publication evidence."),
          publication_source: "deployment_receipt",
          remote: null,
          branch: null,
          head: receipt.revision,
          ahead_count: null,
          recorded_at: receipt.verified_at,
          detail: "An exact, health-checked deployment receipt was recorded.",
        };
      }
      return {
        publication_state: "unknown",
        deployment_state: DEPLOYMENT_STATES.UNVERIFIED,
        detail: "No publication receipt has been recorded.",
      };
    }
    const payload = object(row.payload_json);
    const result = object(row.result_json);
    const pushed = row.status === "succeeded" && result.pushed === true;
    const pending = ["queued", "leased", "running", "waiting_on_human", "waiting_on_review", "blocked"].includes(row.status)
      || result.declined === true;
    const pushedHead = String(payload.push_head_hash || "").trim().toLowerCase();
    const pushRecordedAt = row.updated_at || row.created_at || null;
    const deployment = deploymentTelemetry({ pushed, pushedHead, pushedAt: pushRecordedAt });
    const deploymentSupersedesPush = deployment.supersedes_publication === true;
    const { supersedes_publication: _supersedesPublication, ...visibleDeployment } = deployment;
    return {
      publication_state: pushed || deploymentSupersedesPush ? "pushed" : pending ? "local_only" : "unknown",
      ...visibleDeployment,
      ...(deploymentSupersedesPush ? { publication_source: "deployment_receipt" } : {}),
      remote: payload.remote || result.remote || null,
      branch: payload.push_branch || result.branch || null,
      head: deploymentSupersedesPush ? deployment.deployment_head : pushedHead || null,
      ahead_count: deploymentSupersedesPush
        ? null
        : Number.isFinite(Number(payload.ahead_count)) ? Number(payload.ahead_count) : null,
      recorded_at: deploymentSupersedesPush ? deployment.deployed_at : pushRecordedAt,
      detail: deploymentSupersedesPush
        ? "A newer exact, health-checked deployment receipt superseded the older Posse push record."
        : pushed
        ? `Remote push was recorded; ${deployment.deployment_detail}`
        : pending
          ? "Changes are local and still require publication."
          : "Publication outcome could not be verified from the latest offer.",
    };
  } catch {
    return {
      publication_state: "unknown",
      deployment_state: DEPLOYMENT_STATES.UNVERIFIED,
      detail: "Publication telemetry is unavailable.",
    };
  }
}
