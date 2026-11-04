import { getDb } from "../../../shared/storage/functions/index.js";
import { getAccountRepoSetting } from "../../settings/functions/account-settings.js";
import { SETTINGS_DEFAULTS } from "../../settings/functions/catalog.js";
import { resolveRepoSettingPath } from "../../settings/functions/repository-settings.js";
import { normalizeProjectDir } from "../../runtime/functions/paths.js";
import { REVIEWED_HANDOFF_SETTING } from "../../../catalog/reviewed-handoffs.js";

// Admission is a hot queue path. Resolve Git's common directory once per
// runtime/project identity; the account settings owner still reads its live,
// invalidated value on every decision, including the lease transaction.
export class ReviewedHandoffSettings {
  enabled() {
    const db = getDb();
    const projectDir = process.env.POSSE_PROJECT_DIR || normalizeProjectDir();
    if (this.db !== db || this.projectDir !== projectDir) {
      // Resolution can fail (Git timeout or unavailable). Record the identity
      // only with its resolved path, or later calls would skip resolution and
      // read the default instead of the operator's repository setting.
      const repoPath = resolveRepoSettingPath(projectDir);
      this.db = db;
      this.projectDir = projectDir;
      this.repoPath = repoPath;
    }
    const value = getAccountRepoSetting(REVIEWED_HANDOFF_SETTING, this.repoPath)
      ?? SETTINGS_DEFAULTS[REVIEWED_HANDOFF_SETTING];
    return value === "on";
  }
}
