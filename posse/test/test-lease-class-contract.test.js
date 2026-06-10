import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Lease } from "../lib/domains/queue/classes/Lease.js";

describe("lease class contract", () => {
  it("exposes lease value semantics", () => {
    const lease = new Lease({
      jobId: 42,
      token: "abc",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      ownerId: "worker-1",
    });
    assert.equal(lease.jobId, 42);
    assert.equal(lease.isExpired({ nowMs: Date.now() - 1 }), false);
    assert.equal(typeof lease.msUntilExpiry(), "number");
    assert.match(lease.toString(), /Lease\(jobId=42/);
  });
});
