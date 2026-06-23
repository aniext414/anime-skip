// Build per-anime skip-time files from AniSkip's public CSV dump.
//
// No dependencies — Node 18+ (global fetch). Idempotent in two ways:
//   - exits early when the upstream CSV is byte-identical to the last sync (nothing to commit), and
//   - rewrites a per-anime file only when ITS content changed, so each sync touches a handful of
//     files instead of all ~3k (keeps git history + CDN caches sane).
//
// Output (served as-is over a CDN):
//   data/version.json        — { generated, source, sourceHash, animeCount, rowCount }
//   data/skip/<malId>.json   — { malId, episodes: { "<ep>": { op:[s,e], ed:[s,e], recap:[s,e] } } }
//
// Selection: for each (anime, episode, normalized-type) the highest-voted row wins (mirrors what the
// live AniSkip API does internally). Times are seconds.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SKIP = join(DATA, 'skip');
const SOURCE = 'https://raw.githubusercontent.com/aniskip/sanitize_db_dump/main/skip_times_public.csv';

// AniSkip's skip_type values folded onto the keys we emit. "mixed-*" are OP/ED that overlap recap/canon
// frames; for a skip button they behave like the OP/ED, so we collapse them.
const TYPE = { op: 'op', 'mixed-op': 'op', ed: 'ed', 'mixed-ed': 'ed', recap: 'recap' };

const round = (n) => Math.round(n * 1000) / 1000;

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch ${SOURCE} -> ${res.status}`);
  const csv = await res.text();
  const sourceHash = 'sha256:' + createHash('sha256').update(csv).digest('hex');

  const versionPath = join(DATA, 'version.json');
  const prev = existsSync(versionPath) ? JSON.parse(await readFile(versionPath, 'utf8')) : null;
  if (prev && prev.sourceHash === sourceHash) {
    console.log('Upstream CSV unchanged — nothing to do.');
    return;
  }

  // Columns: anime_id, episode_number, provider_name, skip_type, votes, start_time, end_time, episode_length, submit_date
  // No field in the dump contains commas, so a plain split on the fixed 9 columns is safe.
  const lines = csv.split('\n');
  const byAnime = new Map(); // malId -> Map(ep -> Map(type -> { start, end, votes }))
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');
    if (f.length < 8) continue;
    const malId = Number(f[0]);
    const ep = f[1].trim();
    const type = TYPE[f[3]];
    if (!type || !Number.isFinite(malId) || !ep) continue;
    const votes = Number(f[4]) || 0;
    const start = Number(f[5]);
    const end = Number(f[6]);
    const len = Number(f[7]); // episode_length the times were submitted against (for receiver-side scaling)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    rows++;
    let eps = byAnime.get(malId);
    if (!eps) byAnime.set(malId, (eps = new Map()));
    let types = eps.get(ep);
    if (!types) eps.set(ep, (types = new Map()));
    const cur = types.get(type);
    if (!cur || votes > cur.votes) types.set(type, { start, end, votes, len });
  }

  await mkdir(SKIP, { recursive: true });

  const ids = new Set();
  let written = 0;
  for (const [malId, eps] of byAnime) {
    const episodes = {};
    for (const [ep, types] of [...eps].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const o = {};
      let bestVotes = -Infinity, len = 0;
      for (const t of ['op', 'ed', 'recap']) {
        const v = types.get(t);
        if (!v) continue;
        o[t] = [round(v.start), round(v.end)];
        if (v.votes > bestVotes && v.len > 0) { bestVotes = v.votes; len = v.len; } // reference length from the dominant row
      }
      if (!Object.keys(o).length) continue;
      if (len > 0) o.len = round(len); // the receiver scales op/ed/recap to the real encode via scale:{linear,ref:len}
      episodes[ep] = o;
    }
    if (!Object.keys(episodes).length) continue;
    ids.add(String(malId));
    const json = JSON.stringify({ malId, episodes });
    const file = join(SKIP, `${malId}.json`);
    const old = existsSync(file) ? await readFile(file, 'utf8') : null;
    if (old !== json) {
      await writeFile(file, json);
      written++;
    }
  }

  // Prune files for anime that dropped out of the dump.
  let pruned = 0;
  for (const name of await readdir(SKIP)) {
    if (name.endsWith('.json') && !ids.has(name.slice(0, -5))) {
      await rm(join(SKIP, name));
      pruned++;
    }
  }

  const version = {
    generated: new Date().toISOString(),
    source: SOURCE,
    sourceHash,
    animeCount: ids.size,
    rowCount: rows,
  };
  await writeFile(versionPath, JSON.stringify(version, null, 2) + '\n');
  console.log(`anime=${ids.size} rows=${rows} written=${written} pruned=${pruned}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
