import path from "path";
import {
  artifactBasenameForRepoImage,
  collectRequestedImageOutputs,
  hasRequestedImageGenerationOutput,
  normalizeCreateRootsForFiles,
  resolveRepoImageDestination,
  uniqueNormalizedPlannerPaths,
} from "./image-outputs.js";
import {
  getCreateFileKindSummary,
  isArtifactScopedPath,
} from "./plan-routing.js";

export function resolvePromoteSourceDir(task, tasks, artifactDirAbs) {
  const normalizedArtifactRoot = String(artifactDirAbs || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedSource = String(task?.source_dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const candidateIndexes = [];
  if (Number.isInteger(task?._split_promote_source_index)) {
    candidateIndexes.push(task._split_promote_source_index);
  }
  if (Array.isArray(task?.depends_on_index)) {
    for (const depIdx of task.depends_on_index) {
      if (Number.isInteger(depIdx)) candidateIndexes.push(depIdx);
    }
  }

  const shouldInfer = candidateIndexes.length > 0
    && (!normalizedSource || normalizedSource === normalizedArtifactRoot);
  if (!shouldInfer) return task?.source_dir || null;

  for (const idx of [...new Set(candidateIndexes)]) {
    const sourceTask = tasks?.[idx];
    if (sourceTask?.output_root) return sourceTask.output_root;
  }
  return task?.source_dir || null;
}

function normalizePromotePath(value) {
  return String(value || "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
}

function mappingBasename(mapping) {
  const pattern = String(mapping?.pattern || "").trim().replace(/\\/g, "/");
  if (!pattern || /[*?[\]{}]/.test(pattern)) return null;
  const basename = path.posix.basename(pattern);
  return basename && basename !== "." && basename !== ".." ? basename : null;
}

function artifactSourceCandidates(task, tasks) {
  const indexes = [];
  if (Number.isInteger(task?._split_promote_source_index)) {
    indexes.push(task._split_promote_source_index);
  }
  if (Array.isArray(task?.depends_on_index)) {
    for (const depIdx of task.depends_on_index) {
      if (Number.isInteger(depIdx)) indexes.push(depIdx);
    }
  }

  const seen = new Set();
  const candidates = [];
  for (const index of indexes) {
    if (seen.has(index)) continue;
    seen.add(index);
    const sourceTask = tasks?.[index];
    const sourceDir = normalizePromotePath(sourceTask?.output_root);
    if (!sourceDir) continue;
    const files = [
      ...(Array.isArray(sourceTask?.files_to_create) ? sourceTask.files_to_create : []),
      ...collectRequestedImageOutputs(sourceTask || {}),
    ];
    const declaredBasenames = new Set(files
      .map((file) => path.posix.basename(String(file || "").replace(/\\/g, "/")))
      .filter(Boolean));
    const text = [
      sourceTask?.title || "",
      sourceTask?.task_spec || "",
      sourceTask?.instructions || "",
      ...(Array.isArray(sourceTask?.success_criteria) ? sourceTask.success_criteria : [sourceTask?.success_criteria || ""]),
    ].join("\n").toLowerCase();
    candidates.push({
      index,
      sourceDir,
      declaredBasenames,
      text,
    });
  }
  return candidates;
}

function scoreMappingForSource(mapping, source) {
  const basename = mappingBasename(mapping);
  if (!basename) return 0;
  const lowered = basename.toLowerCase();
  if (source.declaredBasenames.has(basename)) return 100;
  for (const declared of source.declaredBasenames) {
    if (declared.toLowerCase() === lowered) return 100;
  }
  return source.text.includes(lowered) ? 60 : 0;
}

function bestSourceForMapping(mapping, sources) {
  let best = null;
  let bestScore = -1;
  for (const source of sources) {
    const score = scoreMappingForSource(mapping, source);
    if (
      score > bestScore
      || (score === bestScore && best && source.index < best.index)
    ) {
      best = source;
      bestScore = score;
    }
  }
  return best;
}

function promoteSplitTitle(title, group, offset) {
  const base = String(title || "Promote artifacts").trim();
  const names = group.mappings
    .map((mapping) => mappingBasename(mapping))
    .filter(Boolean);
  const suffix = names.length === 1 ? names[0] : `output dir ${offset + 1}`;
  return `${base} (${suffix})`.slice(0, 120);
}

export function routePromoteTaskByOutputDir(task, index, tasks, artifactDirAbs) {
  if (!task || task.job_type !== "promote" || task._split_promote_by_output_dir_done) return null;
  const mappings = Array.isArray(task.mappings) ? task.mappings.filter((mapping) => mapping && typeof mapping === "object") : [];
  if (mappings.length === 0) return null;

  const sources = artifactSourceCandidates(task, tasks);
  if (sources.length === 0) return null;
  if (sources.length === 1) {
    const currentSource = normalizePromotePath(task.source_dir);
    const sourceDir = sources[0].sourceDir;
    if (sourceDir && currentSource !== sourceDir) {
      return {
        normalizedTask: {
          ...task,
          source_dir: sourceDir,
          _split_promote_by_output_dir_done: true,
        },
        reason: `scoped promote task "${task.title}" to artifact output ${sourceDir}`,
      };
    }
    return null;
  }

  const groupsBySourceIndex = new Map();
  const fallbackMappings = [];
  for (const mapping of mappings) {
    const source = bestSourceForMapping(mapping, sources);
    if (!source) {
      fallbackMappings.push(mapping);
      continue;
    }
    const group = groupsBySourceIndex.get(source.index) || {
      sourceIndex: source.index,
      sourceDir: source.sourceDir,
      mappings: [],
    };
    group.mappings.push(mapping);
    groupsBySourceIndex.set(source.index, group);
  }

  const groups = [];
  for (const source of sources) {
    const group = groupsBySourceIndex.get(source.index);
    if (group) groups.push(group);
  }
  if (fallbackMappings.length > 0) {
    groups.push({
      sourceIndex: null,
      sourceDir: normalizePromotePath(task.source_dir) || normalizePromotePath(artifactDirAbs) || sources[0].sourceDir,
      mappings: fallbackMappings,
    });
  }

  if (groups.length === 0) return null;
  if (groups.length === 1) {
    const [group] = groups;
    const currentSource = normalizePromotePath(task.source_dir);
    if (group.sourceDir && currentSource !== group.sourceDir) {
      return {
        normalizedTask: {
          ...task,
          source_dir: group.sourceDir,
          _split_promote_by_output_dir_done: true,
        },
        reason: `scoped promote task "${task.title}" to artifact output ${group.sourceDir}`,
      };
    }
    return null;
  }

  const originalDeps = Array.isArray(task.depends_on_index) ? task.depends_on_index.filter(Number.isInteger) : [];
  const sourceIndexes = new Set(groups.map((group) => group.sourceIndex).filter(Number.isInteger));
  const sharedDeps = originalDeps.filter((depIdx) => !sourceIndexes.has(depIdx));
  const splitTasks = [];
  for (let offset = 0; offset < groups.length; offset++) {
    const group = groups[offset];
    const depSet = new Set(sharedDeps);
    if (Number.isInteger(group.sourceIndex)) {
      depSet.add(group.sourceIndex);
    } else {
      for (const depIdx of originalDeps) depSet.add(depIdx);
    }
    if (offset > 0) depSet.add(index + offset - 1);
    splitTasks.push({
      ...task,
      title: promoteSplitTitle(task.title, group, offset),
      source_dir: group.sourceDir,
      mappings: group.mappings,
      depends_on_index: [...depSet].filter((depIdx) => depIdx !== index + offset),
      _split_promote_by_output_dir_done: true,
    });
  }

  return {
    splitTasks,
    finalIndex: index + splitTasks.length - 1,
    reason: `split promote task "${task.title}" by artifact output directory (${splitTasks.length} promote jobs)`,
  };
}

function buildImageSplitPieces(task, imageFiles, artifactDirAbs, sourceTaskIndex = null) {
  const usedNames = new Set();
  const mappedDestinations = new Set();
  const artifactFiles = [];
  const promoteMappings = [];
  const imageLines = [];

  const normalizedImageFiles = uniqueNormalizedPlannerPaths(imageFiles);
  const repoImageFiles = [];
  const artifactOnlyImageFiles = [];
  for (const normalized of normalizedImageFiles) {
    if (isArtifactScopedPath(normalized, artifactDirAbs) || !normalized.includes("/")) {
      artifactOnlyImageFiles.push(normalized);
    } else {
      repoImageFiles.push(normalized);
    }
  }

  for (const normalized of repoImageFiles) {
    const resolvedDestination = resolveRepoImageDestination(normalized, task);
    if (mappedDestinations.has(resolvedDestination)) continue;
    mappedDestinations.add(resolvedDestination);
    const artifactName = artifactBasenameForRepoImage(resolvedDestination, usedNames);
    artifactFiles.push(artifactName);
    promoteMappings.push({ pattern: artifactName, dest: resolvedDestination });
    imageLines.push(`- ${artifactName} -> ${resolvedDestination}`);
  }

  for (const normalized of artifactOnlyImageFiles) {
    const artifactName = path.posix.basename(normalized);
    if (!artifactName || usedNames.has(artifactName)) continue;
    usedNames.add(artifactName);
    artifactFiles.push(artifactName);
    imageLines.push(`- ${artifactName}`);
  }

  const hasNamedOutputs = artifactFiles.length > 0;
  const imageOutputLines = imageLines.length > 0
    ? imageLines
    : ["- Generate the requested image deliverable(s), write them under output_root, and manifest the file names."];

  const imageTask = {
    ...task,
    title: `Generate images for: ${task.title}`.slice(0, 120),
    job_type: "artificer",
    task_mode: "image",
    needs_image_generation: true,
    files_to_modify: [],
    files_to_create: artifactFiles,
    files_to_delete: [],
    output_root: artifactDirAbs,
    create_roots: [artifactDirAbs],
    depends_on_index: [],
    success_criteria: hasNamedOutputs
      ? [`Generated image artifact file(s): ${artifactFiles.join(", ")}`]
      : ["Generated requested image artifact deliverable(s) under output_root"],
    task_spec: [
      task.task_spec || task.instructions || "",
      "",
      "File-kind split: generate the image asset(s) as artifact output. Do not edit repo code in this job.",
      "Image outputs:",
      ...imageOutputLines,
    ].filter(Boolean).join("\n"),
    _file_kind_split_done: true,
  };

  const promoteTask = promoteMappings.length > 0
    ? {
        title: `Promote images for: ${task.title}`.slice(0, 120),
        job_type: "promote",
        mappings: promoteMappings,
        depends_on_index: [],
        ...(Number.isInteger(sourceTaskIndex) ? { _split_promote_source_index: sourceTaskIndex } : {}),
        _file_kind_split_done: true,
      }
    : null;

  return { imageTask, promoteTask };
}

export function splitTaskByCreateFileKind(task, index, artifactDirAbs, { taskMode, normalizedJobType } = {}) {
  if (!task || task._file_kind_split_done || task.job_type === "human_input" || task.job_type === "promote") return null;
  const summary = getCreateFileKindSummary(task, artifactDirAbs);
  const pathOnlyIsIntent = taskMode === "image" || !!task.needs_image_generation;
  const requestedImageGenerationOutput = hasRequestedImageGenerationOutput(task, { pathOnlyIsIntent });
  const requestedImageOutputs = requestedImageGenerationOutput ? collectRequestedImageOutputs(task) : [];
  if (summary.createFiles.length === 0 && !requestedImageGenerationOutput) return null;

  const filesToModify = Array.isArray(task.files_to_modify) ? task.files_to_modify : [];
  const filesToDelete = Array.isArray(task.files_to_delete) ? task.files_to_delete : [];
  const hasRepoEdits = filesToModify.length > 0 || filesToDelete.length > 0;
  const nonImageCreateFiles = summary.createFiles.filter((file) => !summary.imageFiles.includes(file));
  const hasCodeOutputs = summary.codeFiles.length > 0;
  const imageFilesForSplit = summary.imageFiles.length > 0 ? summary.imageFiles : requestedImageOutputs;
  const hasImageOutputs = imageFilesForSplit.length > 0 || requestedImageGenerationOutput;

  if (!hasImageOutputs) {
    if (hasCodeOutputs && (normalizedJobType !== "dev" || taskMode !== "code" || task.output_root || task.needs_image_generation)) {
      return {
        normalizedTask: {
          ...task,
          job_type: "dev",
          task_mode: "code",
          needs_image_generation: false,
          output_root: null,
          create_roots: normalizeCreateRootsForFiles(summary.createFiles),
          _file_kind_split_done: true,
        },
        reason: `source-file output(s) require dev/code: ${summary.codeFiles.join(", ")}`,
      };
    }
    return null;
  }

  const shouldSplit =
    summary.repoImageFiles.length > 0
    || hasCodeOutputs
    || hasRepoEdits
    || nonImageCreateFiles.length > 0;

  if (!shouldSplit) {
    if (normalizedJobType !== "artificer" || taskMode !== "image" || !task.needs_image_generation) {
      return {
        normalizedTask: {
          ...task,
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          output_root: task.output_root || artifactDirAbs,
          create_roots: Array.isArray(task.create_roots) && task.create_roots.length > 0
            ? task.create_roots
            : [task.output_root || artifactDirAbs],
          _file_kind_split_done: true,
        },
        reason: `image output(s) require artificer/image: ${(imageFilesForSplit.length > 0 ? imageFilesForSplit : ["requested image output"]).join(", ")}`,
      };
    }
    return null;
  }

  const { imageTask, promoteTask } = buildImageSplitPieces(task, imageFilesForSplit, artifactDirAbs, index);
  const splitTasks = [imageTask];
  const imageDependencyIndex = index;
  let finalDependencyIndex = imageDependencyIndex;
  if (promoteTask) {
    promoteTask.depends_on_index = [imageDependencyIndex];
    splitTasks.push(promoteTask);
    finalDependencyIndex = index + splitTasks.length - 1;
  }

  if (hasCodeOutputs || hasRepoEdits || nonImageCreateFiles.length > 0) {
    const devCreateFiles = nonImageCreateFiles;
    const originalDependencies = Array.isArray(task.depends_on_index) ? task.depends_on_index : [];
    const devTask = {
      ...task,
      title: `Code changes for: ${task.title}`.slice(0, 120),
      job_type: "dev",
      task_mode: "code",
      needs_image_generation: false,
      output_root: null,
      files_to_create: devCreateFiles,
      create_roots: normalizeCreateRootsForFiles(devCreateFiles),
      depends_on_index: [...new Set([...originalDependencies, finalDependencyIndex])],
      task_spec: [
        task.task_spec || task.instructions || "",
        "",
        "File-kind split: image outputs are generated/promoted by prerequisite jobs. Do not create or edit these image files in this dev job:",
        ...(imageFilesForSplit.length > 0
          ? imageFilesForSplit.map((file) => `- ${file}`)
          : ["- requested image deliverable(s) from the prerequisite image job"]),
      ].filter(Boolean).join("\n"),
      _file_kind_split_done: true,
    };
    splitTasks.push(devTask);
  }

  return {
    splitTasks,
    finalIndex: index + splitTasks.length - 1,
    reason: `split mixed create scope by requested output (images: ${imageFilesForSplit.length || 1}, non-images: ${nonImageCreateFiles.length}, repo edits: ${filesToModify.length + filesToDelete.length})`,
  };
}
