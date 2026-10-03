// Composer post-install/post-update hook: patch the pinned davidrjenni/scip-php
// sources (composer.json pins an exact dev-main commit) so the indexer runs from
// Posse's managed scip/php package against arbitrary target repos.
//
// Every patch is anchored on the exact upstream text of the pinned commit and is
// idempotent: an already-applied patch is skipped, and a missing or ambiguous
// anchor throws so a scip-php bump that moves the code fails the install loudly
// instead of shipping an unpatched indexer. Re-port the anchors whenever the pin
// in composer.json changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "vendor", "davidrjenni", "scip-php");
const composerPhp = path.join(packageRoot, "src", "Composer", "Composer.php");
const indexerPhp = path.join(packageRoot, "src", "Indexer.php");
const parserPhp = path.join(packageRoot, "src", "Parser", "Parser.php");
const binPhp = path.join(packageRoot, "bin", "scip-php");

// Nothing to patch when scip-php is not installed (e.g. `composer install --no-dev`).
if (!fs.existsSync(packageRoot)) process.exit(0);

const lines = (...parts) => parts.join("\n");

// --- src/Composer/Composer.php ---------------------------------------------

const collectPathsMethod = lines(
  "    private function collectPaths(array $paths): array",
  "    {",
  "        $files = [];",
  "        foreach ($paths as $p) {",
  "            if (!is_string($p) || $p === '') {",
  "                continue;",
  "            }",
  "            $p = self::join($this->projectRoot, $p);",
  "            $p = realpath($p);",
  "            if ($p !== false) {",
  "                $files[] = $p;",
  "            }",
  "        }",
  "        return $files;",
  "    }",
);

const composerHelpers = lines(
  "    /** @param array<int, mixed> $patterns */",
  "    private static function buildExclusionRegex(string $projectRoot, array $patterns): ?string",
  "    {",
  "        $root = realpath($projectRoot);",
  "        if ($root === false) {",
  "            return null;",
  "        }",
  "        $regexes = [];",
  "        foreach ($patterns as $rawPattern) {",
  "            if (!is_string($rawPattern)) {",
  "                continue;",
  "            }",
  "            $pattern = trim(strtr($rawPattern, '\\\\', '/'), '/');",
  "            while (str_starts_with($pattern, './')) {",
  "                $pattern = substr($pattern, 2);",
  "            }",
  "            $base = $root;",
  "            while (str_starts_with($pattern, '../')) {",
  "                $base = dirname($base);",
  "                $pattern = substr($pattern, 3);",
  "            }",
  "            if ($pattern === '') {",
  "                continue;",
  "            }",
  "            $pattern = preg_replace('{/+}', '/', preg_quote($pattern, '~'));",
  "            if (!is_string($pattern)) {",
  "                continue;",
  "            }",
  "            $pattern = strtr($pattern, ['\\\\*\\\\*' => '.+?', '\\\\*' => '[^/]+?']);",
  "            $regexes[] = preg_quote(strtr($base, '\\\\', '/'), '~') . '/' . $pattern . '($|/)';",
  "        }",
  "        return count($regexes) > 0 ? '~(' . implode('|', $regexes) . ')~' : null;",
  "    }",
  "",
  "    /** @return array<int, non-empty-string> */",
  "    private static function loadFallbackPhpFiles(string $projectRoot): array",
  "    {",
  "        $root = realpath($projectRoot);",
  "        if ($root === false) {",
  "            return [];",
  "        }",
  "        $files = [];",
  "        $directory = new \\RecursiveDirectoryIterator($root, \\FilesystemIterator::SKIP_DOTS);",
  "        $filter = new \\RecursiveCallbackFilterIterator($directory, static function (\\SplFileInfo $current): bool {",
  "            if (!$current->isDir()) {",
  "                return true;",
  "            }",
  "            return !\\in_array($current->getFilename(), ['.git', '.posse', '.posse-worktrees', 'node_modules', 'vendor'], true);",
  "        });",
  "        $iterator = new \\RecursiveIteratorIterator($filter);",
  "        foreach ($iterator as $file) {",
  "            if (!$file instanceof \\SplFileInfo || !$file->isFile() || \\strtolower($file->getExtension()) !== 'php') {",
  "                continue;",
  "            }",
  "            $path = $file->getRealPath();",
  "            if ($path !== false) {",
  "                $files[] = $path;",
  "            }",
  "        }",
  "        \\sort($files);",
  "        return $files;",
  "    }",
  "",
  "    private static function isAbsolutePath(string $path): bool",
  "    {",
  "        return preg_match('/^(?:[A-Za-z]:[\\\\\\\\\\/]|[\\\\\\\\\\/])/', $path) === 1;",
  "    }",
);

patchFile(composerPhp, [
  {
    // A missing target composer.json (or composer.lock, which upstream now also
    // reads) means "no metadata", not a fatal error. The Posse wrapper normally
    // provides a composer.json, but batch views and fallback projects never ship
    // a composer.lock.
    label: "optional composer.json/composer.lock in parseJson",
    anchor: lines(
      "    private function parseJson(string $filename): array",
      "    {",
      "        $content = Reader::read(self::join($this->projectRoot, $filename));",
    ),
    replacement: lines(
      "    private function parseJson(string $filename): array",
      "    {",
      "        $jsonPath = self::join($this->projectRoot, $filename);",
      "        if (!is_file($jsonPath)) {",
      "            return [];",
      "        }",
      "        $content = Reader::read($jsonPath);",
    ),
  },
  {
    // Posse installs scip-php as a Composer dependency, so its runtime vendor
    // dir is the one that contains the package. Upstream falls back to
    // <cwd>/vendor, which is the analysed repo's vendor dir (missing, or the
    // wrong runtime/stubs) when the wrapper runs inside the target repo.
    label: "scip-php runtime vendor-dir block",
    anchor: lines(
      "        $scipPhpVendorDir = self::join(__DIR__, '..', '..', 'vendor');",
      "        if (realpath($scipPhpVendorDir) === false) {",
      "            // If the vendor directory relative to this file is not found, scip-php probably runs as a",
    ),
    replacement: lines(
      "        $scipPhpVendorDir = self::join(__DIR__, '..', '..', 'vendor');",
      "        if (realpath($scipPhpVendorDir) === false && is_file(self::join(__DIR__, '..', '..', '..', '..', 'autoload.php'))) {",
      "            // Posse: scip-php is installed as a Composer dependency; use the vendor dir that contains it.",
      "            $scipPhpVendorDir = self::join(__DIR__, '..', '..', '..', '..');",
      "        }",
      "        if (realpath($scipPhpVendorDir) === false) {",
      "            // If the vendor directory relative to this file is not found, scip-php probably runs as a",
    ),
  },
  {
    // Index every PHP file when the autoload config yields none (classmap
    // batches of class-less files, repos without autoload rules), and never
    // emit the same file twice when bin/files/classmap entries overlap.
    label: "project file fallback block",
    anchor: lines(
      "        $this->projectFiles = array_merge(",
      "            $bin,",
      "            $this->loadProjectFiles($autoload),",
      "            $this->loadProjectFiles($autoloadDev),",
      "        );",
    ),
    replacement: lines(
      "        $projectFiles = array_merge(",
      "            $bin,",
      "            $this->loadProjectFiles($autoload),",
      "            $this->loadProjectFiles($autoloadDev),",
      "        );",
      "        if (count($projectFiles) === 0) {",
      "            $projectFiles = self::loadFallbackPhpFiles($projectRoot);",
      "        }",
      "        $this->projectFiles = array_values(array_unique($projectFiles));",
    ),
  },
  {
    // Target vendor dir override (POSSE_SCIP_TARGET_VENDOR_DIR is the wrapper's
    // staged autoload-only vendor, keeping the repo's own dependencies out of
    // the indexer process) and an optional installed.php: `composer
    // dump-autoload` does not write one, and upstream throws without it.
    label: "target vendor-dir and installed.php block",
    anchor: lines(
      "        $vendorDir = 'vendor';",
      "        if (",
      "            is_array($json['config'] ?? null)",
      "            && is_string($json['config']['vendor-dir'] ?? null)",
      "        ) {",
      "            $dir = trim($json['config']['vendor-dir'], '/');",
      "            if ($dir !== '') {",
      "                $vendorDir = $dir;",
      "            }",
      "        }",
      "        $this->vendorDir = self::join($projectRoot, $vendorDir);",
    ),
    replacement: lines(
      "        $envVendorDir = getenv('POSSE_SCIP_TARGET_VENDOR_DIR');",
      "        if (is_string($envVendorDir) && trim($envVendorDir) !== '') {",
      "            $vendorDir = trim($envVendorDir);",
      "            $this->vendorDir = self::isAbsolutePath($vendorDir) ? $vendorDir : self::join($projectRoot, $vendorDir);",
      "        } else {",
      "            $vendorDir = 'vendor';",
      "            if (",
      "                is_array($json['config'] ?? null)",
      "                && is_string($json['config']['vendor-dir'] ?? null)",
      "            ) {",
      "                $dir = trim($json['config']['vendor-dir'], '/');",
      "                if ($dir !== '') {",
      "                    $vendorDir = $dir;",
      "                }",
      "            }",
      "            $this->vendorDir = self::join($projectRoot, $vendorDir);",
      "        }",
    ),
  },
  {
    label: "installed.php root package block",
    anchor: lines(
      "        $installed = require self::join($this->vendorDir, 'composer', 'installed.php');",
      "",
      "        if (!is_array($installed) || !is_array($installed['root'])) {",
      "            throw new RuntimeException(\"Cannot get root element from installed.php.\");",
      "        }",
      "",
      "        $pkgName = $installed['root']['name'];",
      "        if (!is_string($pkgName) || $pkgName === '') {",
      "            throw new RuntimeException(\"Cannot get package name.\");",
      "        }",
      "        $this->pkgName = $pkgName;",
      "",
      "        $pkgVersion = $installed['root']['reference'] ?? $installed['root']['version'];",
      "        if (!is_string($pkgVersion) || $pkgVersion === '') {",
      "            throw new RuntimeException(\"Cannot get package version.\");",
      "        }",
      "        $this->pkgVersion = $pkgVersion;",
    ),
    replacement: lines(
      "        $installedPath = self::join($this->vendorDir, 'composer', 'installed.php');",
      "        $installed = is_file($installedPath) ? require $installedPath : null;",
      "        $installedRoot = is_array($installed) && is_array($installed['root'] ?? null) ? $installed['root'] : [];",
      "",
      "        $pkgName = $installedRoot['name'] ?? null;",
      "        if (!is_string($pkgName) || $pkgName === '') {",
      "            $pkgName = is_string($json['name'] ?? null) && $json['name'] !== '' ? $json['name'] : 'project';",
      "        }",
      "        $this->pkgName = $pkgName;",
      "",
      "        $pkgVersion = $installedRoot['reference'] ?? $installedRoot['version'] ?? null;",
      "        if (!is_string($pkgVersion) || $pkgVersion === '') {",
      "            $pkgVersion = 'dev';",
      "        }",
      "        $this->pkgVersion = $pkgVersion;",
    ),
  },
  {
    // Tolerate a missing installed.php, and keep packages without a source
    // reference (path repositories, dist-only installs) attributed to their
    // package: upstream drops them, and pkg() then throws "Cannot find package
    // for identifier" for any symbol they define, aborting the whole index.
    label: "installed packages block",
    anchor: lines(
      "        if (is_array($installed['versions'])) {",
      "            foreach ($installed['versions'] as $name => $info) {",
    ),
    replacement: lines(
      "        if (is_array($installed) && is_array($installed['versions'] ?? null)) {",
      "            foreach ($installed['versions'] as $name => $info) {",
    ),
  },
  {
    label: "installed package version fallback",
    anchor: lines(
      "                if ($name !== $this->pkgName && is_string($info['reference']) && $info['reference'] !== '') {",
      "                    $pkgsByPaths[$path] = ['name' => $name, 'version' => $info['reference']];",
      "                }",
    ),
    replacement: lines(
      "                if ($name !== $this->pkgName) {",
      "                    $pkgsByPaths[$path] = ['name' => $name, 'version' => is_string($info['reference'] ?? null) && $info['reference'] !== '' ? $info['reference'] : 'dev'];",
      "                }",
    ),
  },
  {
    // Upstream reads autoload.files of every composer.lock package from the
    // target vendor dir. The wrapper's staged autoload-only vendor holds none of
    // them, and PhpFileParser::findClasses throws on a missing file.
    label: "composer.lock autoload files block",
    anchor: lines(
      "                    $f = self::join($this->vendorDir, $pkg['name'], $f);",
      "                    $classes = PhpFileParser::findClasses($f);",
    ),
    replacement: lines(
      "                    $f = self::join($this->vendorDir, $pkg['name'], $f);",
      "                    if (!is_file($f)) {",
      "                        continue;",
      "                    }",
      "                    $classes = PhpFileParser::findClasses($f);",
    ),
  },
  {
    // Composer's exclude-from-classmap entries are path globs (`**/Tests/`),
    // not regexes; upstream joins them raw into a regex, which fails to compile
    // or matches the wrong files.
    label: "exclude-from-classmap regex block",
    anchor: lines(
      "        $generator = new ClassMapGenerator();",
      "        $exclusionRegex = null;",
      "        if (is_array($autoload['exclude-from-classmap'] ?? null) && count($autoload['exclude-from-classmap']) > 0) {",
      "            $exclusions = [];",
      "            foreach ($autoload['exclude-from-classmap'] as $e) {",
      "                if (is_string($e) && $e !== '') {",
      "                    $exclusions[] = $e;",
      "                }",
      "            }",
      "            $exclusionRegex = '{(' . implode('|', $exclusions) . ')}';",
      "        }",
    ),
    replacement: lines(
      "        $generator = new ClassMapGenerator();",
      "        $exclusionRegex = is_array($autoload['exclude-from-classmap'] ?? null)",
      "            ? self::buildExclusionRegex($this->projectRoot, $autoload['exclude-from-classmap'])",
      "            : null;",
    ),
  },
  {
    label: "Composer helper methods",
    anchor: collectPathsMethod,
    replacement: `${collectPathsMethod}\n\n${composerHelpers}`,
  },
]);

// --- src/Indexer.php --------------------------------------------------------

const indexReturn = lines(
  "        return new Index([",
  "            'documents'        => $documents,",
  "            'metadata'         => $this->metadata,",
  "            'external_symbols' => $extSymbols,",
  "        ]);",
  "    }",
  "}",
);

patchFile(indexerPhp, [
  {
    // Document.language is a string; upstream assigns the Language enum's
    // integer value, which serializes as "19".
    label: "document language assignment",
    anchor: "                'language'          => Language::PHP,",
    replacement: "                'language'          => 'php',",
  },
  {
    // Strip the project root as a prefix only, and normalize Windows separators.
    label: "relative path assignment",
    anchor: "                'relative_path'     => str_replace($this->projectRoot . '/', '', $filename),",
    replacement: "                'relative_path'     => $this->relativePath($filename),",
  },
  {
    label: "relativePath helper",
    anchor: indexReturn,
    replacement: lines(
      indexReturn.slice(0, -2),
      "",
      "    private function relativePath(string $filename): string",
      "    {",
      "        $root = str_replace('\\\\', '/', rtrim($this->projectRoot, '\\\\/'));",
      "        $file = str_replace('\\\\', '/', $filename);",
      "        $prefix = $root . '/';",
      "        if (str_starts_with($file, $prefix)) {",
      "            return substr($file, strlen($prefix));",
      "        }",
      "        return $file;",
      "    }",
      "}",
    ),
  },
]);

// --- src/Parser/Parser.php --------------------------------------------------

patchFile(parserPhp, [
  {
    // One file the parser rejects (syntax newer than the pinned php-parser,
    // genuinely broken code) must not abort the whole index.
    label: "unsupported PHP syntax block",
    anchor: "        $stmts = $this->parser->parse($code);",
    replacement: lines(
      "        try {",
      "            $stmts = $this->parser->parse($code);",
      "        } catch (\\PhpParser\\Error|\\TypeError $error) {",
      "            fwrite(\\STDERR, \"scip-php skipping unsupported syntax in {$filename}: {$error->getMessage()}\\n\");",
      "            return;",
      "        }",
    ),
  },
  {
    // Likewise for indexer/type-resolution failures on a single file (unknown
    // parent classes, non-UTF-8 identifiers rejected by protobuf, ...).
    label: "unsupported PHP semantics block",
    anchor: "        $t->traverse($stmts);",
    replacement: lines(
      "        try {",
      "            $t->traverse($stmts);",
      "        } catch (\\Throwable $error) {",
      "            fwrite(\\STDERR, \"scip-php skipping unsupported semantics in {$filename}: {$error->getMessage()}\\n\");",
      "            return;",
      "        }",
    ),
  },
]);

// --- bin/scip-php -----------------------------------------------------------

patchFile(binPhp, [
  {
    // Upstream still reports tool_info.version 0.0.1, the same as the v0.0.2
    // release Posse used before (and still uses on PHP < 8.3). ATLAS keys
    // ingested SCIP indexes on that version, so an unchanged file indexed by
    // this build would be skipped as already ingested. Name the pinned commit.
    label: "tool_info version",
    anchor: "$version = '0.0.1';",
    replacement: `$version = '0.0.1+posse.${installedReference("davidrjenni/scip-php").slice(0, 12)}';`,
  },
]);

function installedReference(name) {
  const installedJson = path.join(here, "vendor", "composer", "installed.json");
  const installed = JSON.parse(fs.readFileSync(installedJson, "utf8"));
  const packages = Array.isArray(installed) ? installed : installed?.packages;
  const entry = (Array.isArray(packages) ? packages : []).find((pkg) => pkg?.name === name);
  const reference = String(entry?.source?.reference || entry?.dist?.reference || "");
  if (!/^[0-9a-f]{12,}$/u.test(reference)) {
    throw new Error(`scip-php patch: no installed source reference for ${name} in ${installedJson}`);
  }
  return reference;
}

function patchFile(file, patches) {
  if (!fs.existsSync(file)) {
    throw new Error(`scip-php patch target missing: ${path.relative(here, file)}`);
  }
  let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const { label, anchor, replacement } of patches) {
    text = replaceOne(text, anchor, replacement, `${path.basename(file)}: ${label}`);
  }
  fs.writeFileSync(file, text);
}

function replaceOne(input, anchor, replacement, label) {
  if (input.includes(replacement)) return input;
  const first = input.indexOf(anchor);
  if (first === -1) throw new Error(`scip-php patch anchor not found: ${label}`);
  if (input.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`scip-php patch anchor is ambiguous: ${label}`);
  }
  return input.slice(0, first) + replacement + input.slice(first + anchor.length);
}
