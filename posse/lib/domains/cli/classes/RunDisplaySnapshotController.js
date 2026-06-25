import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import {
  EMPTY_TOOL_SNAPSHOT,
  createAsyncSnapshotCache,
  runTuiSnapshotTask,
} from "../functions/run-session.js";

export class RunDisplaySnapshotController {
  constructor({
    getDisplay = () => null,
    projectDir,
    log = null,
    collectDirtyStateAsync = null,
    getToolInvocationCountsByJob = null,
    getRecentToolInvocations = null,
    listActiveFileLocks = null,
  } = {}) {
    this.getDisplay = getDisplay;
    this.projectDir = projectDir;
    this.log = log;
    this.collectDirtyStateAsync = collectDirtyStateAsync;
    this.getToolInvocationCountsByJob = getToolInvocationCountsByJob;
    this.getRecentToolInvocations = getRecentToolInvocations;
    this.listActiveFileLocks = listActiveFileLocks;
    this.caches = null;
    this.timers = new Set();
  }

  setup() {
    const display = this.getDisplay();
    if (!display || this.caches) return;
    const snapshotArgs = {
      projectDir: this.projectDir,
      dbPath: getRuntimeDbPath(this.projectDir),
    };
    const requestPaneRender = (...modes) => {
      if (modes.includes(this.getDisplay()?._rightMode)) {
        this.getDisplay()?.requestRender?.({ reason: "queue-snapshot" });
      }
    };
    const dirty = createAsyncSnapshotCache({
      initialValue: null,
      minIntervalMs: 2500,
      load: typeof this.collectDirtyStateAsync === "function" ? () => this.collectDirtyStateAsync() : null,
      onUpdate: (state) => this.getDisplay()?.acceptDirtyStateSnapshot?.(state),
      onError: (err) => {
        this.log?.debug?.("display", "Dirty-state snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    const pipeline = createAsyncSnapshotCache({
      initialValue: [],
      minIntervalMs: 750,
      load: () => runTuiSnapshotTask("pipeline", snapshotArgs),
      onUpdate: () => requestPaneRender("pipeline"),
      onError: (err) => {
        this.log?.debug?.("display", "Pipeline snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    const tools = createAsyncSnapshotCache({
      initialValue: this.buildLocalToolSnapshot(),
      minIntervalMs: 750,
      load: () => this.loadToolSnapshot(snapshotArgs),
      onUpdate: () => requestPaneRender("tools", "monitor"),
      onError: (err) => {
        this.log?.debug?.("display", "Tool snapshot refresh failed", { error: String(err?.message || err) });
      },
    });
    this.caches = { dirty, pipeline, tools };
    display.getDirtyState = () => dirty.get();
    display.getPipelineData = () => pipeline.get();
    display.getToolData = () => tools.get();
    void dirty.refresh({ force: true });
    void pipeline.refresh({ force: true });
    void tools.refresh({ force: true });
    this.trackTimer(setInterval(() => void dirty.refresh(), 5000));
    this.trackTimer(setInterval(() => {
      const currentDisplay = this.getDisplay();
      if (currentDisplay?._rightMode === "pipeline") void pipeline.refresh();
      if (currentDisplay?._rightMode === "tools" || currentDisplay?._rightMode === "monitor") void tools.refresh();
    }, 1000));
  }

  refreshForQueue() {
    if (!this.caches) return;
    const display = this.getDisplay();
    void this.caches.dirty.refresh();
    if (display?._rightMode === "pipeline") void this.caches.pipeline.refresh();
    if (display?._rightMode === "tools" || display?._rightMode === "monitor") void this.caches.tools.refresh();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.caches?.dirty?.stop?.();
    this.caches?.pipeline?.stop?.();
    this.caches?.tools?.stop?.();
    this.caches = null;
  }

  trackTimer(timer) {
    if (!timer) return timer;
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  buildLocalToolSnapshot() {
    const fallback = EMPTY_TOOL_SNAPSHOT;
    const snapshot = { jobs: [], recent: [], activeLocks: fallback.activeLocks };
    if (typeof this.getToolInvocationCountsByJob === "function") {
      try { snapshot.jobs = this.getToolInvocationCountsByJob({ limit: 20 }); }
      catch (err) { this.log?.debug?.("display", "Local tool job-count fallback failed", { error: String(err?.message || err) }); }
    }
    if (typeof this.getRecentToolInvocations === "function") {
      try { snapshot.recent = this.getRecentToolInvocations({ limit: 40, includeUnscoped: false, currentRunOnly: true }); }
      catch (err) { this.log?.debug?.("display", "Local recent-tool fallback failed", { error: String(err?.message || err) }); }
    }
    if (typeof this.listActiveFileLocks === "function") {
      try { snapshot.activeLocks = this.listActiveFileLocks(); }
      catch (err) { this.log?.debug?.("display", "Local active-lock fallback failed", { error: String(err?.message || err) }); }
    }
    return snapshot;
  }

  async loadToolSnapshot(snapshotArgs) {
    try {
      const snapshot = await runTuiSnapshotTask("tools", snapshotArgs);
      if (snapshot?.activeLocks) return snapshot;
      const local = this.buildLocalToolSnapshot();
      return { ...local, ...(snapshot || {}), activeLocks: local.activeLocks };
    } catch (err) {
      this.log?.debug?.("display", "Tool snapshot worker failed; using local fallback", { error: String(err?.message || err) });
      return this.buildLocalToolSnapshot();
    }
  }
}
