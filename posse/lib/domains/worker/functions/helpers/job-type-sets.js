// Job-type sets that drive scheduling, locking, and assessment routing.
//
// The canonical definitions live in `lib/catalog/job.js`; this module
// re-exports them so existing import paths continue to work.

export {
  MUTATING_JOB_TYPES,
  ASSESSABLE_JOB_TYPES,
  QUEUE_LOCKING_JOB_TYPES,
} from "../../../../catalog/job.js";
