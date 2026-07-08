// lib/domains/handoff/functions/helpers/context-render.js
//
// Prompt context rendering for handoff packets.

import { renderAtlasHandoffSectionsWithMeta } from "./atlas-context.js";
import { renderHashRefHandoffPacket } from "./hash-ref-packet.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { atlasBackendLabel } from "../../../integrations/functions/atlas-label.js";

export function packetToContextString(packet) {
  return renderPacketContextString(packet, { includeStable: true, includeDynamic: true });
}

export function packetToDynamicContextString(packet) {
  return renderPacketContextString(packet, { includeStable: false, includeDynamic: true });
}

function compactLine(value, max = 220) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isAtlasDevBrief(brief) {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return false;
  return String(brief.source || "").trim().toLowerCase() === "atlas";
}

function renderDevBriefFilePriorities(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return [
    "Planner file priorities:",
    ...entries.map((entry, index) => {
      const path = compactLine(entry?.path, 180);
      if (!path) return "";
      const rank = Number.isFinite(Number(entry.rank)) && Number(entry.rank) > 0
        ? Number(entry.rank)
        : index + 1;
      const details = [
        entry.usefulness && entry.usefulness !== "unspecified" ? `usefulness=${compactLine(entry.usefulness, 60)}` : "",
        entry.evidence && entry.evidence !== "unspecified" ? `evidence=${compactLine(entry.evidence, 60)}` : "",
        entry.reason ? compactLine(entry.reason, 180) : "",
      ].filter(Boolean);
      return `${rank}. ${path}${details.length > 0 ? ` - ${details.join("; ")}` : ""}`;
    }).filter(Boolean),
  ];
}

function renderDevBriefRefs(brief) {
  if (brief?.hash_ref_packet) return [];
  const lines = [];
  for (const lane of ["proof", "support", "decoy"]) {
    const refs = Array.isArray(brief?.[lane]) ? brief[lane] : [];
    if (refs.length === 0) continue;
    lines.push(`${lane}:`);
    for (const ref of refs) {
      const hash = compactLine(ref?.hash || ref?.ref || ref?.ref_hash || ref, 40);
      if (!hash) continue;
      const why = compactLine(ref?.why || ref?.reason || ref?.note || "", 180);
      lines.push(`- ${hash}${why ? ` - ${why}` : ""}`);
    }
  }
  return lines;
}

function renderPlannerDevBrief(brief) {
  if (!isAtlasDevBrief(brief)) return "";
  const lines = [
    "PLANNER ATLAS DEV BRIEF (task-tailored):",
    "This is read guidance only; writable scope is still controlled by the file-scope sections below.",
  ];
  const summary = compactLine(brief.summary || brief.synthesis || "", 1200);
  if (summary) {
    lines.push("");
    lines.push(`Summary: ${summary}`);
  }
  const priorities = renderDevBriefFilePriorities(brief.planner_file_priorities);
  if (priorities.length > 0) {
    lines.push("");
    lines.push(...priorities);
  }
  for (const [label, values] of [
    ["Key files", brief.key_files],
    ["Related files", brief.related_files],
  ]) {
    if (!Array.isArray(values) || values.length === 0) continue;
    lines.push("");
    lines.push(`${label}:`);
    for (const filePath of values) {
      const normalized = compactLine(filePath, 220);
      if (normalized) lines.push(`- ${normalized}`);
    }
  }
  const refs = renderDevBriefRefs(brief);
  if (refs.length > 0) {
    lines.push("");
    lines.push("Hash refs:");
    lines.push(...refs);
  }
  return lines.join("\n");
}

function renderPacketContextString(packet, {
  includeStable = true,
  includeDynamic = true,
  trackMetrics = true,
  useContextCap = true,
} = {}) {
  const sections = [];
  const droppedSections = [];
  const optionalSections = [];
  const parsedCap = Number.parseInt(String(packet?.context_render_max_chars || ""), 10);
  const contextCap = useContextCap && Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : 0;
  let currentChars = 0;
  let requiredOverflow = false;
  const requiredOverflowSections = [];

  const optionalPriority = {
    // Highest value context first: preload content beats structure.
    editable_file_preload: 5,
    source_files: 10,
    related_files_content: 20,
    directory_tree: 30,
    related_files_dropped: 40,
    dropped_files: 50,
  };

  const addSection = (text, { required = false, key = null } = {}) => {
    if (!text) return false;
    const value = String(text);
    const candidateChars = sections.length === 0 ? value.length : value.length + 2; // join("\n\n")
    if (required && contextCap > 0 && (currentChars + candidateChars) > contextCap) {
      requiredOverflow = true;
      if (key) requiredOverflowSections.push(String(key));
    }
    if (!required && contextCap > 0 && (currentChars + candidateChars) > contextCap) {
      if (key) droppedSections.push(String(key));
      return false;
    }
    sections.push(value);
    currentChars += candidateChars;
    return true;
  };

  const queueOptional = (text, { key = null } = {}) => {
    if (!text) return;
    optionalSections.push({
      text: String(text),
      key: key ? String(key) : null,
      priority: Object.hasOwn(optionalPriority, String(key || "")) ? optionalPriority[String(key)] : 100,
      order: optionalSections.length,
    });
  };

  // Merge-in-progress is observed state. It stays in the dynamic prompt layer
  // because the agent may resolve it during the call.
  if (includeDynamic && packet.pending_merge) {
    const pm = packet.pending_merge;
    const lines = [];
    lines.push("=== MERGE IN PROGRESS - RESOLVE CONFLICTS BEFORE OTHER WORK ===");
    lines.push("");
    lines.push("A merge of the project target branch into this work-item branch was");
    lines.push("started before you were dispatched and hit conflicts. The conflict");
    lines.push("markers are in the files listed below. These paths are in your");
    lines.push("editable scope. You must:");
    lines.push("");
    lines.push("  1. Open each conflicted file, reconcile the `<<<<<<<` / `=======` /");
    lines.push("     `>>>>>>>` markers by keeping the correct combination of both sides.");
    lines.push("  2. Remove all conflict markers so the files are syntactically valid.");
    lines.push("  3. Complete your assigned task on top of the resolved state.");
    lines.push("");
    lines.push("Your final commit will complete the merge automatically - do NOT run");
    lines.push("`git merge --abort`, `git reset`, or `git checkout` against these paths.");
    lines.push("");
    if (pm.targetHash) lines.push(`Incoming commit (MERGE_HEAD): ${pm.targetHash}`);
    if (pm.mergeMsg) lines.push(`Merge message: ${pm.mergeMsg.split("\n")[0]}`);
    if (pm.truncated) {
      const total = Number(pm.total_conflict_count || pm.conflicts?.length || 0);
      const preloaded = Number(pm.preloaded_conflict_count || pm.expanded_count || 0);
      const remaining = Number(pm.unpreloaded_conflict_count || Math.max(0, total - preloaded));
      lines.push("");
      lines.push("IMPORTANT: conflict preloading was capped for this large merge.");
      lines.push(`${preloaded}/${total || "unknown"} conflicted file(s) have body snapshots preloaded; ${remaining} remaining conflicted file(s) are editable but not preloaded.`);
      lines.push("Use deterministic file reads on the non-preloaded conflict paths before editing them.");
    }
    if (pm.conflicts?.length) {
      lines.push("");
      lines.push("Conflicted files:");
      for (const c of pm.conflicts) lines.push(`  - ${c}`);
    }
    if (pm.unpreloaded_conflicts?.length) {
      lines.push("");
      lines.push("Conflicted files not preloaded:");
      for (const c of pm.unpreloaded_conflicts) lines.push(`  - ${c}`);
    }
    addSection(lines.join("\n"), { required: true, key: "merge_in_progress" });
  }

  const atlasMeta = includeDynamic
    ? renderAtlasHandoffSectionsWithMeta(packet)
    : { text: "", charCount: 0, originalLength: 0, trimLevel: null, truncated: false };
  if (includeDynamic && atlasMeta.text) addSection(atlasMeta.text, { required: true, key: "atlas_context" });
  // Annotate the packet with render metadata so downstream telemetry and
  // debugging can see when the ATLAS block was trimmed to fit budget.
  if (includeDynamic && packet.atlas) {
    packet.atlas.renderedChars = atlasMeta.charCount;
    packet.atlas.renderedOriginalChars = atlasMeta.originalLength;
    packet.atlas.renderedTrimLevel = atlasMeta.trimLevel;
    packet.atlas.renderedTruncated = atlasMeta.truncated;
  }

  if (includeDynamic && packet.traversal_completion_check?.attach && packet.traversal_completion_check?.text) {
    addSection(packet.traversal_completion_check.text, { required: true, key: "traversal_completion_check" });
  }

  const atlasFallbackEntries = includeDynamic ? Object.entries(packet.atlas_fallback_context?.files || {}) : [];
  if (includeDynamic && atlasFallbackEntries.length > 0) {
    const parts = [];
    for (const [filePath, entry] of atlasFallbackEntries) {
      if (entry?.mode === "smart" && entry.smart) {
        const sp = entry.smart;
        const block = [`=== ${filePath} (${sp.totalLines} lines, ATLAS fallback smart preload) ===`];
        if (sp.imports && sp.imports.trim()) {
          block.push(`\nIMPORTS:\n${sp.imports}`);
        }
        for (const fn of sp.matched || []) {
          block.push(`\nRELEVANT FUNCTION: ${fn.name} [lines ${fn.startLine}-${fn.endLine}]\n${fn.content}`);
        }
        if ((sp.toc || []).length > 0) {
          block.push("\nOTHER FUNCTIONS (use normal Read/search tools to inspect):");
          for (const fn of sp.toc) {
            block.push(`  ${fn.name} [lines ${fn.startLine}-${fn.endLine}] - ${String(fn.signature || "").slice(0, 100)}`);
          }
        }
        parts.push(block.join("\n"));
      } else if (entry?.content) {
        parts.push(`=== ${filePath} (ATLAS fallback preload) ===\n${entry.content}`);
      }
    }
    addSection(
      [
        "ATLAS FALLBACK SMART CONTEXT (ATLAS unavailable; use normal file/search/edit tools for anything missing):",
        parts.join("\n\n"),
      ].join("\n\n"),
      { required: true, key: "atlas_fallback_context" },
    );
  }

  // Directory tree (optional)
  if (includeDynamic && packet.directory_tree) {
    queueOptional(`=== DIRECTORY TREE ===\n${packet.directory_tree}`, { key: "directory_tree" });
  }

  // Bulk source preload (researcher/planner) (optional)
  if (includeDynamic) {
    for (const [filePath, content] of Object.entries(packet.source_files || {})) {
      queueOptional(`=== FILE: ${filePath} ===\n${content}`, { key: "source_files" });
    }
  }

  if (includeStable && (packet.project_context || (packet.run_insights && packet.run_insights.length > 0) || Object.keys(packet.related_files_content || {}).length > 0)) {
    addSection(
      "READ-ONLY CONTEXT BOUNDARY: project context, related files, and historical insights do not expand writable scope.",
      { required: true, key: "read_only_context_boundary" },
    );
  }

  if (includeStable && packet.dev_mode_contract && (packet.recipient === "dev" || packet.job_type === "fix")) {
    addSection(packet.dev_mode_contract, { required: true, key: "dev_mode_contract" });
  }

  if (includeStable && Array.isArray(packet.skill_sections) && packet.skill_sections.length > 0) {
    const skillBlocks = packet.skill_sections.map((skill) => [
      `=== SKILL: ${skill.id}${skill.name ? ` (${skill.name})` : ""} ===`,
      skill.body || "",
    ].join("\n").trim());
    addSection(
      [
        "SKILLS (planner-selected stable guidance):",
        skillBlocks.join("\n\n"),
      ].join("\n\n"),
      { required: true, key: "skills" },
    );
  }

  if (includeStable && (packet.recipient === "dev" || packet.job_type === "fix")) {
    addSection(renderPlannerDevBrief(packet.dev_brief), { required: true, key: "planner_dev_brief" });
    addSection(renderHashRefHandoffPacket(packet.hash_ref_packet || packet.dev_brief?.hash_ref_packet), {
      required: true,
      key: "hash_ref_packet",
    });
  }

  // Editable files (existing files to modify) (required)
  const editablePaths = Object.keys(packet.editable_files || {});
  const smartPaths = Object.keys(packet.smart_preloads || {});
  const allModifyPaths = [...new Set([...editablePaths, ...smartPaths])];
  const droppedPathSet = new Set(
    (packet.dropped_files || [])
      .map((entry) => String(entry).match(/^(.+?)\s+\(/)?.[1] || String(entry)),
  );
  const metadata = packet.editable_file_metadata || {};
  const describeUnpreloadedEditable = (p) => {
    const meta = metadata[p] || {};
    if (droppedPathSet.has(p)) return `=== ${p} === (contents not preloaded - see warning below)`;
    if (meta.exists === false) {
      if (meta.reason === "outside_project_scope") return `=== ${p} === (outside project scope - verify path)`;
      return `=== ${p} === (file not found - verify path)`;
    }
    if (meta.reason === "preload_capped") return `=== ${p} === (contents not preloaded - preload cap; use read_file before editing)`;
    if (meta.truncated) return `=== ${p} === (contents not preloaded - file too large; use read_file slices before editing)`;
    return `=== ${p} === (contents not preloaded - use read_file before editing)`;
  };
  const buildEditableFileParts = () => {
    const fileParts = [];

    for (const p of editablePaths) {
      if (packet.smart_preloads?.[p]) continue; // handled below
      const content = packet.editable_files[p];
      fileParts.push(
        content != null
          ? `=== ${p} ===\n${content || "(empty file)"}`
          : describeUnpreloadedEditable(p),
      );
    }

    for (const p of smartPaths) {
      const sp = packet.smart_preloads[p];
      const parts = [`=== ${p} (${sp.totalLines} lines) ===`];

      if (sp.imports && sp.imports.trim()) {
        parts.push(`\nIMPORTS:\n${sp.imports}`);
      }

      for (const fn of sp.matched) {
        parts.push(`\nFUNCTION: ${fn.name} [lines ${fn.startLine}-${fn.endLine}]\n${fn.content}`);
      }

      if (sp.toc.length > 0) {
        parts.push("\nOTHER FUNCTIONS (use Read tool with line range to view):");
        for (const fn of sp.toc) {
          parts.push(`  ${fn.name} [lines ${fn.startLine}-${fn.endLine}] - ${fn.signature.slice(0, 100)}`);
        }
      }

      fileParts.push(parts.join("\n"));
    }

    return fileParts;
  };

  if (allModifyPaths.length > 0) {
    const modifyLines = allModifyPaths.map((filePath) => {
      const meta = metadata[filePath] || {};
      const notes = [];
      if (Number.isFinite(Number(meta.size))) notes.push(`${Number(meta.size)} bytes`);
      if (Number.isFinite(Number(meta.lineCount))) notes.push(`${Number(meta.lineCount)} lines`);
      if (meta.contentPreloaded) notes.push(meta.preloadKind === "smart" ? "targeted snapshot preloaded" : "body preloaded");
      else if (meta.exists === false) notes.push(meta.reason === "outside_project_scope" ? "outside project scope" : "not found");
      else notes.push("body not preloaded; read before editing");
      return `- ${filePath}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
    });
    const modifyList = [
      "FILES YOU MUST MODIFY (existing files - edit only):",
      ...modifyLines,
    ].join("\n");
    addSection(modifyList, { required: true, key: "editable_files" });

    const preloadedParts = buildEditableFileParts().filter(Boolean);
    if (includeDynamic) {
      const atlasGateEnabled = packet.atlas?.gateEnabled != null ? !!packet.atlas.gateEnabled : resolveAtlasToolGateEnabled();
      const atlasLabel = atlasBackendLabel(packet.atlas);
      const atlasExactAccess = packet.atlas?.active && !packet.atlas?.prefetchFailed
        ? (atlasGateEnabled
          ? `Use ${atlasLabel} prefetch plus focused ${atlasLabel} code retrieval first for scoped source files; native read_file/search_files are fallback only when ${atlasLabel} cannot provide remaining exact content or you have mutated files and need current worktree state.`
          : `Use ${atlasLabel} code retrieval first for scoped source files when possible; use read_file/search_files when ${atlasLabel} cannot provide remaining exact content or you have mutated files and need current worktree state.`)
        : "Use read_file/search_files to inspect exact content before editing.";
      const accessNote = [
        "EDITABLE FILE CONTENT ACCESS:",
        packet.editable_file_preload_mode === "off"
          ? `Full editable file bodies are intentionally not preloaded. ${atlasExactAccess}`
          : `Only listed snapshots are preloaded. ${atlasExactAccess}`,
        "If deterministic reads cannot provide required context, return MISSING_CONTEXT/FILE_REQUEST with exact paths instead of guessing.",
      ].join("\n");
      addSection(accessNote, { required: true, key: "editable_file_access" });

      if (preloadedParts.length > 0) {
        const preloadBlock = `PRELOADED EDITABLE FILE CONTEXT:\n${preloadedParts.join("\n\n")}`;
        if (packet.pending_merge) {
          addSection(preloadBlock, { required: true, key: "editable_file_preload" });
        } else {
          queueOptional(preloadBlock, { key: "editable_file_preload" });
        }
      }
    }
  }

  // Creatable files (new files to create) (required)
  const creatablePaths = Object.keys(packet.creatable_files || {});
  if (creatablePaths.length > 0) {
    const creatableParts = creatablePaths.map((p) => {
      const info = packet.creatable_files[p];
      return info?.exists
        ? `=== ${p} === (already exists - will be overwritten)\n${info.content || "(empty)"}`
        : `=== ${p} === (new file - will be created)`;
    });
    if (includeStable && includeDynamic) {
      addSection(
        [
          `FILES YOU MUST CREATE (new files):\n${creatablePaths.map((f) => `- ${f}`).join("\n")}`,
          `${creatableParts.join("\n\n")}`,
        ].join("\n\n"),
        { required: true, key: "creatable_files" },
      );
    } else if (includeStable) {
      addSection(
        `FILES YOU MUST CREATE (new files):\n${creatablePaths.map((f) => `- ${f}`).join("\n")}`,
        { required: true, key: "creatable_files" },
      );
    } else if (includeDynamic) {
      addSection(
        `CREATE TARGET STATE:\n${creatableParts.join("\n\n")}`,
        { required: true, key: "creatable_files" },
      );
    }
  }

  if (includeStable && (packet.deleted_files_applied || []).length > 0) {
    addSection(
      `FILES ALREADY DELETED BY SYSTEM (do not recreate):\n${packet.deleted_files_applied.map((f) => `- ${f}`).join("\n")}`,
      { required: true, key: "deleted_files_applied" },
    );
  }
  if (includeStable && (packet.deleted_files_absent || []).length > 0) {
    addSection(
      `FILES REQUESTED FOR DELETION BUT ALREADY ABSENT:\n${packet.deleted_files_absent.map((f) => `- ${f}`).join("\n")}`,
      { required: true, key: "deleted_files_absent" },
    );
  }
  if (includeStable && (packet.delete_failures || []).length > 0) {
    addSection(
      `DELETE FAILURES (system could not remove these paths):\n${packet.delete_failures.map((entry) => `- ${entry.path}: ${entry.reason}`).join("\n")}`,
      { required: true, key: "delete_failures" },
    );
  }

  // Create roots (required)
  const createRoots = packet.create_roots || [];
  if (includeStable && createRoots.length > 0) {
    addSection(
      `CREATION DIRECTORIES (you may create new files under these paths):\n${createRoots.map((d) => `- ${d}`).join("\n")}`,
      { required: true, key: "create_roots" },
    );
  }

  // Related files (optional)
  const relatedEntries = Object.entries(packet.related_files_content || {});
  if (includeDynamic && relatedEntries.length > 0) {
    for (const [p, c] of relatedEntries) {
      queueOptional(
        `RELATED FILE (read-only - do not modify, provided for reference):\n=== ${p} (read-only) ===\n${c}`,
        { key: "related_files_content" },
      );
    }
  }

  if (includeDynamic && packet.related_files_dropped && packet.related_files_dropped.length > 0) {
    queueOptional(
      `WARNING - RELATED FILES NOT PRELOADED:\n${packet.related_files_dropped.map((entry) => `- ${entry.path}: ${entry.reason}`).join("\n")}`,
      { key: "related_files_dropped" },
    );
  }

  // Dropped files warning (optional)
  if (includeDynamic && packet.dropped_files && packet.dropped_files.length > 0) {
    queueOptional(
      `WARNING - FILES TOO LARGE TO PRELOAD (you may need to use read_file for these):\n${packet.dropped_files.map((f) => `- ${f}`).join("\n")}`,
      { key: "dropped_files" },
    );
  }

  // ATLAS blocks self-trim internally first; then we trim optional sections by
  // deterministic priority. If required sections still exceed cap, record an
  // overflow marker for telemetry/diagnostics.
  optionalSections
    .slice()
    .sort((a, b) => (a.priority - b.priority) || (a.order - b.order))
    .forEach((entry) => addSection(entry.text, { key: entry.key }));

  if (trackMetrics) {
    packet.context_rendered_chars = currentChars;
    packet.context_render_cap = contextCap || null;
    packet.context_sections_dropped = [...new Set(droppedSections)];
    packet.context_required_overflow = requiredOverflow;
    packet.context_required_overflow_sections = [...new Set(requiredOverflowSections)];
    packet.context_overflow_stage = requiredOverflow
      ? "required_sections"
      : (packet.context_sections_dropped.length > 0 ? "optional_sections" : null);
    packet.context_trimmed = packet.context_sections_dropped.length > 0 || requiredOverflow;
  }

  return sections.join("\n\n");
}
