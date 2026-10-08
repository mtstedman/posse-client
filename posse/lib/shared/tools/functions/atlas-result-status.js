// Read only the result envelope and its batch header. Source blocks can contain
// arbitrary JSON (including error-shaped examples) and are never diagnostics.
export function atlasResultFailures(result) {
  const errors = Object.create(null);
  const add = code => { errors[String(code || "unknown")] = (errors[String(code || "unknown")] || 0) + 1; };
  const visit = item => {
    if (Array.isArray(item?.items)) {
      for (const child of item.items) visit(child);
    } else if (item?.isError === true || item?.is_error === true || item?.ok === false) {
      add(item.errorCode || item.error_code || item.error?.code);
    }
  };
  let header;
  try { header = JSON.parse(String(result?.content?.[0]?.text || "").split("\n\n", 1)[0]); }
  catch { /* Plain text is not a batch header. */ }
  if (header?.action === "symbol.get" && Array.isArray(header.items)) visit(header);
  else if (result?.isError === true || result?.is_error === true) {
    add(result?._meta?.atlasError?.code || result?.structuredContent?.error?.code);
  }
  return { count: Object.values(errors).reduce((sum, value) => sum + value, 0), byCode: { ...errors } };
}

export async function observeAtlasExecution(context, execute, recover) {
  let executed;
  try { executed = await execute(); }
  catch (error) {
    if (context) {
      context.failedExecutions++;
      const code = String(error?.code || "unknown");
      context.executionErrors[code] = (context.executionErrors[code] || 0) + 1;
    }
    throw error;
  }
  const before = atlasResultFailures(executed?.result);
  if (context && before.count > 0) {
    context.failedExecutions++;
    for (const [code, count] of Object.entries(before.byCode)) {
      context.executionErrors[code] = (context.executionErrors[code] || 0) + count;
    }
  }
  const response = await recover(executed);
  if (context && before.count > 0 && atlasResultFailures(response?.result).count === 0) {
    context.recoveredExecutions++;
  }
  return response;
}
