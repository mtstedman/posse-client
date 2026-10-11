// Skill-inference catalogue.
//
// The planner compiler infers the frontend-design skill for a dev task the
// planner did not tag when the task's scoped files and stated responsibility
// are visual work. The path classes and phrase lists that decide it live here;
// the rule itself is `shouldInferFrontendDesignSkill` in plan-compiler.js.
// The web-root vocabulary is shared with promote routing and the artificer.
// Keep this module pure: catalog modules must not import runtime helpers.

// Top-level directories a static site or app serves to the browser as-is.
// The empty root is the project root itself (promote destinations may resolve
// there); callers that need a named first path segment filter it out.
export const COMMON_WEB_ROOTS = Object.freeze(["", "htdocs", "public", "public_html", "www", "web", "static"]);

// Task-spec phrases that send a generated image to a served web destination
// (artificer format guidance): a path that starts at a web root, or wording
// that names web use. Expected files are checked by their first segment.
export const WEB_IMAGE_DESTINATION_PHRASES = Object.freeze([
  new RegExp(String.raw`(?:^|[\s"'\`(])\/?(?:${COMMON_WEB_ROOTS.filter(Boolean).join("|")})\/`, "i"),
  /\bweb\s+(?:assets?|images?)\b/i,
  /\bwebsite\b/i,
]);

// An edit to any of these is visual work by itself.
export const SKILL_INFERENCE_STYLESHEET_EXTENSIONS = Object.freeze([
  ".css", ".scss", ".sass", ".less", ".styl", ".pcss",
]);

// Server-rendered and static page templates.
export const SKILL_INFERENCE_MARKUP_EXTENSIONS = Object.freeze([
  ".html", ".htm", ".html.erb", ".hbs", ".handlebars", ".mustache", ".njk", ".ejs",
  ".pug", ".twig", ".blade.php", ".liquid", ".cshtml", ".razor",
]);

// Framework component files. They hold logic as often as markup, so they
// count as UI files only when the task text leans visual.
export const SKILL_INFERENCE_COMPONENT_EXTENSIONS = Object.freeze([
  ".jsx", ".tsx", ".vue", ".svelte", ".astro",
]);

// Plain scripts count as browser UI code only under a named web root.
export const SKILL_INFERENCE_BROWSER_SCRIPT_EXTENSIONS = Object.freeze([".js", ".mjs", ".ts"]);

// Test, fixture and story files never carry the skill.
export const SKILL_INFERENCE_TEST_DIRECTORIES = Object.freeze([
  "__tests__", "__mocks__", "test", "tests", "spec", "specs", "e2e", "cypress", "stories",
]);
export const SKILL_INFERENCE_TEST_BASENAME_PATTERN = /\.(?:test|spec|stories|story|cy|e2e)\.[a-z0-9]+$/;

// Directories and basename words that mark a module as logic even when its
// extension is a component extension (a hook in a .tsx file, a parser.jsx).
// Basename words are matched against the camelCase/kebab/snake tokens of the
// file stem, so `userSlice.ts` matches `slice` and `Restore.tsx` does not
// match `store`. A stem whose first token is `use` followed by more tokens is
// a hook (`useDebounce`, `use-debounce`).
export const SKILL_INFERENCE_LOGIC_DIRECTORIES = Object.freeze([
  "hook", "hooks", "composables", "util", "utils", "helper", "helpers",
  "store", "stores", "reducer", "reducers", "slice", "slices", "selectors",
  "service", "services", "api", "model", "models", "type", "types", "schema", "schemas",
]);
export const SKILL_INFERENCE_LOGIC_BASENAME_WORDS = Object.freeze([
  "util", "utils", "helper", "helpers", "parser", "tokenizer", "lexer", "formatter", "format",
  "validator", "validators", "schema", "types", "constants", "config", "store", "reducer",
  "slice", "selector", "selectors", "client", "service", "loader", "serializer",
]);

// Task-text phrase lists, matched against the lowercased title, spec,
// instructions and success criteria. Each pattern counts once. Visual and
// UI-surface hits together are the task's UI weight; logic hits weigh
// against it. Bare `theme`, `style` and `cards` are deliberately absent:
// they name data and parser tokens as often as visual work.
export const FRONTEND_DESIGN_VISUAL_PHRASES = Object.freeze([
  /\bvisual(?:ly)?\b/, /\bstyl(?:ing|ed)\b/, /\brestyle\b/, /\bredesign\b/, /\bstylesheet\b/, /\bcss\b/,
  /\blayout\b/, /\bresponsive\b/, /\btypography\b/, /\bfonts?\b/, /\bcolou?r(?:s| scheme| palette)?\b/,
  /\b(?:dark|light) (?:mode|theme)\b/, /\bspacing\b/, /\bpadding\b/, /\bmargins?\b/, /\balign(?:ment|ed)?\b/,
  /\bcontrast\b/, /\banimat(?:e|ion|ions)\b/, /\bhover\b/, /\bicons?\b/, /\blook and feel\b/,
  /\baccessib(?:le|ility)\b/, /\baria\b/, /\bscreen readers?\b/, /\bhighlight(?:s|ing)?\b/,
  /\brender(?:s|ing)?\b/, /\bdisplay(?:s|ed)?\b/, /\bshow(?:s|n)?\b/, /\bmobile\b/, /\boverlaps?\b/, /\bspinner\b/,
]);
export const FRONTEND_DESIGN_UI_SURFACE_PHRASES = Object.freeze([
  /\bpages?\b/, /\bhomepage\b/, /\bscreens?\b/, /\bviews?\b/, /\bcomponents?\b/, /\bmodals?\b/, /\bdialogs?\b/,
  /\bforms?\b/, /\bbuttons?\b/, /\bheader\b/, /\bfooter\b/, /\bnav(?:igation|bar)?\b/, /\bmenus?\b/,
  /\bsidebar\b/, /\bhero\b/, /\btoggle\b/, /\btooltips?\b/, /\bbanners?\b/, /\bdashboard\b/, /\bwidgets?\b/,
  /\btabs?\b/, /\bpanels?\b/, /\bui\b/, /\buser interface\b/, /\blanding\b/, /\bchart\b/, /\boverlay\b/, /\bminimap\b/,
]);
export const FRONTEND_DESIGN_LOGIC_PHRASES = Object.freeze([
  /\balgorithms?\b/, /\bpars(?:e|er|ing)\b/, /\btokeni[sz]er\b/, /\btokens?\b/, /\blexer\b/, /\bvalidat(?:e|ion|or)\b/,
  /\bloader\b/, /\bformatt(?:er|ing)\b/, /\bcalculat(?:e|ion|ions)\b/, /\bcomput(?:e|es|ation)\b/,
  /\bscor(?:e|es|ing)\b/, /\brank(?:s|ing)?\b/, /\bdata structures?\b/, /\bseriali[sz](?:e|er|ation)\b/,
  /\bregex\b/, /\bschema\b/, /\breducers?\b/, /\bstate machine\b/, /\bapi\b/, /\bendpoints?\b/,
  /\bquer(?:y|ies)\b/, /\bcach(?:e|ing)\b/, /\bperformance\b/, /\boptimi[sz]e\b/, /\bsort(?:ing)?\b/,
  /\bmemory leak\b/, /\brace condition\b/, /\bnull\b/, /\bundefined\b/, /\bthrows?\b/, /\bexceptions?\b/,
  /\boff-by-one\b/, /\blogic\b/, /\bpathfinding\b/, /\bescaping\b/, /\bjson\b/, /\bcsv\b/, /\bsql\b/,
]);
