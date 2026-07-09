// @ts-check

import fs from "fs";
import { canonicalRepoPathOrThrow } from "../../functions/v2/parser/normalize.js";
import {
  resolveLanguage,
  supportedLanguageTags,
} from "../../functions/v2/parser/languages/index.js";
import { parserFor } from "../../functions/v2/parser/treesitter/loader.js";
import { parseBuffer } from "../../functions/v2/parser/adapter.js";
import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";

/** @typedef {import("../../functions/v2/contracts/api.js").ParserAdapter} ParserAdapterContract */
/** @typedef {import("../../functions/v2/contracts/schemas.js").ParseResult} ParseResult */

/** @type {boolean | null} Lazily probed nativeBinaries.shouldUse("atlas"). */
let nativeParserUsable = null;

/**
 * @implements {ParserAdapterContract}
 */
export class ParserAdapter {
  /**
   * @param {{ absPath: string, repoRoot: string }} args
   * @returns {Promise<ParseResult>}
   */
  async parseFile({ absPath, repoRoot }) {
    if (!absPath) throw new RangeError("parseFile: absPath is required");
    if (!repoRoot) throw new RangeError("parseFile: repoRoot is required");
    const repo_rel_path = canonicalRepoPathOrThrow(absPath, repoRoot);
    const bytes = await fs.promises.readFile(absPath);
    return parseBuffer({ bytes, repo_rel_path });
  }

  /**
   * @param {{ bytes: Buffer | string, repo_rel_path: string, lang?: string }} args
   * @returns {ParseResult}
   */
  parseBuffer(args) {
    return parseBuffer(args);
  }

  /**
   * @param {string} extOrLang
   * @returns {boolean}
   */
  supports(extOrLang) {
    const descriptor = resolveLanguage(extOrLang);
    if (!descriptor || !descriptor.supported) return false;
    // Native-owned languages need no JS grammar; the binary carries its
    // grammars at compile time. But without a usable binary there is no
    // parser at all - claiming support would queue every file just to fail
    // it individually as a parse_error. Probed once: shouldUse stats the
    // staged binary on every call and supports() runs per file in the
    // ParseEngine filters; staging doesn't change within a process.
    if (descriptor.native) {
      if (nativeParserUsable == null) nativeParserUsable = nativeBinaries.shouldUse("atlas");
      return nativeParserUsable;
    }
    return !!parserFor(descriptor.tag);
  }

  /**
   * @returns {string[]}
   */
  languages() {
    return supportedLanguageTags();
  }
}

/**
 * Singleton convenience instance. Most callers want the shared adapter
 * since extraction state is purely a function of inputs.
 */
export const sharedParserAdapter = new ParserAdapter();
