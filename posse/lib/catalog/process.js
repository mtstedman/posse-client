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

// Repository-authored tests execute below the provider credential boundary.
// Keep only process/runtime location and presentation state; application and
// Posse configuration must be supplied by fixtures, never inherited secrets.
export const TEST_SUBPROCESS_ENV_KEYS = Object.freeze([
  "allusersprofile", "appdata", "ci", "comspec", "home", "homedrive",
  "homepath", "lang", "lc_all", "lc_ctype", "localappdata", "logname",
  "no_color", "node_env", "os", "path", "pathext", "programdata",
  "programfiles", "programfiles(x86)", "programw6432", "systemdrive",
  "systemroot", "temp", "term", "tmp", "tmpdir", "tz", "user",
  "userdomain", "username", "userprofile", "windir",
]);
