// @ts-check

export const WEB_RESEARCH_PROTOCOL = "posse.web_research.v1";

export const WEB_RESEARCH_LIMITS = Object.freeze({
  maxQuestionChars: 2_000,
  maxFindings: 12,
  maxSummaryChars: 2_000,
  maxClaimChars: 800,
  maxTitleChars: 300,
  maxPublishedAtChars: 80,
  maxGapChars: 500,
  maxGaps: 6,
  maxPacketBytes: 16 * 1024,
  timeoutMs: 60_000,
  maxActiveChildren: 8,
});
