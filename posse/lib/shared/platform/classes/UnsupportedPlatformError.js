// @ts-check

/** Thrown when the host OS/arch has no mapped native-binary token. */
export class UnsupportedPlatformError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}
