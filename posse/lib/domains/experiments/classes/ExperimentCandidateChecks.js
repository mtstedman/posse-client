import { randomUUID } from 'node:crypto';
import { EXPERIMENT_CANDIDATE_CHECK_LIMITS as L } from '../../../catalog/experiment-candidate-checks.js';
import { EXPERIMENT_OBJECTS as K } from '../../../catalog/experiments.js';
import { candidateCheckPayload, selectedCandidateChecks } from '../functions/candidate-checks.js';
import { experimentDigest } from '../functions/snapshots.js';

export class ExperimentCandidateChecks {
  constructor(runner) { this.runner = runner; this.service = runner.service; }
  pending() { return this.runner.store.list(K.RUNNERS).some(record => record.validation_run); }
  async run(record, accepted, candidate, signal) {
    const selected = selectedCandidateChecks(record.setup, accepted, candidate);
    if (!selected.length) return { ok: true, results: [], skipped: true };
    const digest = experimentDigest({ files: candidate, checks: selected });
    if (record.validation_cache?.[digest]) return { ...record.validation_cache[digest], reused: true };
    const results = [];
    for (const { check, index } of selected) {
      this.runner.check(record, signal);
      if (this.pending() || this.service.setups.smokeActive || this.service.setups.installActive
        || this.service.active.size || this.runner.store.list(K.CAMPAIGNS).some(campaign => campaign.active_run)) throw Error('Another owner sandbox must finish before candidate checks.');
      const runId = randomUUID();
      record.validation_run = { id: runId, check: index, digest };
      record.phase = 'candidate_checks'; this.runner.save(record);
      let output = '', observed = 0, passed = false, unconfirmed = false;
      try {
        const payload = candidateCheckPayload(record.setup, candidate, check);
        await this.service.backend.preflight(payload.plan);
        this.runner.check(record, signal);
        await this.service.backend.run({ runId, ...payload, signal,
          onDiagnostic: chunk => { output = Buffer.from(output + String(chunk)).subarray(-L.diagnosticBytes).toString('utf8'); },
          onObservation: observation => { observed++; passed = observation.values?.passed === 1; } });
      } catch (error) {
        unconfirmed = !!error.cleanupUnconfirmed;
        if (signal.aborted || unconfirmed || error.code === 'owner_fenced') throw error;
        output = `${output}\n${error.message}`.slice(-L.diagnosticBytes);
        passed = false;
      } finally {
        if (!unconfirmed) { this.service.assertOwner(); record.validation_run = null; this.runner.save(record); }
      }
      this.runner.check(record, signal);
      const ok = observed === 1 && passed;
      results.push({ check: index, ok, diagnostic: ok ? undefined : output || 'Candidate check did not complete successfully.' });
      if (!ok) break;
    }
    const result = { digest, ok: results.every(check => check.ok), results };
    record.last_validation = result;
    record.validation_cache ||= {};
    record.validation_cache[digest] = result;
    while (Object.keys(record.validation_cache).length > L.cache) delete record.validation_cache[Object.keys(record.validation_cache)[0]];
    this.runner.save(record);
    return result;
  }
  async recover(record) {
    if (!record.validation_run) return;
    try {
      if (!this.service.backend) throw Error('No execution backend.');
      await this.service.backend.cleanup(record.validation_run.id);
      record.validation_run = null;
    } catch { record.validation_run.cleanup_unconfirmed = true; }
    this.runner.save(record);
  }
}
