// PHP runtime-owned symbols. Unknown/application symbols never imply a missing
// capability. Exact identities avoid treating an arbitrary prefix as runtime.
export const PHP_RUNTIME_SYMBOL_EXTENSIONS = Object.freeze({
  SODIUM_CRYPTO_SECRETBOX_KEYBYTES: "sodium",
  SODIUM_CRYPTO_SECRETBOX_NONCEBYTES: "sodium",
  sodium_crypto_secretbox: "sodium",
  sodium_crypto_secretbox_open: "sodium",
  OPENSSL_RAW_DATA: "openssl",
  openssl_encrypt: "openssl",
  openssl_decrypt: "openssl",
  curl_init: "curl",
  curl_exec: "curl",
  mb_strlen: "mbstring",
  mb_convert_encoding: "mbstring",
  imagecreatetruecolor: "gd",
  Normalizer: "intl",
  IntlDateFormatter: "intl",
  ZipArchive: "zip",
  SQLite3: "sqlite3",
});
