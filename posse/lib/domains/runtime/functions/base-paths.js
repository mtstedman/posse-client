// @ts-check
// Bootstrap-safe facade: imports only the lightweight runtime path owner.
import { runtimePaths } from "../classes/RuntimePaths.js";

export function normalizeCwd(cwd = null) { return runtimePaths.normalizeCwd(cwd); }
export function normalizeProjectDir(projectDir = null, cwd = null) { return runtimePaths.normalizeProjectDir(projectDir, cwd); }
export function safeProcessCwd() { return runtimePaths.safeProcessCwd(); }
export function getRuntimeRoot(projectDir = null, cwd = null) { return runtimePaths.getRuntimeRoot(projectDir, cwd); }
export function getRuntimeDbPath(projectDir = null, cwd = null) { return runtimePaths.getRuntimeDbPath(projectDir, cwd); }
export function getRuntimeResourcesDir(projectDir = null, cwd = null) { return runtimePaths.getRuntimeResourcesDir(projectDir, cwd); }
export function getRuntimeLogDir(projectDir = null, cwd = null) { return runtimePaths.getRuntimeLogDir(projectDir, cwd); }
export function getRuntimeReportsDir(projectDir = null, cwd = null) { return runtimePaths.getRuntimeReportsDir(projectDir, cwd); }
export function setRuntimePathOverrides(overrides = null) { return runtimePaths.setRuntimePathOverrides(overrides); }
export function getRuntimePathOverridesForTests() { return runtimePaths.getRuntimePathOverridesForTests(); }
export const setRuntimePathOverridesForTests = setRuntimePathOverrides;
