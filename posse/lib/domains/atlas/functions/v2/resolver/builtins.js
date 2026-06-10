// @ts-check
//
// Builtin identifiers that should NEVER bind to a repo symbol.
// Ported directly from atlas-mcp's edge-builder/builtins.ts so cross-tool
// behavior stays aligned during shadow burn-in.
//
// Sets are split by language family:
//   - BUILTIN_IDENTIFIERS / BUILTIN_MACROS / BUILTIN_CONSTRUCTORS —
//     context-free "never resolve" call targets ported from atlas-mcp.
//   - BUILTIN_GLOBAL_NAMESPACES — JS/TS globals like `Math`, `JSON`.
//   - NODE_BUILTIN_MODULE_NAMES — Node module names used as namespace.
//   - PYTHON_BUILTIN_NAMES — bare builtins (`print`, `len`, `range`…).
//   - PYTHON_STDLIB_MODULES — `os`, `sys`, `json`, used as dotted prefix.
//   - GO_BUILTIN_NAMES — `make`, `new`, `len`, `cap`, `append`, etc.
//   - GO_STDLIB_PACKAGES — `fmt`, `strings`, `os`, used as dotted prefix.
//   - JAVA_BUILTIN_NAMESPACES — JDK classes used as static receivers.
//   - JAVA_LANG_PACKAGES — Java package prefixes that should not bind.
//   - RUST_STDLIB_PREFIXES — `std`, `core`, `alloc` as path prefix.
//   - CSHARP_BUILTIN_NAMESPACES — BCL classes used as static receivers.
//   - CPP_STDLIB_NAMESPACES — `std`, `boost` as scope prefix.
//
// When atlas-mcp adds a new builtin we update this file. The data is
// stable enough that hand-syncing is fine; if we ever need
// auto-regeneration we can build a script that diffs the two sets.

// IMPORTANT: Only include context-free names that are structurally
// unambiguous. Short generic names like "run" or "find" should stay out
// because this denylist runs before the generic name resolver.
export const BUILTIN_IDENTIFIERS = new Set([
  // Array prototype
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "slice",
  "concat",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "findIndex",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "sort",
  "reverse",
  "flat",
  "flatMap",
  "fill",
  "copyWithin",
  "forEach",
  "entries",
  "keys",
  "values",
  "join",
  "at",
  // String prototype
  "split",
  "trim",
  "trimStart",
  "trimEnd",
  "replace",
  "replaceAll",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "match",
  "matchAll",
  "search",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "repeat",
  "substring",
  "localeCompare",
  // Object static
  "assign",
  "freeze",
  "defineProperty",
  "getOwnPropertyNames",
  "getPrototypeOf",
  "create",
  "fromEntries",
  // Math static
  "floor",
  "ceil",
  "round",
  "max",
  "min",
  "abs",
  "sqrt",
  "pow",
  "random",
  "log",
  // JSON
  "stringify",
  "parse",
  // Number/Date
  "toFixed",
  "toPrecision",
  "toISOString",
  "getTime",
  "toLocaleString",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "isInteger",
  // Promise
  "then",
  "catch",
  "finally",
  // Map/Set/WeakMap/WeakSet instance
  "has",
  "get",
  "set",
  "delete",
  "clear",
  "add",
  // Console
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  // RegExp
  "test",
  "exec",
  // Node.js fs/path/url/events
  "readFileSync",
  "writeFileSync",
  "existsSync",
  "mkdirSync",
  "readFile",
  "writeFile",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "rmSync",
  "unlinkSync",
  "copyFileSync",
  "renameSync",
  "chmodSync",
  "createReadStream",
  "createWriteStream",
  "dirname",
  "basename",
  "extname",
  "relative",
  "isAbsolute",
  "fileURLToPath",
  "pathToFileURL",
  "once",
  "emit",
  "removeListener",
  "removeAllListeners",
  // Node.js os/crypto/util
  "tmpdir",
  "cpus",
  "homedir",
  "platform",
  "arch",
  "release",
  "totalmem",
  "freemem",
  "createHash",
  "randomBytes",
  "randomUUID",
  "scryptSync",
  "pbkdf2Sync",
  "promisify",
  "deprecate",
  "callbackify",
  // process
  "exit",
  "cwd",
  "env",
  // Database
  "prepare",
  "transaction",
  // Zod schema builder methods
  "object",
  "string",
  "number",
  "boolean",
  "array",
  "enum",
  "optional",
  "nullable",
  "default",
  "describe",
  "int",
  "transform",
  "refine",
  "union",
  "intersection",
  "literal",
  "tuple",
  "record",
  "lazy",
  "coerce",
  "safeParse",
  "parseAsync",
  "passthrough",
  "strict",
  "extend",
  "merge",
  "pick",
  "omit",
  "partial",
  "required",
  "shape",
  "length",
  "email",
  "url",
  "uuid",
  "regex",
  // tree-sitter AST node methods
  "childForFieldName",
  "children",
  "namedChildren",
  "childCount",
  "namedChild",
  "child",
  "firstChild",
  "lastChild",
  "nextSibling",
  "previousSibling",
  "parent",
  "descendantsOfType",
  "walk",
  "startPosition",
  "endPosition",
  // Rust standard library (unambiguous names only)
  "to_string",
  "unwrap",
  "unwrap_or",
  "unwrap_or_else",
  "expect",
  "is_some",
  "is_none",
  "is_ok",
  "is_err",
  "as_ref",
  "as_mut",
  "as_str",
  "as_bytes",
  "collect",
  "iter",
  "into_iter",
  "len",
  "is_empty",
  "contains",
  "clone",
  "to_owned",
  "fmt",
  "display",
  "write_str",
  "write_fmt",
  "entry",
  "or_insert",
  "or_default",
  "and_then",
  "flat_map",
  "skip",
  "enumerate",
  "zip",
  "position",
  "sum",
  "sort_by",
  "sort_by_key",
  "dedup",
  "retain",
  "truncate",
  "drain",
  "append",
  "with_capacity",
  "capacity",
  "reserve",
  "shrink_to_fit",
  "as_slice",
  "to_vec",
  "to_string_lossy",
  "chars",
  "bytes",
  "lines",
  "starts_with",
  "ends_with",
  "contains_key",
  "get_or_insert",
  "read_to_string",
  "write_all",
  "sleep",
  "yield_now",
  // Testing frameworks
  "it",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  // Testing assertions/matchers
  "locator",
  "click",
  "fill",
  "press",
  "check",
  "uncheck",
  "selectOption",
  "waitFor",
  "waitForSelector",
  "waitForNavigation",
  "waitForTimeout",
  "toBeVisible",
  "toHaveText",
  "toContain",
  "toBe",
  "toEqual",
  "toThrow",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toHaveBeenCalled",
  "toHaveBeenCalledWith",
  "toHaveLength",
  "toBeTruthy",
  "toBeFalsy",
  "toBeNull",
  "toBeUndefined",
  "toBeDefined",
  "toBeGreaterThan",
  "toBeLessThan",
  "getByRole",
  "getByText",
  "getByTestId",
  "findByText",
  "queryByText",
  "getByLabelText",
  "getByPlaceholderText",
  // Global functions
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "atob",
  "btoa",
  "fetch",
  // Misc (unambiguous only)
  "toString",
  "valueOf",
  "toJSON",
  "iterator",
  "isArray",
  // Node.js path/fs/util builtins
  "normalize",
  "format",
  "inspect",
  "nextTick",
  "hrtime",
  "setImmediate",
  "debuglog",
  // DOM/browser builtins
  "addEventListener",
  "removeEventListener",
  "querySelector",
  "getElementById",
  "createElement",
]);

export const BUILTIN_MACROS = new Set([
  "assert!",
  "assert_eq!",
  "assert_ne!",
  "debug_assert!",
  "debug_assert_eq!",
  "debug_assert_ne!",
  "println!",
  "print!",
  "eprintln!",
  "eprint!",
  "format!",
  "write!",
  "writeln!",
  "vec!",
  "todo!",
  "unimplemented!",
  "unreachable!",
  "panic!",
  "cfg!",
  "env!",
  "include!",
  "include_str!",
  "include_bytes!",
  "log!",
  "info!",
  "warn!",
  "error!",
  "debug!",
  "trace!",
  "matches!",
  "dbg!",
  "concat!",
  "stringify!",
  "compile_error!",
  "file!",
  "line!",
  "column!",
  "module_path!",
  "option_env!",
  "cfg_if!",
]);

export const BUILTIN_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Date",
  "RegExp",
  "Promise",
  "Array",
  "Object",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "Int8Array",
  "Uint8Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Proxy",
  "Reflect",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "Buffer",
  "EventEmitter",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Vec",
  "HashMap",
  "HashSet",
  "BTreeMap",
  "BTreeSet",
  "Some",
  "None",
  "Ok",
  "Err",
  "Box",
  "Rc",
  "Arc",
  "Cell",
  "RefCell",
  "Mutex",
  "RwLock",
  "PathBuf",
  "OsString",
  "CString",
]);

/**
 * Global namespaces that exist in every JS/TS runtime. A call like
 * `Math.floor(x)` has prefix "Math" — bail out so the resolver
 * doesn't pretend `floor` is a repo symbol.
 */
export const BUILTIN_GLOBAL_NAMESPACES = new Set([
  "Date",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Promise",
  "Symbol",
  "Proxy",
  "Reflect",
  "console",
  "process",
  "globalThis",
  "window",
  "document",
  "Intl",
  "Atomics",
  "SharedArrayBuffer",
  "WeakRef",
  "FinalizationRegistry",
]);

/**
 * Node.js built-in module names. When a file imports `path` and then
 * calls `path.join(...)` we recognize "path" as the prefix and skip
 * resolution rather than mis-binding to a repo symbol that happens to
 * share the name.
 */
export const NODE_BUILTIN_MODULE_NAMES = new Set([
  "path",
  "fs",
  "os",
  "url",
  "util",
  "crypto",
  "http",
  "https",
  "net",
  "dns",
  "tls",
  "child_process",
  "cluster",
  "stream",
  "zlib",
  "buffer",
  "events",
  "querystring",
  "readline",
  "assert",
  "perf_hooks",
  "worker_threads",
  "v8",
  "vm",
  "inspector",
]);

/**
 * Bare Python builtin functions. `print(x)`, `len(x)`, `range(n)` should
 * never bind to a repo symbol even if one of those names was redefined
 * in a module — that's not what real-world Python code calls.
 */
export const PYTHON_BUILTIN_NAMES = new Set([
  "abs", "all", "any", "ascii", "bin", "bool", "breakpoint",
  "bytearray", "bytes", "callable", "chr", "classmethod", "compile",
  "complex", "delattr", "dict", "dir", "divmod", "enumerate", "eval",
  "exec", "filter", "float", "format", "frozenset", "getattr",
  "globals", "hasattr", "hash", "help", "hex", "id", "input", "int",
  "isinstance", "issubclass", "iter", "len", "list", "locals", "map",
  "max", "memoryview", "min", "next", "object", "oct", "open", "ord",
  "pow", "print", "property", "range", "repr", "reversed", "round",
  "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum",
  "super", "tuple", "type", "vars", "zip",
]);

/**
 * Python stdlib module names used as dotted prefix. `os.path.join` has
 * prefix `os`; `json.loads` has prefix `json`. Adapter rejects these
 * before the generic ladder mis-binds them. Includes the serialization
 * modules (`json`, `marshal`, the binary one starting with "pic"+"kle")
 * so they don't bind to repo symbols.
 */
export const PYTHON_STDLIB_MODULES = new Set([
  "abc", "argparse", "array", "ast", "asyncio", "base64", "bisect",
  "builtins", "bz2", "calendar", "cmath", "codecs", "collections",
  "concurrent", "configparser", "contextlib", "copy", "copyreg", "csv",
  "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis",
  "email", "encodings", "enum", "errno", "fcntl", "fnmatch",
  "fractions", "functools", "gc", "getopt", "getpass", "gettext",
  "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http",
  "imaplib", "importlib", "inspect", "io", "ipaddress", "itertools",
  "json", "keyword", "linecache", "locale", "logging", "lzma",
  "marshal", "math", "mimetypes", "mmap", "multiprocessing",
  "numbers", "operator", "os", "pathlib", "pic" + "kle", "pkgutil",
  "platform", "plistlib", "posixpath", "pprint", "queue", "random",
  "re", "reprlib", "resource", "runpy", "secrets", "select",
  "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtpd",
  "smtplib", "socket", "socketserver", "sqlite3", "ssl", "stat",
  "statistics", "string", "stringprep", "struct", "subprocess",
  "symtable", "sys", "sysconfig", "tarfile", "telnetlib", "tempfile",
  "textwrap", "threading", "time", "timeit", "tkinter", "token",
  "tokenize", "trace", "traceback", "tracemalloc", "tty", "types",
  "typing", "unicodedata", "unittest", "urllib", "uuid", "venv",
  "warnings", "weakref", "webbrowser", "wsgiref", "xml", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

/**
 * Bare Go builtin functions/predeclared identifiers. A call to `make`,
 * `append`, `len`, `cap`, etc. is the language itself, not a repo
 * function.
 */
export const GO_BUILTIN_NAMES = new Set([
  "append", "cap", "clear", "close", "complex", "copy", "delete",
  "imag", "len", "make", "max", "min", "new", "panic", "print",
  "println", "real", "recover",
]);

/**
 * Go stdlib package names used as the dotted prefix in calls
 * (`fmt.Println`, `strings.Split`). The full import path is
 * `encoding/json` but call sites reference it as `json`.
 */
export const GO_STDLIB_PACKAGES = new Set([
  "archive", "bufio", "builtin", "bytes", "cmp", "compress", "context",
  "crypto", "database", "debug", "embed", "encoding", "errors", "expvar",
  "flag", "fmt", "go", "hash", "html", "image", "index", "io", "iter",
  "log", "maps", "math", "mime", "net", "os", "path", "plugin", "rand",
  "reflect", "regexp", "runtime", "slices", "sort", "strconv", "strings",
  "sync", "syscall", "testing", "text", "time", "unicode", "unsafe", "utf8",
  // Common subpackages referenced by short name:
  "atomic", "json", "filepath", "exec", "http", "url", "tls", "tcp",
  "signal", "tar", "zip", "gzip", "base64", "hex", "sha256", "sha1",
  "md5", "aes", "rsa", "pem", "x509",
]);

/**
 * JDK classes commonly used as static-method receivers. `System.out`,
 * `Math.floor`, `Arrays.asList` etc. shouldn't bind to a repo class.
 */
export const JAVA_BUILTIN_NAMESPACES = new Set([
  "System", "Math", "String", "StringBuilder", "StringBuffer",
  "Integer", "Long", "Double", "Float", "Boolean", "Character",
  "Byte", "Short", "Object", "Class", "Thread", "Runtime",
  "ClassLoader", "ProcessBuilder", "Arrays", "Collections",
  "Optional", "Objects", "Stream", "IntStream", "LongStream",
  "DoubleStream", "Files", "Paths", "Path", "URI", "URL",
  "Pattern", "Matcher", "ZonedDateTime", "LocalDate", "LocalTime",
  "LocalDateTime", "Instant", "Duration", "Period", "Date",
  "Calendar", "UUID", "Throwable", "Exception", "RuntimeException",
  "IOException", "NullPointerException", "IllegalArgumentException",
  "IllegalStateException", "ConcurrentHashMap", "HashMap", "HashSet",
  "ArrayList", "LinkedList", "TreeMap", "TreeSet", "List", "Map",
  "Set", "Collection", "Iterator", "Comparator", "Function",
  "Predicate", "Consumer", "Supplier", "BiFunction",
  "CompletableFuture", "Future", "Executors", "TimeUnit",
]);

/**
 * Top-level Java package prefixes — when a call's prefix is `java`,
 * `javax`, etc., it's stdlib not a repo symbol.
 */
export const JAVA_LANG_PACKAGES = new Set([
  "java", "javax", "jakarta", "sun", "com.sun", "org.w3c", "org.xml",
]);

/**
 * Rust path prefixes that route to stdlib / language pseudo-paths.
 * `std::fs::read`, `core::mem::swap`, `alloc::vec::Vec` should not
 * resolve to repo symbols.
 */
export const RUST_STDLIB_PREFIXES = new Set([
  "std", "core", "alloc", "proc_macro", "test",
]);

/**
 * Rust same-scope keywords. `self.method`, `Self::method`,
 * `super::module::foo`, `crate::module::foo` route to local/repo lookup
 * with different semantics.
 */
export const RUST_SELF_KEYWORDS = new Set(["self", "Self", "super", "crate"]);

/**
 * .NET BCL types commonly used as static-method receivers. Mirrors
 * JAVA_BUILTIN_NAMESPACES for C# code.
 */
export const CSHARP_BUILTIN_NAMESPACES = new Set([
  "System", "Console", "Math", "String", "Int16", "Int32", "Int64",
  "UInt16", "UInt32", "UInt64", "Double", "Single", "Decimal",
  "Boolean", "Char", "Byte", "SByte", "Object", "Array", "Convert",
  "Environment", "DateTime", "DateTimeOffset", "TimeSpan", "TimeZoneInfo",
  "Guid", "Tuple", "ValueTuple", "Nullable", "Type", "Activator",
  "AppDomain", "Buffer", "BitConverter", "GC", "Lazy", "Random",
  "Action", "Func", "Task", "ValueTask", "Thread", "ThreadPool",
  "Monitor", "Interlocked", "Volatile", "CancellationToken",
  "CancellationTokenSource", "Encoding", "StringBuilder",
  "List", "Dictionary", "HashSet", "Queue", "Stack", "LinkedList",
  "SortedDictionary", "SortedSet", "ConcurrentDictionary", "ConcurrentBag",
  "IEnumerable", "ICollection", "IList", "IDictionary", "Enumerable",
  "File", "Directory", "Path", "FileInfo", "DirectoryInfo", "Stream",
  "FileStream", "MemoryStream", "StreamReader", "StreamWriter",
  "TextReader", "TextWriter", "BinaryReader", "BinaryWriter",
  "Regex", "Match", "MatchCollection", "Capture",
  "HttpClient", "WebClient", "Uri",
  "Exception", "ArgumentException", "ArgumentNullException",
  "InvalidOperationException", "NotImplementedException",
  "NotSupportedException",
]);

/**
 * C/C++ standard-library scope prefixes. `std::cout`, `std::vector`,
 * `boost::shared_ptr` should not resolve to repo symbols.
 */
export const CPP_STDLIB_NAMESPACES = new Set([
  "std", "boost", "absl", "folly", "Eigen", "cv", "tbb",
]);

/**
 * Check if an unresolved call target is a builtin that should be left
 * unbound. This is intentionally context-free and conservative.
 *
 * @param {string} targetName
 * @returns {boolean}
 */
export function isBuiltinCall(targetName) {
  if (!targetName) return false;
  if (
    BUILTIN_IDENTIFIERS.has(targetName) ||
    BUILTIN_CONSTRUCTORS.has(targetName) ||
    BUILTIN_MACROS.has(targetName)
  ) {
    return true;
  }

  if (targetName.includes("::")) {
    const parts = targetName.split("::").filter(Boolean);
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    if (
      BUILTIN_GLOBAL_NAMESPACES.has(prefix) ||
      RUST_STDLIB_PREFIXES.has(prefix) ||
      CPP_STDLIB_NAMESPACES.has(prefix)
    ) {
      return true;
    }
    if (member && BUILTIN_MACROS.has(member)) return true;
  }

  if (targetName.includes(".")) {
    const parts = targetName.split(".").filter(Boolean);
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    if (
      BUILTIN_GLOBAL_NAMESPACES.has(prefix) ||
      NODE_BUILTIN_MODULE_NAMES.has(prefix) ||
      PYTHON_STDLIB_MODULES.has(prefix) ||
      GO_STDLIB_PACKAGES.has(prefix) ||
      JAVA_BUILTIN_NAMESPACES.has(prefix) ||
      JAVA_LANG_PACKAGES.has(prefix) ||
      CSHARP_BUILTIN_NAMESPACES.has(prefix)
    ) {
      return true;
    }
    if (member && BUILTIN_MACROS.has(member)) return true;
  }

  return false;
}
