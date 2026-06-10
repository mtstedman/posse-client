// lib/format/prompt-literals.js
//
// Helpers for embedding user-controlled text in prompts without letting new
// lines or pseudo-section headings become instructions from the system.

export function promptLiteral(label, value) {
  return `${label} (literal JSON string):\n${JSON.stringify(String(value ?? ""))}`;
}
