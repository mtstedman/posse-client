// @ts-check

import fs from "fs";
import { canonicalRepoPathOrThrow } from "../../functions/v2/parser/normalize.js";
import {
  resolveLanguage,
  supportedLanguageTags,
} from "../../functions/v2/parser/languages/index.js";
import { parseBuffer } from "../../functions/v2/parser/adapter.js";
import { __parseBufferNativeManagerForTests } from "../../functions/v2/native/parser.js";
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
   * @returns {Promise<ParseResult>}
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
    // All supported grammars are compiled into posse-atlas. Without a usable
    // binary there is no parser at all, so avoid queueing each file only to
    // fail it individually. Staging does not change within one process.
    if (!descriptor.native) return false;
    const testManager = __parseBufferNativeManagerForTests();
    if (testManager) return testManager.shouldUse("atlas");
    if (nativeParserUsable == null) nativeParserUsable = nativeBinaries.shouldUse("atlas");
    return nativeParserUsable;
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
