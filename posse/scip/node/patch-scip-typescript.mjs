import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scip-typescript emits one reference occurrence per declaration of the
// referenced symbol. In JavaScript every assignment declaration on a variable
// (`table[49152] = ...`, `ns.member = ...`) adds the assigned-to identifier as
// one more declaration of that variable, so a module that fills a table with N
// assignments emitted N occurrences at each of its N references: quadratic
// output that exhausts the heap on a file of a few thousand lines. Those
// assignment nodes are not definitions of the variable; when the symbol has a
// real declaration, references resolve to it alone.
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "node_modules", "@sourcegraph", "scip-typescript", "dist", "src", "FileIndexer.js");
const marker = "posseReferenceDeclarations";
const beforeReference = ": sym?.declarations || [];\n        }\n        for (const declaration of declarations) {";
const afterReference = `: ${marker}(sym);\n        }\n        for (const declaration of declarations) {`;
const beforeAnchor = "function isDefinition(node) {";
const helper = `function ${marker}(sym) {
    const declarations = sym?.declarations || [];
    if (declarations.length < 2) {
        return declarations;
    }
    const declared = declarations.filter(declaration => !(ts.isIdentifier(declaration) ||
        ts.isPropertyAccessExpression(declaration) ||
        ts.isElementAccessExpression(declaration) ||
        ts.isBinaryExpression(declaration) ||
        ts.isCallExpression(declaration)));
    return declared.length > 0 ? declared : declarations;
}
`;

if (!fs.existsSync(target)) process.exit(0);
let text = fs.readFileSync(target, "utf8");
if (!text.includes(marker)) {
  if (!text.includes(beforeReference)) throw new Error("scip-typescript reference declaration pattern not found");
  if (!text.includes(beforeAnchor)) throw new Error("scip-typescript isDefinition anchor not found");
  text = text.replace(beforeReference, () => afterReference).replace(beforeAnchor, () => helper + beforeAnchor);
  fs.writeFileSync(target, text);
}
