import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CORPUS_BATCH_DOWNLOAD as D } from '../../../catalog/experiment-corpus-prep.js';
import { EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';

// Reuse the pinned public-HTTPS downloader and shared byte budget. Separate
// staging directories keep equal-content downloads from deleting one another.
export async function downloadCorpusBatch(items, { directory, download, archive, onDownloaded, signal, budget,
  concurrency = D.concurrency, delayMs = D.delayMs } = {}) {
  if (!Array.isArray(items) || !items.length || items.length > D.items || items.some(item => !item || typeof item.url !== 'string' || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 240)
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > D.concurrency || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw new Error('Invalid batch download.');
  let next = 0, nextStart = 0, persistence = Promise.resolve();
  const rows = Array(items.length);
  const persist = (receipt, index) => { persistence = persistence.then(() => onDownloaded(receipt, index)); return persistence; };
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++, item = items[index];
      let staging;
      try {
        const start = Math.max(Date.now(), nextStart); nextStart = start + delayMs;
        if (start > Date.now()) await delay(start - Date.now(), undefined, { signal });
        signal?.throwIfAborted();
        if (budget.bytes >= L.importBytes) throw new Error('Download byte budget exhausted.');
        staging = await fs.mkdtemp(path.join(directory, 'batch-'));
        const receipt = await download(item.url, staging, { signal, budget });
        signal?.throwIfAborted();
        const resource = await archive(receipt.path, item.label, receipt.sha256);
        const { path: _path, ...source } = receipt;
        await persist({ ...resource, ...source }, index);
        rows[index] = [index, item.label.slice(0, 96), resource.id, receipt.bytes, null];
      } catch (error) { rows[index] = [index, item.label.slice(0, 96), null, null, String(error.message).slice(0, 96)]; }
      finally { if (staging) await fs.rm(staging, { recursive: true, force: true }); }
    }
  };
  // Await every worker even on cleanup failure before returning control to prep.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  signal?.throwIfAborted();
  const failedWorker = settled.find(result => result.status === 'rejected');
  if (failedWorker?.status === 'rejected') throw failedWorker.reason;
  await persistence;
  const succeeded = rows.filter(row => row[2]).length;
  return { columns: ['index', 'label', 'resource_id', 'bytes', 'error'], rows, total: items.length, succeeded, failed: items.length - succeeded };
}
