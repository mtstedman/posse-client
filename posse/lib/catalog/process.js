// Canonical process-launch policy shared by dependency installers.

export const UNBOUNDED_COMMAND_TIMEOUT_VALUES = Object.freeze([
  "", "0", "false", "none", "off", "unbounded", "unlimited", "infinite",
]);

export const COMMON_DEPENDENCY_INSTALL_ENV_KEYS = Object.freeze([
  "all_proxy",
  "appdata",
  "comspec",
  "curl_ca_bundle",
  "home",
  "homedrive",
  "homepath",
  "http_proxy",
  "https_proxy",
  "lang",
  "lc_all",
  "lc_ctype",
  "localappdata",
  "no_proxy",
  "npm_config_cafile",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "npm_config_proxy",
  "path",
  "pathext",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "requests_ca_bundle",
  "shell",
  "ssl_cert_dir",
  "ssl_cert_file",
  "systemroot",
  "temp",
  "term",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
  "cargo_home",
  "goprivate",
  "gonoproxy",
  "gonosumdb",
  "goproxy",
  "gosumdb",
  "rustup_home",
]);

export const DEPENDENCY_SYNC_INSTALL_ENV_KEYS = Object.freeze([
  ...COMMON_DEPENDENCY_INSTALL_ENV_KEYS,
  "node_extra_ca_certs",
  "npm_config_registry",
  "npm_config_strict_ssl",
]);

export const SCIP_DEPENDENCY_INSTALL_ENV_KEYS = COMMON_DEPENDENCY_INSTALL_ENV_KEYS;
export const DEPENDENCY_INSTALL_ENV_PREFIXES = Object.freeze(["pip_"]);
