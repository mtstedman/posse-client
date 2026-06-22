export const SECRET_PATTERNS = [
  // AWS access keys
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  // OpenAI-style API keys, including project-scoped sk-proj-* tokens.
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "OpenAI API key" },
  // xAI API keys.
  { re: /\bxai-[A-Za-z0-9_-]{20,}\b/, label: "xAI API key" },
  // Posse remote keys. Keep the body alphanumeric to avoid redacting
  // ordinary setting names such as posse_native_heartbeat_timeout_seconds.
  { re: /\bposse[_-][A-Za-z0-9]{20,}\b/, label: "Posse API key" },
  // Generic API keys/tokens assigned as string literals to common variable names.
  // Requiring a quoted literal avoids false positives like:
  //   $apiKey = resolveApiKeyFromEnvironment();
  { re: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[=:]\s*["'][A-Za-z0-9._~:/+=-]{20,}["']?/i, label: "API key/token assignment" },
  // Unquoted .env-style secret assignments are still suspicious when the
  // variable name itself is env-like and starts the line.
  { re: /^\s*[A-Z0-9_]*(?:API_KEY|API_SECRET|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)\s*=\s*["']?[A-Za-z0-9._~:/+=-]{20,}["']?\s*$/i, label: "Secret env variable" },
  // Private key blocks
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: "Private key" },
  // Connection strings with embedded passwords
  { re: /(?:mysql|postgres|mongodb|redis|amqp):\/\/[^:]+:[^@]+@/i, label: "Connection string with password" },
  // .env-style secret assignments
  { re: /^(?:DATABASE_URL|DB_PASSWORD|SECRET_KEY|JWT_SECRET|ENCRYPTION_KEY|PRIVATE_KEY)\s*=/im, label: "Secret env variable" },
  // Stripe live keys
  { re: /sk_live_[0-9a-zA-Z]{24,}/, label: "Stripe live key" },
  // GitHub tokens
  { re: /gh[pousr]_[A-Za-z0-9_]{36,}/, label: "GitHub token" },
  // Slack tokens
  { re: /xox[bpoas]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/, label: "Slack token" },
  // Generic high-entropy password/secret assignments as string literals.
  { re: /(?:password|passwd|secret)\s*[=:]\s*["'][A-Za-z0-9._~:/+=-]{32,}["']?/i, label: "High-entropy secret" },
];
