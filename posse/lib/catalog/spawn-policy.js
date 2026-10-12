// @ts-check
// Legal role spawn graph; runtime enforcement belongs to shared policies.


export const EMPTY_POLICY = Object.freeze({
  succeeds: Object.freeze([]),
  fails: Object.freeze([]),
});

export function freezePolicy({ succeeds = [], fails = [] } = {}) {
  return Object.freeze({
    succeeds: Object.freeze([...new Set((Array.isArray(succeeds) ? succeeds : []).filter(Boolean))]),
    fails: Object.freeze([...new Set((Array.isArray(fails) ? fails : []).filter(Boolean))]),
  });
}

export const ROLE_SPAWN_POLICIES = Object.freeze({
  researcher: freezePolicy({ fails: ["human_input"] }),
  planner: freezePolicy({ succeeds: ["dev", "fix", "artificer", "promote", "human_input"], fails: ["human_input"] }),
  dev: freezePolicy({ succeeds: ["dev", "human_input"], fails: ["human_input"] }),
  fix: freezePolicy({ succeeds: ["dev", "human_input"], fails: ["human_input"] }),
  assessor: freezePolicy({ succeeds: ["promote"], fails: ["fix", "human_input", "artificer", "promote", "research", "plan"] }),
  artificer: freezePolicy({ fails: ["human_input"] }),
  preflight: EMPTY_POLICY,
  summary: EMPTY_POLICY,
});
