// @ts-check
// Bootstrap scripts keep checked literal projections of this policy, so they
// can install Node before any JavaScript is available on the host.
export const INSTALLATION_POLICY = Object.freeze({
  nodeMajor: 24,
  linuxGlibc: Object.freeze({ major: 2, minor: 34 }),
  windowsPhpMinimum: "8.2",
  windowsPhpExtensions: Object.freeze(["openssl", "sodium", "curl", "zip", "mbstring", "intl", "fileinfo", "gd", "exif", "mysqli", "pdo_mysql", "pdo_sqlite", "sqlite3", "pdo_pgsql", "pgsql", "bcmath"]),
  phpScipTracks: Object.freeze({
    modern: Object.freeze({ id: "modern", dir: "php", minPhp: "8.3.0", description: "current upstream scip-php" }),
    legacy: Object.freeze({ id: "legacy", dir: "php-legacy", minPhp: "8.1.0", description: "pinned scip-php v0.0.2" }),
  }),
});
