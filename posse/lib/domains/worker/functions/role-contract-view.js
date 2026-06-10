// lib/worker/role-contract-view.js
//
// Small admin/debug helper for reconstructing the current role contract without
// running context assembly or provider calls. The prompt log remains historical
// ground truth; this is intentionally a current-code view.

import { getRoleClassForJobType } from "../classes/role-classes.js";

const DUMMY_PROVIDER_CLIENT = {
  call: async () => {
    throw new Error("role contract preview cannot call providers");
  },
};

export function buildCurrentRoleContract({ job, providerName = null, projectDir = null } = {}) {
  if (!job?.job_type) return { role: null, contract: "" };
  const RoleClass = getRoleClassForJobType(job.job_type);
  if (!RoleClass) return { role: null, contract: "" };
  const role = new RoleClass({
    providerClient: DUMMY_PROVIDER_CLIENT,
    context: { projectDir },
    deps: {},
  });
  const roleName = role.getRole();
  const ctx = {
    providerName,
    projectDir,
  };
  const contract = role.buildContract({ providerName, job, ctx }) || "";
  return {
    role: roleName,
    contract: String(contract || ""),
  };
}
