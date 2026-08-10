import { ASSESSABLE_JOB_TYPES } from "../../../catalog/job.js";
import {
  ASSESSMENT_SCOPE_MODE_VALUES,
  SETTING_KEYS,
} from "../../../catalog/settings.js";
import { recordObservation } from "../../observability/functions/observations.js";
import {
  getIntSetting,
  getJob,
  getSetting,
} from "../../queue/functions/index.js";

export const ASSESSMENT_SCOPE_DEFAULTS = Object.freeze({
  maxGroupJobs: 4,
  maxGroupChars: 120_000,
});

export const ASSESSMENT_SCOPE_LIMITS = Object.freeze({
  minGroupJobs: 2,
  maxGroupJobs: 16,
  minGroupChars: 16_000,
  maxGroupChars: 400_000,
});

const ESTIMATE_MIN_CHARS = 2_000;
const ESTIMATE_MAX_CHARS = 200_000;
const ESTIMATE_CHARS_PER_FILE = 1_200;
const OBSERVATION_TYPE = "assessment.scope.derived";
const ESTIMATE_METHOD = "task_scope_chars_v1";
const LIMITATIONS = Object.freeze([
  "runtime_spawned_jobs_not_covered",
  "evidence_chars_are_plan_time_estimates",
  "no_group_quality_measurement",
]);

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function taskIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringLength(value) {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  return String(value).length;
}

function criteriaLength(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, criterion) => total + stringLength(criterion), 0);
  }
  return stringLength(value);
}

function scopedFileCount(task = {}) {
  return ["files_to_modify", "files_to_create", "files_to_delete"]
    .reduce((total, key) => total + (Array.isArray(task?.[key]) ? task[key].length : 0), 0);
}

export function resolveAssessmentScopeMode(value = null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ASSESSMENT_SCOPE_MODE_VALUES.includes(normalized) ? normalized : "off";
}

export function getAssessmentScopeMode() {
  try {
    return resolveAssessmentScopeMode(getSetting(SETTING_KEYS.ASSESSMENT_SCOPE_MODE));
  } catch {
    return "off";
  }
}

export function estimateTaskEvidenceChars(task = {}) {
  const taskSpec = task?.task_spec || task?.instructions || "";
  const estimate = ESTIMATE_MIN_CHARS
    + stringLength(taskSpec)
    + (ESTIMATE_CHARS_PER_FILE * scopedFileCount(task))
    + criteriaLength(task?.success_criteria);
  return Math.min(ESTIMATE_MAX_CHARS, Math.max(ESTIMATE_MIN_CHARS, estimate));
}

function normalizeLimits(limits = {}) {
  return {
    maxGroupJobs: clampInteger(
      limits.maxGroupJobs,
      ASSESSMENT_SCOPE_DEFAULTS.maxGroupJobs,
      ASSESSMENT_SCOPE_LIMITS.minGroupJobs,
      ASSESSMENT_SCOPE_LIMITS.maxGroupJobs,
    ),
    maxGroupChars: clampInteger(
      limits.maxGroupChars,
      ASSESSMENT_SCOPE_DEFAULTS.maxGroupChars,
      ASSESSMENT_SCOPE_LIMITS.minGroupChars,
      ASSESSMENT_SCOPE_LIMITS.maxGroupChars,
    ),
  };
}

function stableMemberSort(left, right) {
  return left.taskIndex - right.taskIndex || left.assessableJobId - right.assessableJobId;
}

function normalizeGraph(graph = {}) {
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodesByTaskIndex = new Map();
  const eligibleByAnchorJobId = new Map();
  const eligibleMembers = [];
  const seenMemberJobIds = new Set();
  const exclusionReasons = {
    invalid_node: 0,
    ineligible_node: 0,
    duplicate_member: 0,
  };

  for (const rawNode of rawNodes) {
    const normalizedTaskIndex = taskIndex(rawNode?.taskIndex);
    const targetJobId = positiveInteger(rawNode?.targetJobId);
    const assessableJobId = positiveInteger(rawNode?.assessableJobId);
    const node = {
      taskIndex: normalizedTaskIndex,
      targetJobId,
      assessableJobId,
      eligible: rawNode?.eligible === true,
      estimatedEvidenceChars: clampInteger(
        rawNode?.estimatedEvidenceChars,
        ESTIMATE_MIN_CHARS,
        ESTIMATE_MIN_CHARS,
        ESTIMATE_MAX_CHARS,
      ),
    };

    if (normalizedTaskIndex == null || nodesByTaskIndex.has(normalizedTaskIndex)) {
      exclusionReasons.invalid_node += 1;
      continue;
    }
    nodesByTaskIndex.set(normalizedTaskIndex, node);

    if (!node.eligible || targetJobId == null || assessableJobId == null) {
      exclusionReasons.ineligible_node += 1;
      continue;
    }
    if (seenMemberJobIds.has(assessableJobId)) {
      exclusionReasons.duplicate_member += 1;
      continue;
    }
    seenMemberJobIds.add(assessableJobId);
    eligibleMembers.push(node);
    if (!eligibleByAnchorJobId.has(targetJobId)) {
      eligibleByAnchorJobId.set(targetJobId, node);
    }
  }
  eligibleMembers.sort(stableMemberSort);

  const eligibleByTaskIndex = new Map(eligibleMembers.map((node) => [node.taskIndex, node]));
  const validEdges = [];
  const seenEdges = new Set();
  let invalidEdges = 0;
  let duplicateEdges = 0;

  for (const rawEdge of rawEdges) {
    const upstreamTaskIndex = taskIndex(rawEdge?.upstreamTaskIndex);
    const dependentTaskIndex = taskIndex(rawEdge?.dependentTaskIndex);
    const dependentJobId = positiveInteger(rawEdge?.dependentJobId);
    const rawUpstreamNode = upstreamTaskIndex == null ? null : nodesByTaskIndex.get(upstreamTaskIndex);
    const upstreamMember = upstreamTaskIndex == null
      ? null
      : eligibleByTaskIndex.get(upstreamTaskIndex)
        || eligibleByAnchorJobId.get(rawUpstreamNode?.targetJobId);
    if (
      upstreamTaskIndex == null
      || dependentTaskIndex == null
      || dependentJobId == null
      || !rawUpstreamNode
      || !nodesByTaskIndex.has(dependentTaskIndex)
      || !upstreamMember
    ) {
      invalidEdges += 1;
      continue;
    }
    const key = `${upstreamMember.assessableJobId}:${dependentTaskIndex}:${dependentJobId}`;
    if (seenEdges.has(key)) {
      duplicateEdges += 1;
      continue;
    }
    seenEdges.add(key);
    validEdges.push({
      upstreamTaskIndex: upstreamMember.taskIndex,
      upstreamMemberJobId: upstreamMember.assessableJobId,
      dependentTaskIndex,
      dependentJobId,
    });
  }

  validEdges.sort((left, right) => (
    left.dependentTaskIndex - right.dependentTaskIndex
    || left.dependentJobId - right.dependentJobId
    || left.upstreamTaskIndex - right.upstreamTaskIndex
    || left.upstreamMemberJobId - right.upstreamMemberJobId
  ));

  return {
    eligibleMembers,
    validEdges,
    stats: {
      input_nodes: rawNodes.length,
      input_edges: rawEdges.length,
      invalid_edges: invalidEdges,
      duplicate_edges: duplicateEdges,
      excluded_nodes: Object.values(exclusionReasons).reduce((total, count) => total + count, 0),
      exclusion_reasons: exclusionReasons,
    },
  };
}

function chunkMembers(members, limits) {
  const chunks = [];
  const singletonRemainders = new Set();
  const oversizedMembers = new Set();
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length >= 2) chunks.push(current);
    else if (current.length === 1) singletonRemainders.add(current[0].assessableJobId);
    current = [];
    currentChars = 0;
  };

  for (const member of [...members].sort(stableMemberSort)) {
    if (member.estimatedEvidenceChars > limits.maxGroupChars) {
      flush();
      oversizedMembers.add(member.assessableJobId);
      continue;
    }
    if (
      current.length > 0
      && (
        current.length + 1 > limits.maxGroupJobs
        || currentChars + member.estimatedEvidenceChars > limits.maxGroupChars
      )
    ) {
      flush();
    }
    current.push(member);
    currentChars += member.estimatedEvidenceChars;
    if (current.length === limits.maxGroupJobs) flush();
  }
  flush();

  return { chunks, singletonRemainders, oversizedMembers };
}

function directConsumersForMembers(members, edges) {
  const consumers = new Set();
  for (const member of members) {
    if (member.targetJobId !== member.assessableJobId) {
      consumers.add(member.targetJobId);
      continue;
    }
    for (const edge of edges) {
      if (edge.upstreamMemberJobId === member.assessableJobId) {
        consumers.add(edge.dependentJobId);
      }
    }
  }
  return [...consumers].sort((left, right) => left - right);
}

function describeGroups(kind, groupKey, chunks, edges) {
  return chunks.map((members, index) => ({
    kind,
    group_key: groupKey,
    chunk_index: index + 1,
    chunk_count: chunks.length,
    member_job_ids: members.map((member) => member.assessableJobId),
    member_task_indexes: members.map((member) => member.taskIndex),
    anchor_job_ids: [...new Set(members.map((member) => member.targetJobId))]
      .sort((left, right) => left - right),
    dependent_job_ids: directConsumersForMembers(members, edges),
    estimated_evidence_chars: members.reduce(
      (total, member) => total + member.estimatedEvidenceChars,
      0,
    ),
  }));
}

export function deriveAssessmentScopes(graph = {}, limits = {}) {
  const normalizedLimits = normalizeLimits(limits);
  const { eligibleMembers, validEdges, stats: graphStats } = normalizeGraph(graph);
  const claimedMemberJobIds = new Set();
  const singletonRemainders = new Set();
  const oversizedMembers = new Set();
  const groups = [];
  const memberByJobId = new Map(eligibleMembers.map((member) => [member.assessableJobId, member]));

  const fanInCandidates = new Map();
  for (const edge of validEdges) {
    const key = `${edge.dependentTaskIndex}:${edge.dependentJobId}`;
    const candidate = fanInCandidates.get(key) || {
      dependentTaskIndex: edge.dependentTaskIndex,
      dependentJobId: edge.dependentJobId,
      memberJobIds: new Set(),
    };
    candidate.memberJobIds.add(edge.upstreamMemberJobId);
    fanInCandidates.set(key, candidate);
  }

  const orderedFanIns = [...fanInCandidates.values()].sort((left, right) => (
    left.dependentTaskIndex - right.dependentTaskIndex
    || left.dependentJobId - right.dependentJobId
  ));
  for (const candidate of orderedFanIns) {
    const members = [...candidate.memberJobIds]
      .filter((jobId) => !claimedMemberJobIds.has(jobId))
      .map((jobId) => memberByJobId.get(jobId))
      .filter(Boolean)
      .sort(stableMemberSort);
    if (members.length < 2) continue;
    const chunked = chunkMembers(members, normalizedLimits);
    for (const jobId of chunked.singletonRemainders) singletonRemainders.add(jobId);
    for (const jobId of chunked.oversizedMembers) oversizedMembers.add(jobId);
    const described = describeGroups(
      "fan_in",
      `fan_in:${candidate.dependentTaskIndex}:${candidate.dependentJobId}`,
      chunked.chunks,
      validEdges,
    );
    for (const group of described) {
      groups.push(group);
      for (const jobId of group.member_job_ids) claimedMemberJobIds.add(jobId);
    }
  }

  const membersWithOutgoingEdges = new Set(validEdges.map((edge) => edge.upstreamMemberJobId));
  const leafMembers = eligibleMembers.filter((member) => (
    !claimedMemberJobIds.has(member.assessableJobId)
    && !membersWithOutgoingEdges.has(member.assessableJobId)
  ));
  if (leafMembers.length >= 2) {
    const chunked = chunkMembers(leafMembers, normalizedLimits);
    for (const jobId of chunked.singletonRemainders) singletonRemainders.add(jobId);
    for (const jobId of chunked.oversizedMembers) oversizedMembers.add(jobId);
    const described = describeGroups("sweep", "sweep:leaves", chunked.chunks, validEdges);
    for (const group of described) {
      groups.push(group);
      for (const jobId of group.member_job_ids) claimedMemberJobIds.add(jobId);
    }
  }

  const inlineJobIds = eligibleMembers
    .map((member) => member.assessableJobId)
    .filter((jobId) => !claimedMemberJobIds.has(jobId));
  const inlineSet = new Set(inlineJobIds);

  return {
    groups,
    inline_job_ids: inlineJobIds,
    stats: {
      ...graphStats,
      eligible_jobs: eligibleMembers.length,
      grouped_jobs: claimedMemberJobIds.size,
      inline_jobs: inlineJobIds.length,
      fan_in_groups: groups.filter((group) => group.kind === "fan_in").length,
      sweep_groups: groups.filter((group) => group.kind === "sweep").length,
      oversized_jobs: [...oversizedMembers].filter((jobId) => inlineSet.has(jobId)).length,
      singleton_remainder_jobs: [...singletonRemainders].filter((jobId) => inlineSet.has(jobId)).length,
    },
  };
}

function jobBelongsToCompilation(job, planJob, allCreatedJobIds) {
  return !!job
    && allCreatedJobIds.has(job.id)
    && Number(job.work_item_id) === Number(planJob.work_item_id)
    && Number(job.parent_job_id) === Number(planJob.id);
}

function graphFromCompilation({
  planJob,
  tasks,
  jobMap,
  plannerDependencyEdges,
  allCreatedJobIds,
  compiledTaskJobIds,
  droppedTaskIndexes,
}) {
  const taskList = Array.isArray(tasks) ? tasks : [];
  const createdIds = allCreatedJobIds instanceof Set ? allCreatedJobIds : new Set();
  const taskJobs = compiledTaskJobIds instanceof Map ? compiledTaskJobIds : new Map();
  const droppedIndexes = droppedTaskIndexes instanceof Set ? droppedTaskIndexes : new Set();
  const targets = jobMap instanceof Map ? jobMap : new Map();

  const nodes = taskList.map((task, index) => {
    const targetJobId = positiveInteger(targets.get(index));
    const compiledIds = taskJobs.get(index) instanceof Set ? [...taskJobs.get(index)] : [];
    const compiledJobs = compiledIds
      .map((jobId) => getJob(jobId))
      .filter((job) => jobBelongsToCompilation(job, planJob, createdIds));
    const assessableJob = compiledJobs.find((job) => ASSESSABLE_JOB_TYPES.has(job.job_type)) || null;
    const targetJob = targetJobId == null ? null : getJob(targetJobId);
    const validTarget = jobBelongsToCompilation(targetJob, planJob, createdIds);
    return {
      taskIndex: index,
      targetJobId: validTarget ? targetJobId : null,
      assessableJobId: assessableJob?.id || null,
      eligible: !droppedIndexes.has(index)
        && validTarget
        && assessableJob?.status === "queued",
      estimatedEvidenceChars: estimateTaskEvidenceChars(task),
    };
  });

  const edges = [];
  for (const edge of Array.isArray(plannerDependencyEdges) ? plannerDependencyEdges : []) {
    const upstreamTaskIndex = taskIndex(edge?.upstreamTaskIndex);
    const dependentTaskIndex = taskIndex(edge?.dependentTaskIndex);
    const dependentJobId = positiveInteger(edge?.dependentJobId);
    const dependentJob = dependentJobId == null ? null : getJob(dependentJobId);
    if (
      upstreamTaskIndex == null
      || dependentTaskIndex == null
      || !jobBelongsToCompilation(dependentJob, planJob, createdIds)
      || droppedIndexes.has(dependentTaskIndex)
    ) {
      continue;
    }
    edges.push({ upstreamTaskIndex, dependentTaskIndex, dependentJobId });
  }

  return { nodes, edges };
}

export function deriveAndRecordAssessmentScopes({
  worker = null,
  planJob,
  tasks = [],
  jobMap = new Map(),
  plannerDependencyEdges = [],
  allCreatedJobIds = new Set(),
  compiledTaskJobIds = new Map(),
  droppedTaskIndexes = new Set(),
  mode = getAssessmentScopeMode(),
} = {}) {
  const resolvedMode = resolveAssessmentScopeMode(mode);
  if (resolvedMode !== "shadow") {
    return { mode: resolvedMode, derived: false, recorded: false };
  }

  try {
    const params = normalizeLimits({
      maxGroupJobs: getIntSetting(
        SETTING_KEYS.ASSESSMENT_SCOPE_MAX_GROUP_JOBS,
        ASSESSMENT_SCOPE_DEFAULTS.maxGroupJobs,
      ),
      maxGroupChars: getIntSetting(
        SETTING_KEYS.ASSESSMENT_SCOPE_MAX_GROUP_CHARS,
        ASSESSMENT_SCOPE_DEFAULTS.maxGroupChars,
      ),
    });
    const graph = graphFromCompilation({
      planJob,
      tasks,
      jobMap,
      plannerDependencyEdges,
      allCreatedJobIds,
      compiledTaskJobIds,
      droppedTaskIndexes,
    });
    const result = deriveAssessmentScopes(graph, params);
    const detail = {
      schema_version: 1,
      mode: resolvedMode,
      estimate_method: ESTIMATE_METHOD,
      params: {
        max_group_jobs: params.maxGroupJobs,
        max_group_chars: params.maxGroupChars,
      },
      groups: result.groups,
      inline_job_ids: result.inline_job_ids,
      stats: result.stats,
      limitations: [...LIMITATIONS],
    };
    const recorded = recordObservation({
      work_item_id: planJob?.work_item_id ?? null,
      job_id: planJob?.id ?? null,
      observation_type: OBSERVATION_TYPE,
      summary: `Derived ${result.groups.length} hypothetical assessment group(s) covering ${result.stats.grouped_jobs} of ${result.stats.eligible_jobs} eligible job(s)`,
      detail,
    });
    return { mode: resolvedMode, derived: true, recorded, detail };
  } catch (error) {
    worker?.emit?.(
      planJob?.id,
      `[assessment-scope-shadow] derivation failed: ${String(error?.message || error).slice(0, 200)}`,
    );
    return {
      mode: resolvedMode,
      derived: false,
      recorded: false,
      error: String(error?.message || error),
    };
  }
}
