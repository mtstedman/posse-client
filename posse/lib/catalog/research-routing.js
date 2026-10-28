// @ts-check



export const WEB_VENDOR_HINTS = {
  anthropic: ["docs.anthropic.com", "anthropic.com"],
  aws: ["docs.aws.amazon.com", "aws.amazon.com"],
  azure: ["learn.microsoft.com", "azure.microsoft.com"],
  cloudflare: ["developers.cloudflare.com", "cloudflare.com"],
  datadog: ["docs.datadoghq.com", "datadoghq.com"],
  google: ["cloud.google.com", "developers.google.com"],
  grok: ["docs.x.ai", "x.ai"],
  openai: ["platform.openai.com", "openai.com"],
  opentelemetry: ["opentelemetry.io"],
  prometheus: ["prometheus.io"],
  redis: ["redis.io"],
  sendgrid: ["docs.sendgrid.com", "sendgrid.com"],
  shopify: ["shopify.dev", "shopify.com"],
  stripe: ["docs.stripe.com", "stripe.com"],
  taxjar: ["developers.taxjar.com", "taxjar.com"],
};

export const FILE_EXTENSIONS = [
  "cjs",
  "css",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "ts",
  "tsx",
  "toml",
  "yaml",
  "yml",
];

export const FILE_MENTION_RE = new RegExp(
  `(?:^|[\\s\`"'(\\[])((?:\\.{1,2}[\\\\/])?(?:[A-Za-z0-9_.-]+[\\\\/])*[A-Za-z0-9_.-]+\\.(?:${FILE_EXTENSIONS.join("|")}))(?=$|\\.(?=\\s|$)|[^A-Za-z0-9_.-])`,
  "gi",
);

export const RESEARCH_DIRECT_PATH_MAX_SOURCE_BYTES = 128 * 1024;
