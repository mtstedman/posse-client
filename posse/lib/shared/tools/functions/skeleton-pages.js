import { CODE_CONTENT_KINDS, SKELETON_PAGE_POLICY } from "../../../catalog/source-display.js";

// Partition decoded outline text, never serialized JSON. Prefer complete
// lines; an individually oversized line is explicitly marked as a fragment.
// Page coordinates are UTF-16 content offsets, not original source lines.
export function skeletonPages(envelope, maxChars) {
  const nested = envelope?.data && typeof envelope.data === "object";
  const data = nested ? envelope.data : envelope;
  if (!data || typeof data.content !== "string" || envelope.ok === false) return null;
  const source = data.content;
  const pages = [];
  const render = (start, end, page) => {
    const payload = {
      ...data,
      content: source.slice(start, end),
      contentKind: data.contentKind || CODE_CONTENT_KINDS.UNKNOWN,
      citable: false,
      pagination: {
        kind: SKELETON_PAGE_POLICY.kind,
        page,
        // Reserve enough digits before the final page count is known.
        pages: SKELETON_PAGE_POLICY.maxPages,
        offset: start,
        endOffset: end,
        totalContentChars: source.length,
        fragmentedLine: (start > 0 && source[start - 1] !== "\n")
          || (end < source.length && source[end - 1] !== "\n"),
      },
    };
    return nested ? { ...envelope, data: payload } : payload;
  };
  let start = 0;
  while (start < source.length) {
    if (pages.length >= SKELETON_PAGE_POLICY.maxPages) return null;
    let low = start;
    let high = source.length;
    while (low < high) {
      const end = Math.ceil((low + high) / 2);
      if (JSON.stringify(render(start, end, pages.length + 1)).length <= maxChars) low = end;
      else high = end - 1;
    }
    let end = low;
    // Do not break a Unicode code point or a CRLF pair at a fragment boundary.
    if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1] || "")) end--;
    if (end < source.length && source[end - 1] === "\r" && source[end] === "\n") end--;
    const newline = source.lastIndexOf("\n", end - 1);
    if (end < source.length && newline >= start) end = newline + 1;
    if (end <= start) return null;
    pages.push(render(start, end, pages.length + 1));
    start = end;
  }
  for (const page of pages) (nested ? page.data : page).pagination.pages = pages.length;
  return pages.length ? pages : null;
}

export function retainSkeletonPages(envelope, { maxChars, storePage }) {
  const pages = skeletonPages(envelope, maxChars - SKELETON_PAGE_POLICY.reserveChars);
  if (!pages) throw new Error("Skeleton metadata or content exceeds the page retention limit");
  let next = null;
  for (let index = pages.length - 1; index >= 0; index--) {
    const page = pages[index];
    const data = page.data || page;
    if (next) data.traversal_ref = next;
    const text = JSON.stringify(page);
    if (text.length > maxChars) throw new Error("Skeleton page exceeds the response limit");
    if (index === 0) return text;
    next = storePage(text, index + 1, pages.length);
    if (!next?.ref) throw new Error("Skeleton continuation could not be retained");
  }
}
