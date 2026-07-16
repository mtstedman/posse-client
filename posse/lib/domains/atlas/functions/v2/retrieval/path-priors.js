// @ts-check
//
// Pure candidate-pool shaping for experimental symbol.search path priors.
// The baseline path never calls this module; callers opt in with one or more
// of the four path-prior options after backend fusion and before result trim.

export const PATH_PRIOR_MULTIPLIERS = Object.freeze({
  implementation: 1,
  declaration: 0.58,
  test: 0.74,
  fixture: 0.62,
  generated: 0.34,
  vendor: 0.28,
  tooling: 0.68,
  example: 0.7,
  docs: 0.6,
  legacy: 0.72,
});

export const GENERIC_SYMBOL_MULTIPLIER = 0.55;
export const GENERIC_SYMBOL_REPRESENTATIVE_MULTIPLIER = 0.82;

const TOOLING_PATH_CLASSES = new Set([
  "test",
  "fixture",
  "generated",
  "vendor",
  "tooling",
  "example",
  "docs",
  "legacy",
]);

const CLASS_SEVERITY = [
  "vendor",
  "generated",
  "declaration",
  "fixture",
  "docs",
  "tooling",
  "example",
  "test",
  "legacy",
  "implementation",
];

const TEST_SEGMENTS = new Set(["test", "tests", "spec", "specs", "__tests__"]);
const FIXTURE_SEGMENTS = new Set(["fixture", "fixtures", "__fixtures__", "testdata", "snapshots", "__snapshots__"]);
const GENERATED_SEGMENTS = new Set(["build", "built", "dist", "generated", "gen", "out", "output", "coverage"]);
const VENDOR_SEGMENTS = new Set(["vendor", "vendors", "node_modules", "third_party", "third-party", "external"]);
const TOOLING_SEGMENTS = new Set(["script", "scripts", "tool", "tools", "tooling", "benchmark", "benchmarks", "bench", "benches", "perf"]);
const EXAMPLE_SEGMENTS = new Set(["example", "examples", "demo", "demos", "sample", "samples"]);
const DOCS_SEGMENTS = new Set(["doc", "docs", "documentation"]);
const LEGACY_SEGMENTS = new Set(["legacy", "compat", "compatibility", "deprecated", "obsolete", "archive", "archived", "migration", "migrations"]);

/**
 * @typedef {Object} RetrievalPathClassification
 * @property {string} normalizedPath
 * @property {string} primaryClass
 * @property {string[]} classes
 */

/**
 * Normalize and classify a repository-relative candidate path.
 *
 * @param {string} repoRelativePath
 * @returns {RetrievalPathClassification}
 */
export function classifyRetrievalPath(repoRelativePath) {
  const normalizedPath = normalizeRepoPath(repoRelativePath);
  const lower = normalizedPath.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const fileName = segments.at(-1) || "";
  const classes = new Set();

  if (/\.d\.(?:ts|mts|cts)$/.test(fileName) || /\.pyi$/.test(fileName)) classes.add("declaration");
  if (hasSegment(segments, TEST_SEGMENTS) || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(fileName)) classes.add("test");
  if (hasSegment(segments, FIXTURE_SEGMENTS)) classes.add("fixture");
  if (hasSegment(segments, GENERATED_SEGMENTS) || /(?:^|[._-])generated(?:[._-]|$)/.test(fileName)) classes.add("generated");
  if (hasSegment(segments, VENDOR_SEGMENTS)) classes.add("vendor");
  if (hasSegment(segments, TOOLING_SEGMENTS)) classes.add("tooling");
  if (hasSegment(segments, EXAMPLE_SEGMENTS)) classes.add("example");
  if (hasSegment(segments, DOCS_SEGMENTS) || /\.(?:md|mdx|rst|adoc)$/.test(fileName)) classes.add("docs");
  if (hasSegment(segments, LEGACY_SEGMENTS)) classes.add("legacy");
  if (classes.size === 0) classes.add("implementation");

  const ordered = CLASS_SEVERITY.filter((entry) => classes.has(entry));
  return {
    normalizedPath,
    primaryClass: ordered[0] || "implementation",
    classes: ordered,
  };
}

/**
 * Derive path-class exceptions without mutating the lexical query.
 *
 * @param {string} query
 * @param {import("./orchestrator/query-planner-types.js").QueryPlan | null | undefined} plan
 */
export function queryPathIntent(query, plan) {
  const raw = String(query || "");
  const words = new Set((raw.toLowerCase().match(/[a-z0-9]+/g) || []));
  for (const keyword of plan?.keywords || []) words.add(String(keyword).toLowerCase());
  const explicitPaths = new Set([
    ...(plan?.paths || []),
    ...(plan?.fileNames || []),
    ...extractPathLikeTerms(raw),
  ].map(normalizeRepoPath).filter(Boolean));
  const declaration = hasAny(words, ["type", "types", "typing", "declaration", "declarations", "interface", "interfaces"])
    || /(?:^|[\s/\\])[^\s/\\]+\.d\.(?:ts|mts|cts)(?:$|[\s:;,])/i.test(raw);
  const test = hasAny(words, ["test", "tests", "testing", "spec", "specs", "regression"]);
  const fixture = hasAny(words, ["fixture", "fixtures", "snapshot", "snapshots", "testdata"]);
  const tooling = hasAny(words, ["script", "scripts", "tool", "tools", "tooling", "benchmark", "benchmarks", "bench", "build", "builder", "generator", "generators"]);
  const generated = hasAny(words, ["dist", "generated", "build", "output", "vendor", "vendored"]);
  const legacy = hasAny(words, ["legacy", "compat", "compatibility", "deprecated", "obsolete", "migration", "migrations"])
    || (words.has("version") && [...words].some((word) => /^v?\d+$/.test(word)));
  const docs = hasAny(words, ["doc", "docs", "documentation", "readme"]);
  const example = hasAny(words, ["example", "examples", "demo", "demos", "sample", "samples"]);

  return {
    declaration,
    test,
    fixture,
    tooling,
    generated,
    legacy,
    docs,
    example,
    explicitPaths,
    exactIdentifier: exactIdentifierQuery(raw, plan),
  };
}

/**
 * Calculate path evidence for one candidate. Generic-family context is passed
 * through options by applyPathQualityPriors after it counts distinct files.
 *
 * @param {any} candidate
 * @param {ReturnType<typeof queryPathIntent>} intent
 * @param {{
 *   filterDeclarationFiles?: boolean,
 *   filterToolingPaths?: boolean,
 *   rawFusedScore?: number,
 *   generic?: boolean,
 *   genericRepresentative?: boolean,
 * }} options
 */
export function pathPriorForCandidate(candidate, intent, options = {}) {
  const symbol = candidatePayload(candidate);
  const path = candidatePath(symbol);
  const classification = classifyRetrievalPath(path);
  const exactSymbolMatch = isExactSymbolMatch(intent?.exactIdentifier, symbol);
  const exactPathMatch = isExactPathMatch(classification.normalizedPath, intent?.explicitPaths);
  const rawFusedScore = finiteScore(options.rawFusedScore, finiteScore(candidate?.score, 0));
  const prePriorScore = finiteScore(candidate?.score, rawFusedScore);
  const penalties = [];
  const exceptions = [];
  let multiplier = 1;

  if (exactSymbolMatch) exceptions.push("exact_symbol");
  if (exactPathMatch) exceptions.push("exact_path");
  const exactProtected = exactSymbolMatch || exactPathMatch;

  if (!exactProtected && options.filterDeclarationFiles && classification.classes.includes("declaration")) {
    if (intent?.declaration) {
      exceptions.push("declaration_intent");
    } else {
      const value = PATH_PRIOR_MULTIPLIERS.declaration;
      multiplier *= value;
      penalties.push({ pathClass: "declaration", multiplier: value });
    }
  }

  if (!exactProtected && options.filterToolingPaths) {
    for (const pathClass of classification.classes) {
      if (!TOOLING_PATH_CLASSES.has(pathClass)) continue;
      const exception = intentExceptionForClass(pathClass, intent);
      if (exception) {
        exceptions.push(exception);
        continue;
      }
      const value = PATH_PRIOR_MULTIPLIERS[pathClass] ?? 1;
      multiplier *= value;
      penalties.push({ pathClass, multiplier: value });
    }
  }

  if (!exactProtected && options.generic) {
    const value = options.genericRepresentative
      ? GENERIC_SYMBOL_REPRESENTATIVE_MULTIPLIER
      : GENERIC_SYMBOL_MULTIPLIER;
    multiplier *= value;
    penalties.push({ pathClass: "generic_symbol", multiplier: value });
  }

  const finalCandidateScore = prePriorScore * multiplier;
  return {
    rawFusedScore,
    prePriorScore,
    path: classification.normalizedPath,
    pathClass: classification.primaryClass,
    pathClasses: classification.classes,
    multiplier,
    penalties,
    exceptionReason: exceptions.length > 0 ? exceptions.join("+") : null,
    exactSymbolMatch,
    exactPathMatch,
    genericSymbol: !!options.generic,
    genericRepresentative: !!options.genericRepresentative,
    finalCandidateScore,
  };
}

/**
 * Apply enabled priors to a complete fused pool. Returns cloned entries and an
 * aggregate proof object; the input list and payloads are not mutated.
 *
 * @param {any[]} entries
 * @param {{
 *   query: string,
 *   plan?: import("./orchestrator/query-planner-types.js").QueryPlan | null,
 *   options?: {
 *     filterDeclarationFiles?: boolean,
 *     filterToolingPaths?: boolean,
 *     genericSymbolFrequencyThreshold?: number,
 *     hierarchicalFileLimit?: number,
 *     monorepoPackagePriors?: boolean,
 *   },
 *   rawScoreById?: Map<string, number> | Record<string, number>,
 * }} context
 */
export function applyPathQualityPriors(entries, context) {
  const options = context?.options || {};
  const input = Array.isArray(entries) ? entries : [];
  if (!pathQualityPriorsEnabled(options)) return { entries: input, summary: null };
  const intent = queryPathIntent(context?.query || "", context?.plan);
  const threshold = boundedInteger(options.genericSymbolFrequencyThreshold, 2, 100);
  const fileLimit = boundedInteger(options.hierarchicalFileLimit, 1, 40);
  const nameFiles = threshold ? distinctFilesByName(input) : new Map();
  const genericNames = new Set(
    [...nameFiles.entries()]
      .filter(([, files]) => files.size >= threshold)
      .map(([name]) => name),
  );

  const classAdjusted = input.map((entry, index) => {
    const evidence = pathPriorForCandidate(entry, intent, {
      filterDeclarationFiles: options.filterDeclarationFiles === true,
      filterToolingPaths: options.filterToolingPaths === true,
      rawFusedScore: rawScoreFor(entry, context?.rawScoreById),
    });
    const packagePrior = options.monorepoPackagePriors === true
      ? monorepoPackagePrior(entry, context?.query || "", evidence)
      : null;
    if (packagePrior) evidence.finalCandidateScore *= packagePrior.multiplier;
    return {
      ...entry,
      score: evidence.finalCandidateScore,
      pathPrior: { ...evidence, ...(packagePrior ? { monorepoPackage: packagePrior } : {}) },
      _pathPriorOriginalIndex: index,
    };
  });
  const representatives = bestGenericRepresentatives(classAdjusted, genericNames);
  const adjusted = classAdjusted.map((entry) => {
    const name = normalizedCandidateName(candidatePayload(entry));
    if (!genericNames.has(name) || entry.pathPrior.exactSymbolMatch || entry.pathPrior.exactPathMatch) return entry;
    const evidence = pathPriorForCandidate({
      ...entry,
      score: entry.pathPrior.prePriorScore,
    }, intent, {
      filterDeclarationFiles: options.filterDeclarationFiles === true,
      filterToolingPaths: options.filterToolingPaths === true,
      rawFusedScore: entry.pathPrior.rawFusedScore,
      generic: true,
      genericRepresentative: representatives.get(name) === entry.id,
    });
    const packagePrior = entry.pathPrior?.monorepoPackage || null;
    if (packagePrior) evidence.finalCandidateScore *= packagePrior.multiplier;
    return {
      ...entry,
      score: evidence.finalCandidateScore,
      pathPrior: { ...evidence, ...(packagePrior ? { monorepoPackage: packagePrior } : {}) },
    };
  });

  adjusted.sort(compareAdjustedEntries);
  const shaped = fileLimit ? admitAndInterleaveFiles(adjusted, fileLimit) : adjusted;
  const cleanEntries = shaped.map(({ _pathPriorOriginalIndex, ...entry }) => entry);
  const classCounts = {};
  const appliedClassCounts = {};
  for (const entry of adjusted) {
    for (const pathClass of entry.pathPrior.pathClasses) {
      classCounts[pathClass] = (classCounts[pathClass] || 0) + 1;
    }
    for (const penalty of entry.pathPrior.penalties) {
      appliedClassCounts[penalty.pathClass] = (appliedClassCounts[penalty.pathClass] || 0) + 1;
    }
  }
  const inputFiles = new Set(adjusted.map(entryFileKey));
  const outputFiles = new Set(shaped.map(entryFileKey));
  return {
    entries: cleanEntries,
    summary: {
      enabled: true,
      options: {
        filterDeclarationFiles: options.filterDeclarationFiles === true,
        filterToolingPaths: options.filterToolingPaths === true,
        genericSymbolFrequencyThreshold: threshold || null,
        hierarchicalFileLimit: fileLimit || null,
        monorepoPackagePriors: options.monorepoPackagePriors === true,
      },
      inputCandidates: input.length,
      outputCandidates: cleanEntries.length,
      inputFiles: inputFiles.size,
      admittedFiles: outputFiles.size,
      excludedFiles: Math.max(0, inputFiles.size - outputFiles.size),
      classCounts,
      appliedClassCounts,
      protectedExactCandidates: adjusted.filter((entry) => entry.pathPrior.exactSymbolMatch || entry.pathPrior.exactPathMatch).length,
      genericNames: [...genericNames].sort(),
      genericCandidates: adjusted.filter((entry) => entry.pathPrior.genericSymbol).length,
      packageMatchedCandidates: adjusted.filter((entry) => Number(entry.pathPrior?.monorepoPackage?.overlap || 0) > 0).length,
    },
  };
}

export function pathQualityPriorsEnabled(options = {}) {
  return options.filterDeclarationFiles === true
    || options.filterToolingPaths === true
    || boundedInteger(options.genericSymbolFrequencyThreshold, 2, 100) != null
    || boundedInteger(options.hierarchicalFileLimit, 1, 40) != null
    || options.monorepoPackagePriors === true;
}

function monorepoPackagePrior(entry, query, baseEvidence) {
  const path = candidatePath(candidatePayload(entry));
  const classification = classifyRetrievalPath(path);
  const queryTokens = genericTokens(query);
  const packageTokens = packageIdentityTokens(path);
  let overlap = 0;
  for (const token of packageTokens) if (queryTokens.has(token)) overlap++;
  const nonRuntime = classification.classes.some((pathClass) => [
    "test", "fixture", "generated", "vendor", "tooling", "example", "docs", "legacy",
  ].includes(pathClass));
  let multiplier = 1;
  const reasons = [];
  if (overlap > 0) {
    const reward = Math.min(0.4, 0.16 * overlap);
    multiplier *= 1 + reward;
    reasons.push("package_query_overlap");
  } else if (packageTokens.size > 0 && !baseEvidence.exactSymbolMatch && !baseEvidence.exactPathMatch) {
    multiplier *= 0.92;
    reasons.push("unmatched_package");
  }
  if (nonRuntime && !baseEvidence.exactSymbolMatch && !baseEvidence.exactPathMatch) {
    multiplier *= classification.classes.includes("legacy") ? 0.68 : 0.8;
    reasons.push(classification.classes.includes("legacy") ? "legacy_package_tree" : "non_runtime_package_tree");
  }
  return {
    overlap,
    packageTokens: [...packageTokens].sort(),
    multiplier,
    reasons,
  };
}

function packageIdentityTokens(repoPath) {
  const segments = normalizeRepoPath(repoPath).split("/").filter(Boolean);
  if (segments.length === 0) return new Set();
  const roots = new Set(["app", "apps", "crate", "crates", "lib", "libs", "module", "modules", "package", "packages", "service", "services"]);
  const rootIndex = segments.findIndex((segment) => roots.has(segment.toLowerCase()));
  const identity = rootIndex >= 0 && segments[rootIndex + 1]
    ? segments[rootIndex + 1]
    : segments.length > 1 ? segments[0] : "";
  return genericTokens(identity);
}

function genericTokens(value) {
  return new Set(String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2));
}

function admitAndInterleaveFiles(entries, limit) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entryFileKey(entry);
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  const rankedFiles = [...groups.entries()].map(([path, candidates]) => {
    candidates.sort(compareAdjustedEntries);
    return {
      path,
      candidates,
      bestScore: candidates[0]?.score || 0,
      bestIndex: Math.min(...candidates.map((entry) => entry._pathPriorOriginalIndex)),
      exact: candidates.some((entry) => entry.pathPrior.exactSymbolMatch || entry.pathPrior.exactPathMatch),
    };
  }).sort((a, b) => Number(b.exact) - Number(a.exact)
    || b.bestScore - a.bestScore
    || a.bestIndex - b.bestIndex
    || a.path.localeCompare(b.path));

  const exactFiles = rankedFiles.filter((file) => file.exact);
  const normalFiles = rankedFiles.filter((file) => !file.exact).slice(0, limit);
  const admitted = [...exactFiles, ...normalFiles]
    .filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path) === index)
    .sort((a, b) => Number(b.exact) - Number(a.exact)
      || b.bestScore - a.bestScore
      || a.bestIndex - b.bestIndex
      || a.path.localeCompare(b.path));
  const out = [];
  for (let depth = 0; ; depth += 1) {
    let appended = false;
    for (const file of admitted) {
      const entry = file.candidates[depth];
      if (!entry) continue;
      out.push(entry);
      appended = true;
    }
    if (!appended) break;
  }
  return out;
}

function compareAdjustedEntries(a, b) {
  return Number(b.pathPrior?.exactSymbolMatch || b.pathPrior?.exactPathMatch)
    - Number(a.pathPrior?.exactSymbolMatch || a.pathPrior?.exactPathMatch)
    || finiteScore(b.score, 0) - finiteScore(a.score, 0)
    || finiteScore(a._pathPriorOriginalIndex, 0) - finiteScore(b._pathPriorOriginalIndex, 0)
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function distinctFilesByName(entries) {
  const out = new Map();
  for (const entry of entries) {
    const symbol = candidatePayload(entry);
    const name = normalizedCandidateName(symbol);
    if (!name) continue;
    const files = out.get(name) || new Set();
    files.add(candidatePath(symbol) || `__unknown__/${String(entry?.id || files.size)}`);
    out.set(name, files);
  }
  return out;
}

function bestGenericRepresentatives(entries, genericNames) {
  const out = new Map();
  for (const entry of entries) {
    const name = normalizedCandidateName(candidatePayload(entry));
    if (!genericNames.has(name)) continue;
    const previousId = out.get(name);
    const previous = previousId == null ? null : entries.find((candidate) => candidate.id === previousId);
    if (!previous || compareAdjustedEntries(entry, previous) < 0) out.set(name, entry.id);
  }
  return out;
}

function rawScoreFor(entry, source) {
  if (source instanceof Map) return finiteScore(source.get(entry?.id), finiteScore(entry?.score, 0));
  if (source && typeof source === "object") return finiteScore(source[entry?.id], finiteScore(entry?.score, 0));
  return finiteScore(entry?.score, 0);
}

function candidatePayload(candidate) {
  return candidate?.payload && typeof candidate.payload === "object" ? candidate.payload : candidate || {};
}

function candidatePath(symbol) {
  return normalizeRepoPath(symbol?.repo_rel_path || symbol?.repoRelPath || symbol?.location?.repo_rel_path || symbol?.location?.repoRelPath || symbol?.file || "");
}

function normalizedCandidateName(symbol) {
  return String(symbol?.name || "").trim().toLowerCase();
}

function entryFileKey(entry) {
  return candidatePath(candidatePayload(entry)) || `__unknown__/${String(entry?.id || entry?._pathPriorOriginalIndex || "candidate")}`;
}

function exactIdentifierQuery(query, plan) {
  const trimmed = String(query || "").trim().replace(/^(['"`])(.*)\1$/, "$2");
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (plan?.identifierLike === false && !/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function isExactSymbolMatch(exactIdentifier, symbol) {
  if (!exactIdentifier) return false;
  return [symbol?.name, symbol?.qualified_name, symbol?.qualifiedName]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase() === exactIdentifier);
}

function isExactPathMatch(candidate, explicitPaths) {
  if (!candidate || !(explicitPaths instanceof Set)) return false;
  for (const explicit of explicitPaths) {
    if (!explicit) continue;
    if (candidate === explicit || candidate.endsWith(`/${explicit}`) || explicit.endsWith(`/${candidate}`)) return true;
  }
  return false;
}

function intentExceptionForClass(pathClass, intent) {
  if (!intent) return null;
  if (pathClass === "test" && intent.test) return "test_intent";
  if (pathClass === "fixture" && (intent.fixture || intent.test)) return intent.fixture ? "fixture_intent" : "test_intent";
  if (pathClass === "generated" && intent.generated) return "generated_intent";
  if (pathClass === "vendor" && intent.generated) return "generated_intent";
  if (pathClass === "tooling" && intent.tooling) return "tooling_intent";
  if (pathClass === "example" && intent.example) return "example_intent";
  if (pathClass === "docs" && intent.docs) return "docs_intent";
  if (pathClass === "legacy" && intent.legacy) return "legacy_intent";
  return null;
}

function normalizeRepoPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function extractPathLikeTerms(raw) {
  return [...String(raw || "").matchAll(/(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+)/g)].map((match) => match[0]);
}

function hasSegment(segments, set) {
  return segments.some((segment) => set.has(segment));
}

function hasAny(words, values) {
  return values.some((value) => words.has(value));
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

function finiteScore(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
