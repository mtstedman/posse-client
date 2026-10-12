// @ts-check



export function formatNativeDownloadMiB(bytes) {
  const value = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

export function summarizeNativeArtifactResults(results) {
  const unavailable = results.filter((result) => result?.ok !== true);
  const downloaded = results.filter((result) => result?.downloaded).length;
  return {
    unavailable,
    downloaded,
    detail: unavailable.length > 0
      ? `${results.length - unavailable.length}/${results.length} ready; unavailable: ${unavailable.map((result) => result.name).join(", ")}`
      : `${results.length} ready${downloaded > 0 ? `; ${downloaded} downloaded` : ""}`,
  };
}
