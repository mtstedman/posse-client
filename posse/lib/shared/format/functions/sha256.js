import { createHash } from "node:crypto";

// Stable UTF-8 text identities. Binary/file digests keep their own byte readers.
export function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
