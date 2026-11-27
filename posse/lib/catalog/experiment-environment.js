// Deterministic repository environment discovery; these choices never require a model.
export const EXPERIMENT_ENVIRONMENT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  auto: { type: 'boolean' }, profile: { enum: ['node', 'python'] },
  roots: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 4, maxLength: 235, pattern: '^work(?:/|$)' } },
  system_packages: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
} };
export const EXPERIMENT_ENVIRONMENT_EXCLUDED_PARTS = ['node_modules', 'vendor', '.git', '.posse', 'fixtures', '__fixtures__', 'testdata'];
export const EXPERIMENT_ENVIRONMENT_PHP_EXTENSIONS = {
  'ext-mbstring': 'php-mbstring', 'ext-curl': 'php-curl', 'ext-dom': 'php-xml', 'ext-simplexml': 'php-xml',
  'ext-xml': 'php-xml', 'ext-xmlreader': 'php-xml', 'ext-xmlwriter': 'php-xml', 'ext-xsl': 'php-xml',
  'ext-pdo_sqlite': 'php-sqlite3', 'ext-sqlite3': 'php-sqlite3', 'ext-zip': 'php-zip', 'ext-gd': 'php-gd',
  'ext-intl': 'php-intl', 'ext-bcmath': 'php-bcmath', 'ext-soap': 'php-soap',
};
