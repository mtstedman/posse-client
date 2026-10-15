import { C } from "../../../../shared/format/functions/colors.js";
import { statusIcon as paletteStatusIcon } from "../../functions/display/status-palette.js";
import { fit, stripAnsi, visiblePad, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { brandRule, posseWordmark, roleBrandColor, roleBrandIcon } from "../../functions/display/helpers/brand.js";
import { jobLabel, jobDisplayStatus } from "../../functions/display/helpers/job-status.js";
import { renderPosseMascotFrame } from "../../functions/display/helpers/mascot.js";
import { _buildQueueProviderUsageLines, getProviderUsageSummaryCache } from "../../functions/display/helpers/provider-usage.js";
import { sessionSyncLabel, sessionPairingDashboardLines, unpairedPipelineLines } from "../../functions/display/session-presentation.js";
import { monitorToolMeta, stripRedundantToolSummaryLabel } from "../../functions/display/tool-observation-presentation.js";

const POSSE_HEADER_WIDTH = 25;
const POSSE_HEADER_MASCOT_GAP = 2;

// The brand mark: the original \u259f (U+259F) reverse-L / "_|" corner, aligned to the
// POSSE *letters*, not the cell grid. Box-drawing strokes are centered in their
// cell, so POSSE's cap sits at the middle of row 0 and its baseline at the middle
// of row 2 \u2014 the ink spans only mid-row-0 \u2192 mid-row-2 (two cells, centered). A
// solid \u2588 filling whole cells runs taller than that, so the upright is inset: a
// lower-half block (\u2584) starts it on the cap line, and the foot's bottom lands on
// the baseline. The foot is a uniform two-cell bar (one cell narrower than the
// banner letters) \u2014 block glyphs can't shave a partial width off a half-height
// bar without stepping the bottom edge to two widths, so it stays on whole cells \u2014
// nudged a quarter-cell taller toward the post (\u2582). One-column post (mark stays
// 3 wide). Where "MASONS" used to be, left of POSSE.
const POSSE_LOGO_ROWS = Object.freeze([
  "  \u2584",
  " \u2582\u2588",
  " \u2580\u2580",
]);
// "POSSE" in 3-row heavy box-drawing block letters (each glyph 3 cols wide, a
// 1-col gap between them). Restored from the original masthead \u2014 the only
// change is dropping the leading "MASONS" word in favour of the boxy mark.
const POSSE_BANNER_ROWS = Object.freeze([
  "\u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2578",
  "\u2523\u2501\u251b \u2503 \u2503 \u2517\u2501\u2513 \u2517\u2501\u2513 \u2523\u2501\u2578",
  "\u2579   \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u2578",
]);
// Truecolor (24-bit) brand colours for the masthead so the mark and the word stay
// visibly distinct even on terminal themes that flatten the 16 named ANSI colours
// toward white. Mark = green, POSSE = cyan.
const MASTHEAD_LOGO_FG = "\x1b[38;2;106;214;128m";
const MASTHEAD_WORD_FG = "\x1b[38;2;96;200;236m";
const RUN_VIEW_TABS = Object.freeze([
  Object.freeze({ mode: "log", key: "L", label: "Activity" }),
  Object.freeze({ mode: "monitor", key: "M", label: "Agents" }),
  Object.freeze({ mode: "pipeline", key: "P", label: "Pipeline" }),
  Object.freeze({ mode: "tools", key: "T", label: "Tools" }),
]);

// The full 3-row masthead: the boxy brand mark (green) beside the POSSE banner
// (cyan) — two distinct colours so the mark reads as a logo, not a letter.
function posseMastheadRows() {
  return POSSE_LOGO_ROWS.map((logo, i) =>
    ` ${C.bold}${MASTHEAD_LOGO_FG}${logo}${C.reset}  ${MASTHEAD_WORD_FG}${POSSE_BANNER_ROWS[i]}${C.reset}`);
}



export class DisplayRightPanelRenderer {


  _buildRightModeTabs(width) {
    const tabs = RUN_VIEW_TABS.map((tab) => {
      const available = tab.mode === "pipeline"
        ? typeof this.getPipelineData === "function"
        : tab.mode === "tools"
          ? typeof this.getToolData === "function"
          : true;
      const body = `${tab.key} ${tab.label}`.padEnd(10);
      if (tab.mode === this._rightMode) return `${C.cyan}${C.bold}▌${body}▐${C.reset}`;
      return available
        ? `${C.dim} ${body} ${C.reset}`
        : `${C.dim} ${body.slice(0, -1)}· ${C.reset}`;
    });
    return fit(` ${tabs.join(" ")}`, Math.max(1, width));
  }


  _buildRunAccountingWidget(width, maxLines = 9) {
    const limit = Math.max(0, maxLines | 0);
    if (limit === 0) return [];
    const lines = [fit(brandRule({ label: "run accounting", color: C.green, width }), Math.max(1, width))];
    if (limit === 1) return lines;

    if (this._providerUsageRefreshError) {
      lines.push(` ${C.yellow}! Current-run accounting unavailable${C.reset}`);
      if (limit > 2) {
        lines.push(`   ${C.dim}${fit(_sanitizeDisplayLine(this._providerUsageRefreshError), Math.max(8, width - 4))}${C.reset}`);
      }
      return lines.slice(0, limit);
    }

    try {
      const cache = getProviderUsageSummaryCache();
      const activeProviders = new Set(
        [...this.workers.values()]
          .map((worker) => String(worker?.provider || "").trim().toLowerCase())
          .filter(Boolean),
      );
      const usage = _buildQueueProviderUsageLines(width, limit - 1, cache.summaries || [], {
        activeProviders,
        currentRunProviderUsage: cache.currentRunProviderUsage || [],
        runStartedAtIso: this._runStartedAtIso,
      });
      if (usage.length > 0) return [...lines, ...usage].slice(0, limit);
    } catch { /* keep the dashboard usable while accounting storage is unavailable */ }

    lines.push(` ${C.dim}· No provider usage reported for this run yet${C.reset}`);
    return lines.slice(0, limit);
  }


  _buildPeerWorkLane(width, maxRows = 4) {
    if (!this.getPipelineData || maxRows < 2) return [];
    let data;
    try { data = this.getPipelineData(); } catch { data = []; }
    const session = (Array.isArray(data) ? data : []).find((row) => row?.session_summary);
    const peerRows = (Array.isArray(data) ? data : []).filter((wi) => wi?.peer_read_only);
    if (!session && peerRows.length === 0) return [];

    const lines = [
      session
        ? ` ${C.magenta}${C.bold}\u2197 Session pairing${C.reset} ${C.dim}\u00b7 ${session.role} \u00b7 ${session.phase} \u00b7 ${sessionSyncLabel(session)} \u00b7 ${session.peer_count} peer${session.peer_count === 1 ? "" : "s"}${session.pending_count ? ` \u00b7 ${session.pending_count} pending` : ""}${C.reset}`
        : ` ${C.magenta}${C.bold}\u2197 Paired work${C.reset} ${C.dim}\u00b7 ${peerRows.length} WI \u00b7 read-only${C.reset}`,
    ];
    const detailCapacity = Math.max(1, maxRows - 1);
    const showOverflow = peerRows.length > detailCapacity && maxRows >= 3;
    const visible = peerRows.slice(0, showOverflow ? detailCapacity - 1 : detailCapacity);
    for (const wi of visible) {
      const job = (Array.isArray(wi.jobs) ? wi.jobs : [])[0];
      const jobSummary = job
        ? ` \u2014 ${job.job_type}/${job.status}: ${job.title}`
        : "";
      const summary = `${wi.peer_label} WI#${wi.peer_work_item_id} ${wi.status}: ${wi.title}${jobSummary}`;
      lines.push(` ${C.magenta}\u2502${C.reset} ${fit(_sanitizeDisplayLine(summary), Math.max(8, width - 4))}`);
    }
    if (showOverflow) {
      lines.push(` ${C.magenta}\u2502${C.reset} ${C.dim}+${peerRows.length - visible.length} more paired work item(s) [p] details${C.reset}`);
    }
    if (session && peerRows.length === 0) {
      if (session.role === "host" && session.pending_count > 0) {
        lines.push(` ${C.yellow}\u2502 ${session.pending_count} join request${session.pending_count === 1 ? "" : "s"} waiting \u00b7 [u] session to admit${C.reset}`);
      } else if (session.peer_count > 0) {
        lines.push(` ${C.green}\u2502 Team connected${C.reset}${C.dim} \u00b7 no peer work active right now${C.reset}`);
      } else {
        lines.push(` ${C.magenta}\u2502${C.reset} ${C.dim}Waiting for teammates \u00b7 [u] session controls${C.reset}`);
      }
    }
    return lines;
  }


  _withPosseMascot(headerLines, width) {
    const laneWidth = Math.max(0, width - POSSE_HEADER_WIDTH - POSSE_HEADER_MASCOT_GAP);
    const mascot = renderPosseMascotFrame({
      tick: this._spinIdx,
      laneWidth,
      colors: C,
    });
    if (!mascot) return headerLines;

    const gap = " ".repeat(POSSE_HEADER_MASCOT_GAP);
    return headerLines.map((line, idx) => `${visiblePad(line, POSSE_HEADER_WIDTH)}${gap}${mascot[idx] || ""}`);
  }



  // ── Right Panel: Header + Event Log ───────────────────────────────────

  _buildRight(width, maxLines) {
    const lines = [];

    // ── Masthead: boxy brand mark + POSSE banner ──
    // Wide panes get the full 3-row banner (with the mascot trotting alongside
    // once there's lane room); _withPosseMascot no-ops the mascot when narrow,
    // so the banner still shows on its own down to ~28 cols.
    if (width >= 28) {
      lines.push(...this._withPosseMascot(posseMastheadRows(), width));
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 44))}${C.reset}`);
    } else if (width >= 20) {
      lines.push(` ${posseWordmark()}`);
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 16))}${C.reset}`);
    } else {
      lines.push(` ${posseWordmark()}`);
    }

    lines.push(this._buildRightModeTabs(width));

    if (this._rightMode === "pipeline" && this.getPipelineData) {
      return this._buildPipeline(lines, width, maxLines);
    }

    if (this._rightMode === "tools" && this.getToolData) {
      return this._buildTools(lines, width, maxLines);
    }

    // Peer work lives outside this clone's queue, so it cannot appear in the
    // normal worker cards or event stream. Keep a compact live lane visible in
    // the default view; [p] still opens the complete read-only pipeline.
    lines.push(...this._buildPeerWorkLane(
      width,
      Math.min(4, Math.max(0, maxLines - lines.length - 2)),
    ));

    // ── Event log fills the rest, minus the pinned system and accounting tails ──
    // Run accounting is an operational widget, not masthead status. Reserve its
    // lower-right home before sizing either scrolling lane so it cannot vanish
    // as activity grows.
    const remainingRows = Math.max(0, maxLines - lines.length);
    const accountingBudget = remainingRows >= 2
      ? Math.min(9, Math.max(2, Math.floor(remainingRows * 0.38)))
      : 0;
    const accountingLines = this._buildRunAccountingWidget(width, accountingBudget);
    const contentEnd = Math.max(lines.length, maxLines - accountingLines.length);

    // Reserve the bottom rows for git / ATLAS chatter so it can never scroll
    // the job/work log off-screen. The tail is hidden when there's no recent
    // system activity, and capped so it can't crowd the log on a short pane.
    const sysCount = Math.min(
      this._systemEvents.length,
      this._systemLaneRows,
      Math.max(0, contentEnd - lines.length - 2),
    );
    const sysBlock = sysCount > 0 ? sysCount + 1 : 0; // +1 for the rule

    const available = Math.max(0, contentEnd - lines.length - sysBlock);
    const start = Math.max(0, this.events.length - available);
    const visible = this.events.slice(start);

    for (const ev of visible) {
      const { glyph, color } = this._classifyEvent(ev.text);
      lines.push(` ${C.dim}${ev.time}${C.reset} ${color}${glyph}${C.reset} ${ev.text}`);
    }

    if (sysBlock > 0) {
      // Pin the tail to the bottom of the pane.
      while (lines.length < contentEnd - sysBlock) lines.push("");
      const tail = "╌".repeat(Math.max(3, Math.min(width - 12, 40)));
      lines.push(` ${C.dim}╌╌╌ system ${tail}${C.reset}`);
      for (const ev of this._systemEvents.slice(-sysCount)) {
        lines.push(` ${C.dim}${ev.time}${C.reset} ${ev.text}`);
      }
    }

    while (lines.length < contentEnd) lines.push("");
    lines.push(...accountingLines);

    return lines.slice(0, maxLines);
  }



  // Cheap classifier: stripped-text keyword sniffing to choose a leading glyph
  // and tint. The event log stores opaque pre-styled strings, so we infer
  // from visible content rather than threading a type all the way through.
  _classifyEvent(text) {
    const lower = stripAnsi(String(text || "")).toLowerCase();
    if (/\[(?:assessor|audit)\]\s*pass\b/.test(lower)) {
      return { glyph: "✓", color: C.green };
    }
    if (/\[(?:assessor|audit)\]\s*fail\b/.test(lower)) {
      return { glyph: "✗", color: C.red };
    }
    if (/\b(failed|rejected|killed|aborted|✗|✖)\b/.test(lower) || /\berror\s*[:=-]/.test(lower)) {
      return { glyph: "✗", color: C.red };
    }
    if (/\b(succeeded|completed|merged|approved|pass|passed|✓|✔)\b/.test(lower)) {
      return { glyph: "✓", color: C.green };
    }
    if (/\b(recovered|retry|retrying|reassigned|↻)\b/.test(lower)) {
      return { glyph: "↻", color: C.yellow };
    }
    if (/\b(needs input|question|waiting on|paused|stalled|\?|⚠)\b/.test(lower)) {
      return { glyph: "?", color: C.yellow };
    }
    if (/\b(started|spawned|queued|leased|begin|booting)\b/.test(lower)) {
      return { glyph: "→", color: C.blue };
    }
    return { glyph: "·", color: C.dim };
  }



  // ── Pipeline View ──────────────────────────────────────────────────────

  _buildPipeline(headerLines, width, maxLines) {
    const lines = [...headerLines];
    lines.push(` ${C.bold}${C.cyan}\u2502 Pipeline${C.reset}  ${C.dim}[p] back to log  [\u2191\u2193] scroll${C.reset}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 50))}${C.reset}`);

    let data;
    try { data = this.getPipelineData(); } catch { data = []; }
    if (!data || data.length === 0) {
      lines.push(...unpairedPipelineLines(width));
      return lines;
    }

    const contentLines = [];
    const VERDICT_ICON = { pass: `${C.green}\u2713`, fail: `${C.red}\u2717`, blocked: `${C.yellow}\u25a0`, needs_review: `${C.yellow}?`, needs_replan: `${C.magenta}\u21bb`, not_assessed: `${C.dim}\u00b7` };

    const session = data.find((row) => row?.session_summary);
    if (session) {
      const peerRows = data.filter((row) => row?.peer_read_only);
      contentLines.push(...sessionPairingDashboardLines(session, peerRows, width));
      if (session.trunk_health?.provenance_gate_job_id) {
        contentLines.push(` ${C.yellow}Provenance review: gate #${session.trunk_health.provenance_gate_job_id}${C.reset}`);
      }
      contentLines.push("");
    }

    for (const wi of data.filter((row) => !row?.session_summary)) {
      const wiIdentity = wi.peer_read_only
        ? `${C.magenta}[remote · read-only]${C.reset} ${_sanitizeDisplayLine(wi.peer_label)} ${C.bold}${C.blue}WI#${wi.peer_work_item_id}${C.reset}`
        : `${C.bold}${C.blue}WI#${wi.id}${C.reset}`;
      contentLines.push(` ${wiIdentity} ${_sanitizeDisplayLine(wi.title).slice(0, width - 12)}`);

      if (!wi.jobs || wi.jobs.length === 0) {
        contentLines.push(`   ${C.dim}(no jobs)${C.reset}`);
        contentLines.push("");
        continue;
      }

      // Group jobs into pipeline stages and show handoff data
      for (const job of wi.jobs) {
        const icon = roleBrandIcon(job.job_type);
        const color = roleBrandColor(job.job_type);
        const displayStatus = jobDisplayStatus(job, wi.jobs);
        const statusIcon = displayStatus === "recovered"
          ? `${C.yellow}\u21bb`
          : paletteStatusIcon(displayStatus, { kind: "job", colors: C });

        // Verdict indicator for assessed jobs
        const verdict = job.assessor_verdict && job.assessor_verdict !== "not_assessed"
          ? ` ${VERDICT_ICON[job.assessor_verdict] || ""}${C.reset}`
          : "";

        // Brand-tinted, bolded role badge + role-colored leading accent bar
        contentLines.push(`  ${color}\u258e${C.reset} ${statusIcon}${C.reset} ${C.bold}${color}[${icon}]${C.reset} #${job.id} ${_sanitizeDisplayLine(jobLabel(job.job_type, job.title)).slice(0, width - 22)}${verdict}`);

        // Show handoff data based on role
        if (job.handoff) {
          for (const h of job.handoff) {
            contentLines.push(`     ${C.dim}\u2514\u2500 ${_sanitizeDisplayLine(h)}${C.reset}`);
          }
        }
      }
      contentLines.push("");
    }

    // Apply scroll. Clamp (and write back) so holding the down key past the
    // end can't scroll the content fully out of view into a blank panel.
    const available = maxLines - lines.length;
    const maxScroll = Math.max(0, contentLines.length - available);
    if (this._pipelineScroll > maxScroll) this._pipelineScroll = maxScroll;
    const scrolled = contentLines.slice(this._pipelineScroll, this._pipelineScroll + available);
    lines.push(...scrolled);

    return lines;
  }



  // ── Tools View ─────────────────────────────────────────────────────────

  _buildTools(headerLines, width, maxLines) {
    const lines = [...headerLines];
    lines.push(` ${C.bold}${C.cyan}\u2502 Agent tools${C.reset}  ${C.dim}[Tab/1-4] section  [\u2191\u2193] scroll${C.reset}`);
    const tabBar = [
      this._toolsTab === 0 ? `${C.cyan}${C.bold}\u258c1 Activity\u2590${C.reset}` : `${C.dim} 1 Activity ${C.reset}`,
      this._toolsTab === 1 ? `${C.cyan}${C.bold}\u258c2 Catalog \u2590${C.reset}` : `${C.dim} 2 Catalog  ${C.reset}`,
      this._toolsTab === 2 ? `${C.cyan}${C.bold}\u258c3 Roles   \u2590${C.reset}` : `${C.dim} 3 Roles    ${C.reset}`,
      this._toolsTab === 3 ? `${C.cyan}${C.bold}\u258c4 Locks   \u2590${C.reset}` : `${C.dim} 4 Locks    ${C.reset}`,
    ].join(" ");
    lines.push(` ${tabBar}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 50))}${C.reset}`);

    let data;
    try { data = this.getToolData(); } catch { data = null; }
    const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
    const recent = (data && Array.isArray(data.recent)) ? data.recent : [];
    const catalog = (data && Array.isArray(data.catalog)) ? data.catalog : [];
    const activeLockLines = this._buildActiveLockLines(width, data?.activeLocks);

    const toolLines = [];
    const catalogLines = [];
    const roleLines = [];
    const lockLines = [];

    if (recent.length > 0) {
      const collapsedRecent = [];
      for (const r of recent) {
        const key = [
          r.job_id ?? "",
          r.work_item_id ?? "",
          r.observation_type || "",
          r.summary || "",
        ].join("|");
        const last = collapsedRecent[collapsedRecent.length - 1];
        if (last?._collapseKey === key) {
          last._repeatCount += 1;
          continue;
        }
        collapsedRecent.push({ ...r, _collapseKey: key, _repeatCount: 1 });
      }
      const collapsedHint = collapsedRecent.length === recent.length
        ? ""
        : `, ${collapsedRecent.length} shown`;
      toolLines.push(` ${C.bold}Recent invocations${C.reset} ${C.dim}(latest ${recent.length}${collapsedHint})${C.reset}`);
      for (const r of collapsedRecent) {
        const when = String(r.created_at || "").slice(11, 19) || "--:--:--";
        const jobId = r.job_id != null ? `#${r.job_id}` : "#?";
        const tool = String(r.observation_type || "tool.?").replace(/^tool\./, "");
        const meta = monitorToolMeta(r);
        const summary = stripRedundantToolSummaryLabel(tool, r.summary);
        const prefix = ` ${C.dim}${when}${C.reset} ${meta.color}${meta.glyph}${C.reset} ${jobId.padStart(5)} ${C.cyan}${tool}${C.reset} `;
        const prefixLen = when.length + 3 + Math.max(jobId.length, 5) + 1 + tool.length + 2;
        const outcomeHint = meta.outcome === "failed" || meta.outcome === "rejected"
          ? ` ${meta.color}${meta.label}${C.reset}`
          : "";
        const outcomeLen = outcomeHint ? meta.label.length + 1 : 0;
        const budget = Math.max(10, width - prefixLen - outcomeLen - 2);
        const repeatHint = r._repeatCount > 1 ? ` ${C.dim}x${r._repeatCount}${C.reset}` : "";
        const repeatLen = r._repeatCount > 1 ? String(` x${r._repeatCount}`).length : 0;
        const summaryBudget = Math.max(10, budget - repeatLen);
        const summaryShort = summary.length > summaryBudget ? summary.slice(0, summaryBudget - 1) + "\u2026" : summary;
        toolLines.push(`${prefix}${summaryShort}${repeatHint}${outcomeHint}`);
        toolLines.push(...this._formatToolDetailRows(r, width));
      }
    } else {
      toolLines.push(` ${C.dim}\u25cb No tool invocations in this run yet${C.reset}`);
      toolLines.push("");
      toolLines.push(` ${C.dim}Registered tools remain visible in [2] CATALOG.${C.reset}`);
    }

    if (catalog.length > 0) {
      catalogLines.push(` ${C.bold}Registered catalog${C.reset} ${C.dim}\u00b7 ${catalog.length} agent-facing tools${C.reset}`);
      catalogLines.push(` ${C.dim}Each agent receives a role-, capability-, and scope-filtered subset.${C.reset}`);
      let previousGroup = null;
      for (const entry of catalog) {
        const group = entry.access === "atlas" ? "ATLAS" : "POSSE";
        if (group !== previousGroup) {
          if (previousGroup != null) catalogLines.push("");
          catalogLines.push(` ${group === "ATLAS" ? C.magenta : C.cyan}${C.bold}${group}${C.reset}`);
          previousGroup = group;
        }
        const namespace = group === "ATLAS" ? "atlas" : "tools";
        const name = `${namespace}.${String(entry.name || "unknown")}`;
        const roles = Array.isArray(entry.roles) && entry.roles.length > 0
          ? entry.roles.join(", ")
          : "conditional";
        catalogLines.push(fit(`  ${C.brightWhite}${name}${C.reset}  ${C.dim}${entry.access || "unknown"} \u00b7 ${roles}${C.reset}`, width));
        if (entry.summary) catalogLines.push(fit(`    ${C.dim}${_sanitizeDisplayLine(entry.summary)}${C.reset}`, width));
      }
    } else {
      catalogLines.push(` ${C.yellow}\u25cb Registered tool catalog unavailable${C.reset}`);
      catalogLines.push(` ${C.dim}Invocation activity can still appear in [1] ACTIVITY.${C.reset}`);
    }

    if (jobs.length > 0) {
      roleLines.push(` ${C.bold}By role${C.reset} ${C.dim}(from top ${jobs.length} jobs)${C.reset}`);
      const roleMap = new Map();
      for (const j of jobs) {
        const role = String(j.job_type || "?");
        if (!roleMap.has(role)) roleMap.set(role, { calls: 0, jobs: 0, toolTypes: new Set() });
        const entry = roleMap.get(role);
        entry.calls += Number(j.total || 0);
        entry.jobs += 1;
        for (const t of String(j.tool_types || "").split(",")) {
          const norm = String(t || "").trim().replace(/^tool\./, "");
          if (norm) entry.toolTypes.add(norm);
        }
      }
      const hdr = `  ${"Role".padEnd(12)} ${"Calls".padStart(7)} ${"Jobs".padStart(6)}  Tools`;
      roleLines.push(` ${C.dim}${hdr}${C.reset}`);
      const sorted = [...roleMap.entries()].sort((a, b) => b[1].calls - a[1].calls);
      for (const [role, agg] of sorted) {
        const color = roleBrandColor(role);
        const roleLabel = role.slice(0, 12).padEnd(12);
        const calls = String(agg.calls).padStart(7);
        const jobCount = String(agg.jobs).padStart(6);
        const types = [...agg.toolTypes].slice(0, 8).join(", ");
        roleLines.push(`  ${C.bold}${color}${roleLabel}${C.reset} ${calls} ${jobCount}  ${C.dim}${types}${C.reset}`);
      }

      roleLines.push("");
      roleLines.push(` ${C.bold}By job${C.reset} ${C.dim}(live detail)${C.reset}`);
      const byJobHdr = `  ${"Job".padStart(5)}  ${"WI".padStart(4)}  ${"Role".padEnd(9)}  ${"Calls".padStart(5)}  Tools`;
      roleLines.push(` ${C.dim}${byJobHdr}${C.reset}`);
      for (const j of jobs) {
        const color = roleBrandColor(j.job_type);
        const role = (j.job_type || "?").slice(0, 9).padEnd(9);
        const jobId = String(j.job_id ?? "?").padStart(5);
        const wi = String(j.work_item_id ?? "?").padStart(4);
        const calls = String(j.total || 0).padStart(5);
        const types = String(j.tool_types || "").split(",").map((t) => t.trim().replace(/^tool\./, "")).filter(Boolean).join(", ");
        const typesMax = Math.max(10, width - (5 + 2 + 4 + 2 + 9 + 2 + 5 + 2 + 3));
        const typesShort = types.length > typesMax ? types.slice(0, typesMax - 1) + "\u2026" : types;
        roleLines.push(`  ${jobId}  ${wi}  ${color}${role}${C.reset}  ${calls}  ${C.dim}${typesShort}${C.reset}`);
      }
    } else {
      roleLines.push(` ${C.dim}No role/tool aggregates available yet${C.reset}`);
    }

    if (activeLockLines.length > 0) {
      lockLines.push(...activeLockLines);
    } else {
      lockLines.push(` ${C.dim}No active file locks right now${C.reset}`);
    }

    const panes = [toolLines, catalogLines, roleLines, lockLines];
    const contentLines = panes[this._toolsTab] || toolLines;
    const available = Math.max(0, maxLines - lines.length);
    const maxScroll = Math.max(0, contentLines.length - available);
    const rawScroll = this._toolsTabScrolls[this._toolsTab] || 0;
    const scroll = Math.max(0, Math.min(rawScroll, maxScroll));
    this._toolsTabScrolls[this._toolsTab] = scroll;
    this._toolScroll = scroll;
    const scrolled = contentLines.slice(scroll, scroll + available);
    lines.push(...scrolled);

    return lines;
  }



  _buildActiveLockLines(width, activeLocks = null) {
    // Active locks only. Queued reservations ("what a job will lock later")
    // are filtered out by the _isDisplayActive* guards, and the queued-job
    // waiting forecast lives in the worker pane, not here.
    const heldJobs = Array.isArray(activeLocks?.jobs)
      ? activeLocks.jobs.filter((lock) => this._isDisplayActiveJobLock(lock))
      : [];
    const heldWorkItems = Array.isArray(activeLocks?.work_items)
      ? activeLocks.work_items.filter((lock) => this._isDisplayActiveWorkItemLock(lock))
      : [];

    // One group per work item. Job-tier and work-item-tier locks merge into a
    // single file list per WI; each file is attributed to the job that holds
    // it (the running job, or the source job behind a pending-review WI lock).
    // Identical holder+path pairs collapse so a file appears once.
    const byWi = new Map();
    const ensureGroup = (wiId, sample = {}) => {
      const key = wiId == null ? "?" : String(wiId);
      let group = byWi.get(key);
      if (!group) {
        group = { wiId: key, title: null, status: null, mergeState: null, files: new Map() };
        byWi.set(key, group);
      }
      if (!group.title && sample.work_item_title) group.title = sample.work_item_title;
      if (!group.status && sample.work_item_status) group.status = sample.work_item_status;
      if (!group.mergeState && sample.merge_state) group.mergeState = sample.merge_state;
      return group;
    };
    const addFile = (group, holderId, path) => {
      const cleanPath = path || "unknown";
      const holder = holderId != null ? `#${holderId}` : "WI";
      group.files.set(`${holder}${cleanPath}`, { holder, path: cleanPath });
    };

    for (const lock of heldJobs) addFile(ensureGroup(lock.work_item_id, lock), lock.job_id, lock.path);
    for (const lock of heldWorkItems) {
      addFile(ensureGroup(lock.work_item_id, lock), lock.source_job_id ?? lock.job_id ?? null, lock.path);
    }

    let fileCount = 0;
    for (const group of byWi.values()) fileCount += group.files.size;
    if (fileCount === 0) return [];

    const wiCount = byWi.size;
    const lines = [];
    lines.push(` ${C.bold}Active locks${C.reset} ${C.dim}· ${fileCount} file${fileCount === 1 ? "" : "s"} across ${wiCount} WI${wiCount === 1 ? "" : "s"}${C.reset}`);
    const ruleWidth = Math.min(Math.max(width - 4, 24), 58);
    lines.push(` ${C.dim}${"─".repeat(ruleWidth)}${C.reset}`);

    const sortedGroups = [...byWi.values()].sort((a, b) => this._compareMaybeNumber(a.wiId, b.wiId));

    const maxFileLines = 40;
    let shownFiles = 0;
    for (const group of sortedGroups) {
      if (shownFiles >= maxFileLines) break;

      // WI header: number, optional state, title. State explains why a WI with
      // no running job still holds locks (e.g. held pending review).
      const state = this._activeLockWiState(group);
      const wiLabel = `WI #${group.wiId}`;
      const stateChip = state ? ` ${state.color}${state.text}${C.reset}` : "";
      const headLen = wiLabel.length + (state ? state.text.length + 1 : 0);
      const titleBudget = Math.max(8, width - 2 - headLen - 3);
      let titleChip = "";
      if (group.title) {
        const raw = stripAnsi(String(group.title));
        const clipped = raw.length > titleBudget ? `${raw.slice(0, Math.max(0, titleBudget - 1))}…` : raw;
        titleChip = ` ${C.dim}· ${clipped}${C.reset}`;
      }
      lines.push("");
      lines.push(` ${C.blue}${C.bold}${wiLabel}${C.reset}${stateChip}${titleChip}`);

      const files = [...group.files.values()].sort((a, b) =>
        this._compareLockText(a.path, b.path) || this._compareLockText(a.holder, b.holder));
      const holderWidth = files.reduce((max, f) => Math.max(max, f.holder.length), 3);
      const pathBudget = Math.max(12, width - 3 - holderWidth - 2);
      for (const file of files) {
        if (shownFiles >= maxFileLines) break;
        const holderCell = file.holder.padEnd(holderWidth);
        const pathCell = this._lockTableCell(file.path, pathBudget);
        lines.push(`   ${C.cyan}${holderCell}${C.reset}  ${C.dim}${pathCell}${C.reset}`);
        shownFiles++;
      }
    }

    const remaining = fileCount - shownFiles;
    if (remaining > 0) {
      lines.push(`   ${C.dim}+${remaining} more locked file${remaining === 1 ? "" : "s"}${C.reset}`);
    }

    return lines;
  }



  // Short, meaningful WI state for the locks pane. Returns { text, color } or
  // null. Pending-review is highlighted because that's the common reason a WI
  // keeps holding file locks after its jobs finish.
  _activeLockWiState(group = {}) {
    const status = String(group.status || "").toLowerCase();
    const merge = String(group.mergeState || "").toLowerCase();
    if (merge === "pending_review" || (status === "complete" && merge && merge !== "merged")) {
      return { text: "pending review", color: C.yellow };
    }
    if (merge === "merge_failed") return { text: "merge failed", color: C.yellow };
    if (status) return { text: status, color: C.dim };
    return null;
  }



  _lockTableCell(value, width, align = "left") {
    const cellWidth = Math.max(1, Number(width || 1));
    const raw = stripAnsi(String(value ?? ""));
    const clipped = raw.length > cellWidth
      ? `${raw.slice(0, Math.max(0, cellWidth - 1))}\u2026`
      : raw;
    return align === "right" ? clipped.padStart(cellWidth) : clipped.padEnd(cellWidth);
  }



  _compareMaybeNumber(left, right) {
    const a = Number(left);
    const b = Number(right);
    const aFinite = Number.isFinite(a);
    const bFinite = Number.isFinite(b);
    if (aFinite && bFinite && a !== b) return a - b;
    if (aFinite !== bFinite) return aFinite ? -1 : 1;
    return this._compareLockText(left, right);
  }



  _compareLockText(left, right) {
    return String(left ?? "").localeCompare(String(right ?? ""));
  }



  _isDisplayActiveJobLock(lock = {}) {
    const status = String(lock.job_status || lock.status || "").toLowerCase();
    return status !== "queued" && status !== "pending";
  }



  _isDisplayActiveWorkItemLock(lock = {}) {
    const wiStatus = String(lock.work_item_status || "").toLowerCase();
    const mergeState = String(lock.merge_state || "").toLowerCase();
    if (wiStatus === "complete" && mergeState && mergeState !== "merged") return true;

    const sourceStatus = String(lock.source_job_status || lock.job_status || "").toLowerCase();
    if (!sourceStatus) return true;
    return sourceStatus !== "queued" && sourceStatus !== "pending";
  }
}
