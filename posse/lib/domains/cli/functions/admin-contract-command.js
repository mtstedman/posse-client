import fs from "node:fs";

import {
  AdminContractError,
  adminErrorPayload,
  describeAdminSettings,
  mutateAdminSetting,
} from "../../settings/functions/admin-service.js";

const ADMIN_STDIN_VALUE_MAX_BYTES = 16_384;

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function invalidArguments(message) {
  return new AdminContractError("invalid_arguments", message);
}

function readBoundedStdinValue(fd) {
  const chunks = [];
  let total = 0;
  try {
    while (total <= ADMIN_STDIN_VALUE_MAX_BYTES) {
      const remaining = ADMIN_STDIN_VALUE_MAX_BYTES - total + 1;
      const chunk = Buffer.alloc(Math.min(4096, remaining));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const captured = chunk.subarray(0, count);
      chunks.push(captured);
      total += count;
      if (total > ADMIN_STDIN_VALUE_MAX_BYTES) {
        throw invalidArguments(`The stdin setting value exceeds ${ADMIN_STDIN_VALUE_MAX_BYTES} bytes.`);
      }
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function runAdminJsonCommand(action, args = [], {
  projectDir = process.cwd(),
  env = process.env,
  now = () => new Date(),
  stdinValue,
  stdinValueFD,
} = {}) {
  try {
    const normalizedAction = String(action || "").trim().toLowerCase();
    let payload;
    if (normalizedAction === "describe") {
      if (typeof stdinValue === "string" || Number.isInteger(stdinValueFD)) throw invalidArguments("--stdin-value is valid only for admin set.");
      if (args.length !== 0) throw invalidArguments("Usage: posse admin describe --json");
      payload = describeAdminSettings({ projectDir, env, now });
    } else if (normalizedAction === "set") {
      const fromStdin = typeof stdinValue === "string" || Number.isInteger(stdinValueFD);
      if (args.length !== (fromStdin ? 1 : 2)) {
        throw invalidArguments("Usage: posse admin set <setting_key> <value> --json");
      }
      if (typeof stdinValue === "string" && Number.isInteger(stdinValueFD)) {
        throw invalidArguments("Admin stdin value has multiple sources.");
      }
      const resolvedStdinValue = Number.isInteger(stdinValueFD)
        ? readBoundedStdinValue(stdinValueFD)
        : stdinValue;
      if (fromStdin && Buffer.byteLength(resolvedStdinValue, "utf8") > ADMIN_STDIN_VALUE_MAX_BYTES) {
        throw invalidArguments(`The stdin setting value exceeds ${ADMIN_STDIN_VALUE_MAX_BYTES} bytes.`);
      }
      payload = mutateAdminSetting({
        action: "set",
        key: args[0],
        value: fromStdin ? resolvedStdinValue : args[1],
        projectDir,
        env,
        now,
      });
    } else if (normalizedAction === "clear" || normalizedAction === "unset") {
      if (typeof stdinValue === "string" || Number.isInteger(stdinValueFD)) throw invalidArguments("--stdin-value is valid only for admin set.");
      if (args.length !== 1) throw invalidArguments("Usage: posse admin clear <setting_key> --json");
      payload = mutateAdminSetting({
        action: "clear",
        key: args[0],
        projectDir,
        env,
        now,
      });
    } else {
      throw invalidArguments(`Admin action ${normalizedAction || "(empty)"} does not support --json.`);
    }
    writeJson(payload);
    return payload;
  } catch (error) {
    const result = adminErrorPayload(error, { now });
    process.exitCode = result.exitCode;
    writeJson(result.payload);
    return result.payload;
  }
}

export function runAdminHumanClearCommand(key, {
  projectDir = process.cwd(),
  env = process.env,
  now = () => new Date(),
} = {}) {
  try {
    const result = mutateAdminSetting({
      action: "clear",
      key,
      projectDir,
      env,
      now,
    });
    console.log(`Cleared ${result.key} (${result.scope}; ${result.changed ? "changed" : "unchanged"})`);
    return result;
  } catch (error) {
    const result = adminErrorPayload(error, { now });
    process.exitCode = result.exitCode;
    console.log(`Admin clear failed [${result.payload.error.code}]: ${result.payload.error.message}`);
    return null;
  }
}
