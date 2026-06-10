import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const composerPhp = path.join(here, "vendor", "davidrjenni", "scip-php", "src", "Composer", "Composer.php");
const indexerPhp = path.join(here, "vendor", "davidrjenni", "scip-php", "src", "Indexer.php");

if (!fs.existsSync(composerPhp)) process.exit(0);
let text = fs.readFileSync(composerPhp, "utf8").replace(/\r\n/g, "\n");

text = replaceOne(text, [
  "        $json = self::parseJson($projectRoot, 'composer.json');",
  [
    "        $composerJsonPath = self::join($projectRoot, 'composer.json');",
    "        $json = realpath($composerJsonPath) === false ? [] : self::parseJson($projectRoot, 'composer.json');",
  ].join("\n"),
], [
  "        $composerJsonPath = self::join($projectRoot, 'composer.json');",
  "        $json = realpath($composerJsonPath) === false ? [] : self::parseJson($projectRoot, 'composer.json');",
].join("\n"), "optional target composer.json block");

text = replaceOne(text, [
  [
    "        $scipPhpVendorDir = self::join(__DIR__, '..', '..', 'vendor');",
    "        if (realpath($scipPhpVendorDir) === false) {",
    "            throw new RuntimeException(\"Invalid scip-php vendor directory: {$scipPhpVendorDir}.\");",
    "        }",
    "        $this->scipPhpVendorDir = realpath($scipPhpVendorDir);",
  ].join("\n"),
  [
    "        $scipPhpVendorDir = self::join(__DIR__, '..', '..', 'vendor');",
    "        if (realpath($scipPhpVendorDir) === false) {",
    "            $scipPhpVendorDir = self::join(__DIR__, '..', '..', '..', '..');",
    "        }",
    "        if (realpath($scipPhpVendorDir) === false) {",
    "            throw new RuntimeException(\"Invalid scip-php vendor directory: {$scipPhpVendorDir}.\");",
    "        }",
    "        $this->scipPhpVendorDir = realpath($scipPhpVendorDir);",
  ].join("\n"),
], [
  "        $scipPhpVendorDir = self::join(__DIR__, '..', '..', 'vendor');",
  "        if (realpath($scipPhpVendorDir) === false) {",
  "            $scipPhpVendorDir = self::join(__DIR__, '..', '..', '..', '..');",
  "        }",
  "        if (realpath($scipPhpVendorDir) === false) {",
  "            throw new RuntimeException(\"Invalid scip-php vendor directory: {$scipPhpVendorDir}.\");",
  "        }",
  "        $this->scipPhpVendorDir = realpath($scipPhpVendorDir);",
].join("\n"), "scip-php vendor-dir block");

text = replaceOne(text, [
  [
    "        $this->projectFiles = array_merge(",
    "            $bin,",
    "            self::loadProjectFiles($projectRoot, $autoload),",
    "            self::loadProjectFiles($projectRoot, $autoloadDev),",
    "        );",
  ].join("\n"),
  [
    "        $projectFiles = array_merge(",
    "            $bin,",
    "            self::loadProjectFiles($projectRoot, $autoload),",
    "            self::loadProjectFiles($projectRoot, $autoloadDev),",
    "        );",
    "        if (count($projectFiles) === 0) {",
    "            $projectFiles = self::loadFallbackPhpFiles($projectRoot);",
    "        }",
    "        $this->projectFiles = array_values(array_unique($projectFiles));",
  ].join("\n"),
], [
  "        $projectFiles = array_merge(",
  "            $bin,",
  "            self::loadProjectFiles($projectRoot, $autoload),",
  "            self::loadProjectFiles($projectRoot, $autoloadDev),",
  "        );",
  "        if (count($projectFiles) === 0) {",
  "            $projectFiles = self::loadFallbackPhpFiles($projectRoot);",
  "        }",
  "        $this->projectFiles = array_values(array_unique($projectFiles));",
].join("\n"), "project file fallback block");

text = replaceOne(text, [
  [
    "        $vendorDir = 'vendor';",
    "        if (",
    "            is_array($json['config'] ?? null)",
    "            && is_string($json['config']['vendor-dir'] ?? null)",
    "            && trim($json['config']['vendor-dir'], '/') !== ''",
    "        ) {",
    "            $vendorDir = trim($json['config']['vendor-dir'], '/');",
    "        }",
    "        $this->vendorDir = self::join($projectRoot, $vendorDir);",
    "        $this->loader = require self::join($this->vendorDir, 'autoload.php');",
    "",
    "        $installed = require self::join($this->vendorDir, 'composer', 'installed.php');",
    "        $this->pkgName = $installed['root']['name'];",
    "        $this->pkgVersion = $installed['root']['reference'];",
  ].join("\n"),
  [
    "        $envVendorDir = getenv('POSSE_SCIP_TARGET_VENDOR_DIR');",
    "        if (is_string($envVendorDir) && trim($envVendorDir) !== '') {",
    "            $vendorDir = trim($envVendorDir);",
    "            $this->vendorDir = self::isAbsolutePath($vendorDir) ? $vendorDir : self::join($projectRoot, $vendorDir);",
    "        } else {",
    "            $vendorDir = 'vendor';",
    "            if (",
    "                is_array($json['config'] ?? null)",
    "                && is_string($json['config']['vendor-dir'] ?? null)",
    "                && trim($json['config']['vendor-dir'], '/') !== ''",
    "            ) {",
    "                $vendorDir = trim($json['config']['vendor-dir'], '/');",
    "            }",
    "            $this->vendorDir = self::join($projectRoot, $vendorDir);",
    "        }",
    "        $this->loader = require self::join($this->vendorDir, 'autoload.php');",
    "",
    "        $installedPath = self::join($this->vendorDir, 'composer', 'installed.php');",
    "        $installed = realpath($installedPath) === false ? null : require $installedPath;",
    "        $this->pkgName = is_array($installed) && is_array($installed['root'] ?? null) && is_string($installed['root']['name'] ?? null) && $installed['root']['name'] !== ''",
    "            ? $installed['root']['name']",
    "            : (is_string($json['name'] ?? null) && $json['name'] !== '' ? $json['name'] : 'project');",
    "        $this->pkgVersion = is_array($installed) && is_array($installed['root'] ?? null) && is_string($installed['root']['reference'] ?? null) && $installed['root']['reference'] !== ''",
    "            ? $installed['root']['reference']",
    "            : 'dev';",
  ].join("\n"),
], [
  "        $envVendorDir = getenv('POSSE_SCIP_TARGET_VENDOR_DIR');",
  "        if (is_string($envVendorDir) && trim($envVendorDir) !== '') {",
  "            $vendorDir = trim($envVendorDir);",
  "            $this->vendorDir = self::isAbsolutePath($vendorDir) ? $vendorDir : self::join($projectRoot, $vendorDir);",
  "        } else {",
  "            $vendorDir = 'vendor';",
  "            if (",
  "                is_array($json['config'] ?? null)",
  "                && is_string($json['config']['vendor-dir'] ?? null)",
  "                && trim($json['config']['vendor-dir'], '/') !== ''",
  "            ) {",
  "                $vendorDir = trim($json['config']['vendor-dir'], '/');",
  "            }",
  "            $this->vendorDir = self::join($projectRoot, $vendorDir);",
  "        }",
  "        $this->loader = require self::join($this->vendorDir, 'autoload.php');",
  "",
  "        $installedPath = self::join($this->vendorDir, 'composer', 'installed.php');",
  "        $installed = realpath($installedPath) === false ? null : require $installedPath;",
  "        $this->pkgName = is_array($installed) && is_array($installed['root'] ?? null) && is_string($installed['root']['name'] ?? null) && $installed['root']['name'] !== ''",
  "            ? $installed['root']['name']",
  "            : (is_string($json['name'] ?? null) && $json['name'] !== '' ? $json['name'] : 'project');",
  "        $this->pkgVersion = is_array($installed) && is_array($installed['root'] ?? null) && is_string($installed['root']['reference'] ?? null) && $installed['root']['reference'] !== ''",
  "            ? $installed['root']['reference']",
  "            : 'dev';",
].join("\n"), "target vendor-dir block");

text = replaceOne(text, [
  [
    "        $pkgsByPaths = [];",
    "        foreach ($installed['versions'] as $name => $info) {",
    "            // Replaced packages do not have an install path.",
    "            // See https://getcomposer.org/doc/04-schema.md#replace",
    "            if (!isset($info['install_path'])) {",
    "                continue;",
    "            }",
    "            $path = realpath($info['install_path']);",
    "            if ($path === false) {",
    "                throw new RuntimeException(\"Invalid install path of package {$name}: {$info['install_path']}.\");",
    "            }",
    "            if ($name !== $this->pkgName) {",
    "                $pkgsByPaths[$path] = ['name' => $name, 'version' => $info['reference']];",
    "            }",
    "        }",
  ].join("\n"),
  [
    "        $pkgsByPaths = [];",
    "        if (is_array($installed) && is_array($installed['versions'] ?? null)) {",
    "            foreach ($installed['versions'] as $name => $info) {",
    "                // Replaced packages do not have an install path.",
    "                // See https://getcomposer.org/doc/04-schema.md#replace",
    "                if (!isset($info['install_path'])) {",
    "                    continue;",
    "                }",
    "                $path = realpath($info['install_path']);",
    "                if ($path === false) {",
    "                    throw new RuntimeException(\"Invalid install path of package {$name}: {$info['install_path']}.\");",
    "                }",
    "                if ($name !== $this->pkgName) {",
    "                    $pkgsByPaths[$path] = ['name' => $name, 'version' => is_string($info['reference'] ?? null) ? $info['reference'] : 'dev'];",
    "                }",
    "            }",
    "        }",
  ].join("\n"),
], [
  "        $pkgsByPaths = [];",
  "        if (is_array($installed) && is_array($installed['versions'] ?? null)) {",
  "            foreach ($installed['versions'] as $name => $info) {",
  "                // Replaced packages do not have an install path.",
  "                // See https://getcomposer.org/doc/04-schema.md#replace",
  "                if (!isset($info['install_path'])) {",
  "                    continue;",
  "                }",
  "                $path = realpath($info['install_path']);",
  "                if ($path === false) {",
  "                    throw new RuntimeException(\"Invalid install path of package {$name}: {$info['install_path']}.\");",
  "                }",
  "                if ($name !== $this->pkgName) {",
  "                    $pkgsByPaths[$path] = ['name' => $name, 'version' => is_string($info['reference'] ?? null) ? $info['reference'] : 'dev'];",
  "                }",
  "            }",
  "        }",
].join("\n"), "installed packages block");

const helper = [
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
].join("\n");
if (!text.includes("private static function loadFallbackPhpFiles")) {
  const anchor = [
    "    private static function collectPaths(string $projectRoot, array $paths): array",
    "    {",
    "        $files = [];",
    "        foreach ($paths as $p) {",
    "            if (!is_string($p) || $p === '') {",
    "                continue;",
    "            }",
    "            $p = self::join($projectRoot, $p);",
    "            if (realpath($p) !== false) {",
    "                $files[] = realpath($p);",
    "            }",
    "        }",
    "        return $files;",
    "    }",
  ].join("\n");
  if (!text.includes(anchor)) {
    throw new Error("collectPaths block not found");
  }
  text = text.replace(anchor, `${anchor}\n\n${helper}`);
}

fs.writeFileSync(composerPhp, text);

if (fs.existsSync(indexerPhp)) {
  let indexerText = fs.readFileSync(indexerPhp, "utf8").replace(/\r\n/g, "\n");
  indexerText = replaceOne(indexerText, [
    "                'language'      => Language::PHP,",
    "                'language'      => 'php',",
  ], "                'language'      => 'php',", "document language assignment");
  indexerText = replaceOne(indexerText, [
    "                'relative_path' => str_replace($this->projectRoot . '/', '', $filename),",
    "                'relative_path' => $this->relativePath($filename),",
  ], "                'relative_path' => $this->relativePath($filename),", "relative path assignment");
  const relativeHelper = [
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
    "",
  ].join("\n");
  if (!indexerText.includes("private function relativePath")) {
    indexerText = indexerText.replace("\n}\n", `\n${relativeHelper}}\n`);
  }
  fs.writeFileSync(indexerPhp, indexerText);
}

function replaceOne(input, candidates, replacement, label) {
  for (const candidate of candidates) {
    if (input.includes(candidate)) return input.replace(candidate, replacement);
  }
  if (input.includes(replacement)) return input;
  throw new Error(`${label} not found`);
}
