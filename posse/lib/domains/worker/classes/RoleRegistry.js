// lib/domains/worker/classes/RoleRegistry.js
//
// Central construction point for role instances. Production workers register
// roles here so helper code does not construct agents ad hoc.

export class RoleRegistry {
  constructor({ providerClient, context = null, deps = {} } = {}) {
    if (!providerClient || typeof providerClient.call !== "function") {
      throw new Error("RoleRegistry requires providerClient");
    }
    this.providerClient = providerClient;
    this.context = context;
    this.deps = deps;
    this.roles = new Map();
  }

  register(jobType, RoleClass) {
    if (!jobType) throw new Error("RoleRegistry.register requires jobType");
    if (typeof RoleClass !== "function") {
      throw new Error(`RoleRegistry.register requires a RoleClass for ${jobType}`);
    }
    const role = new RoleClass({
      providerClient: this.providerClient,
      context: this.context,
      deps: this.deps,
    });
    this.roles.set(jobType, role);
    return role;
  }

  get(jobType) {
    return this.roles.get(jobType) || null;
  }

  has(jobType) {
    return this.roles.has(jobType);
  }
}
