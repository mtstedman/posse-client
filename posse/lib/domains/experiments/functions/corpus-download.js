import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPinnedHttpsFetch } from '../../web-research/functions/download-files.js';
import { isLocalHostName, isPublicAddress } from '../../web-research/functions/source-snapshots.js';
import { EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';
import { corpusHash } from './corpus-archive.js';

function publicUrl(value) {
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096 || isLocalHostName(host) || (net.isIP(host) && !isPublicAddress(host))) throw new Error('Corpus downloads require a public HTTPS URL without credentials.');
  return url;
}
const discard = response => { response?.body?.destroy?.(); void response?.body?.cancel?.().catch(() => {}); };

export async function downloadCorpusInput(url, directory, { fetch = createPinnedHttpsFetch(), signal, budget = { bytes: 0 } } = {}) {
  const timeout = AbortSignal.timeout(60000), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let current = publicUrl(url);
  for (let hop = 0; hop <= 5; hop++) {
    combined.throwIfAborted();
    const response = await fetch(current.href, { signal: combined, headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Posse-Corpus/1' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); discard(response);
      if (!location) throw new Error('Download redirect has no destination.');
      current = publicUrl(new URL(location, current).href); continue;
    }
    if (response.status !== 200 || !['', 'identity'].includes(response.headers.get('content-encoding') || '')) { discard(response); throw new Error('Resource download failed or returned an encoded body.'); }
    const length = Number(response.headers.get('content-length'));
    if (length > L.resourceBytes || length + budget.bytes > L.importBytes) { discard(response); throw new Error('Download byte budget exceeded.'); }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of response.body) {
        combined.throwIfAborted(); const data = Buffer.from(chunk); bytes += data.length; budget.bytes += data.length;
        if (bytes > L.resourceBytes || budget.bytes > L.importBytes) throw new Error('Download byte budget exceeded.');
        chunks.push(data);
      }
    } finally { discard(response); }
    const data = Buffer.concat(chunks), id = corpusHash(data);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Download directory contains a symlink.');
    const filename = path.join(directory, `${id}.bin`), temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      try { await fs.link(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await fs.lstat(filename)).isFile() || await fs.realpath(filename) !== filename || corpusHash(await fs.readFile(filename)) !== id) throw new Error('Existing download was modified.'); }
    } finally { await fs.rm(temporary, { force: true }); }
    return { path: filename, sha256: id, bytes, source_url: url, final_url: current.href, media_type: response.headers.get('content-type') || 'application/octet-stream' };
  }
  throw new Error('Too many resource redirects.');
}
