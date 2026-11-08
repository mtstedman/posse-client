// The public blocker remains free text. Verification claims are checked by
// the harness, just as a normal completion is; product inputs/credentials
// without a verification claim retain the ordinary immediate blocker path.
export function isVerificationBlocker(blocker) {
  return /\b(?:type[ -]?check(?:s|ing)?|tsc|compil(?:e|er|ation)|lint|eslint|tests?|jest|vitest|pytest|phpunit|verification)\b/i.test(blocker);
}
