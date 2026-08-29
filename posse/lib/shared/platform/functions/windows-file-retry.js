const WINDOWS_RETRYABLE_FILE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isRetryableWindowsFileError(error, platform = process.platform) {
  return platform === "win32" && WINDOWS_RETRYABLE_FILE_CODES.has(error?.code);
}

export async function retryWindowsFileOperation(operation, {
  attempts = 5,
  baseDelayMs = 40,
  platform = process.platform,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableWindowsFileError(error, platform) || attempt >= attempts) throw error;
      await new Promise((resolve) => { setTimeout(resolve, baseDelayMs * attempt); });
    }
  }
}

export async function renameWithWindowsRetry(from, to, {
  rename,
  ...options
} = {}) {
  if (typeof rename !== "function") throw new TypeError("renameWithWindowsRetry requires a rename function");
  return await retryWindowsFileOperation(() => rename(from, to), options);
}

export async function unlinkWithWindowsRetry(filePath, {
  unlink,
  ...options
} = {}) {
  if (typeof unlink !== "function") throw new TypeError("unlinkWithWindowsRetry requires an unlink function");
  return await retryWindowsFileOperation(() => unlink(filePath), options);
}
