export const FORCE_REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 10 : 3,
  retryDelay: process.platform === "win32" ? 150 : 50,
});
