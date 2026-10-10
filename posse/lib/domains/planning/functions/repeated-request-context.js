import { getDb } from "../../../shared/storage/functions/index.js";
import { promptLiteral } from "../../../shared/format/functions/prompt-literals.js";

// A repeated request is evidence about the user's experience, not proof of a
// particular missing implementation. Show prior delivery records as leads;
// never turn similar titles into an automatic no-change verdict.
export function buildRepeatedRequestContext(workItem) {
  const text = `${workItem?.title || ""}\n${workItem?.description || ""}`;
  if (!/\b(?:finally|still\s+(?:(?:isn['’]?t|is\s+not|doesn['’]?t|does\s+not|not)\s+)?(?:done|working|implemented|fixed)|(?:asking|asked|requesting|requested)\s+(?:this\s+)?again)\b/iu.test(text)) return "";
  const db = getDb();
  const recent = db.prepare(`
    SELECT id, title, completed_at FROM work_items
    WHERE id != ? AND merge_state = 'merged'
    ORDER BY completed_at DESC, id DESC LIMIT 5
  `).all(workItem.id).map((wi) => ({
    ...wi,
    completed_jobs: db.prepare(`
      SELECT j.title, a.commit_hash FROM jobs j
      LEFT JOIN job_attempts a ON a.id = (
        SELECT MAX(id) FROM job_attempts WHERE job_id = j.id AND commit_hash IS NOT NULL
      )
      WHERE j.work_item_id = ? AND j.status = 'succeeded'
        AND j.job_type IN ('dev', 'fix', 'promote', 'artificer')
      ORDER BY j.id LIMIT 8
    `).all(wi.id),
  }));
  return [
    "REPEATED REQUEST CONTEXT:",
    "The user reports that an earlier request remains unmet. Treat that as a reported gap to investigate.",
    "For overlapping prior work, compare what shipped with the requested user-visible behavior. A merged title or an existing backend route alone does not establish that the user's workflow works.",
    "Name the missing behavior and its acceptance check in the implementation contract. A no-change conclusion requires evidence covering the reported gap; if the expected behavior remains ambiguous, ask a focused clarification.",
    promptLiteral("RECENT MERGED DELIVERY RECORDS (relevance must be checked; titles are not proof of behavior)", JSON.stringify(recent)),
  ].join("\n");
}
