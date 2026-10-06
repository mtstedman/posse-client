import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { demand } from "./policy.js";

export function gatewayKey(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(filename, "wx", 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(32).toString("hex")); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = fs.lstatSync(filename);
  demand(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && (process.platform === "win32" || info.uid === process.getuid()), "Gateway key is not private", "forbidden");
  const key = fs.readFileSync(filename);
  demand(key.length >= 32, "Gateway key is invalid", "forbidden");
  return key;
}

export function verifyGatewayFrame(envelope, key, seen, now = Date.now()) {
  demand(envelope && typeof envelope === "object" && !Array.isArray(envelope)
    && Object.keys(envelope).sort().join(",") === "frame,gid,groups,kind,mac,nonce,timestamp,uid,user",
  "Invalid gateway envelope", "unauthorized");
  demand(envelope.kind === "local_gateway" && /^[a-f0-9]{32}$/.test(envelope.nonce)
    && Number.isInteger(envelope.timestamp) && Math.abs(now - envelope.timestamp * 1000) <= 30_000
    && Number.isInteger(envelope.uid) && envelope.uid >= 0 && Number.isInteger(envelope.gid) && envelope.gid >= 0
    && Array.isArray(envelope.groups) && envelope.groups.length <= 256
    && envelope.groups.every(group => Number.isInteger(group) && group >= 0)
    && typeof envelope.user === "string" && envelope.user.length <= 256
    && typeof envelope.frame === "string" && envelope.frame.length <= 2 * 1024 * 1024
    && /^[A-Za-z0-9+/]*={0,2}$/.test(envelope.frame) && /^[a-f0-9]{64}$/.test(envelope.mac)
    && !seen.has(envelope.nonce), "Invalid gateway identity", "unauthorized");
  const signed = `${envelope.nonce}\n${envelope.timestamp}\n${envelope.uid}\n${envelope.gid}\n${envelope.user}\n${envelope.groups.join(",")}\n${envelope.frame}`;
  const actual = crypto.createHmac("sha256", key).update(signed).digest();
  const supplied = Buffer.from(envelope.mac, "hex");
  demand(crypto.timingSafeEqual(actual, supplied), "Gateway authentication failed", "unauthorized");
  seen.add(envelope.nonce);
  if (seen.size > 4096) seen.delete(seen.values().next().value);
  let request;
  try { request = JSON.parse(Buffer.from(envelope.frame, "base64").toString("utf8")); }
  catch { demand(false, "Invalid gateway request", "invalid_request"); }
  demand(request && typeof request === "object" && !Array.isArray(request), "Invalid gateway request", "invalid_request");
  return { request, identity: { uid: envelope.uid, gid: envelope.gid,
    groups: [...new Set(envelope.groups)], user: envelope.user } };
}
