import { demand } from "./policy.js";

// RFC-style quoted records, including embedded newlines and doubled quotes.
export function parseCSV(text, check = () => {}) {
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], field = "", quoted = false, afterQuote = false;
  const pushField = () => { row.push(field); field = ""; afterQuote = false; };
  const pushRow = () => { pushField(); rows.push(row); row = []; demand(rows.length <= 10001, "CSV row limit exceeded"); };
  for (let index = 0; index < text.length; index++) {
    if (index % 4096 === 0) check();
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === ',') pushField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; pushRow(); }
    else if (char === '"') { demand(!field && !afterQuote, "Malformed CSV quote"); quoted = true; }
    else { demand(!afterQuote, "Unexpected text after quoted CSV field"); field += char; }
  }
  demand(!quoted, "Unterminated CSV quote");
  if (field || row.length || afterQuote) pushRow();
  demand(rows.length > 0 && rows[0].every(Boolean) && new Set(rows[0]).size === rows[0].length, "CSV requires unique non-empty headers");
  const headers = rows.shift();
  return rows.map(values => { demand(values.length === headers.length, "CSV column count mismatch"); return Object.fromEntries(headers.map((header, index) => [header, values[index]])); });
}
