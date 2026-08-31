// Stateless lease observations shared by queue projections and bridge actions.
// Ownership remains with the lease CAS primitives in leases.js.

export function jobHasLiveLeaseAt(job, observedAt) {
  if (!job?.lease_token || !job?.lease_expires_at) return false;
  const expiry = Date.parse(String(job.lease_expires_at));
  const observation = Date.parse(String(observedAt));
  return Number.isFinite(expiry) && Number.isFinite(observation) && expiry >= observation;
}
