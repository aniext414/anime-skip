// Build per-anime skip-time files from AniSkip's public CSV dump.
//
// No dependencies — Node 18+ (global fetch). Idempotent in two ways:
//   - exits early when the upstream CSV is byte-identical to the last sync AND the output schema is current
//     (nothing to commit), and
//   - rewrites a per-anime file only when ITS content changed, so each sync touches a handful of
//     files instead of all ~3k (keeps git history + CDN caches sane).
//
// Output (served as-is over a CDN):
//   data/version.json        — { generated, schema, source, sourceHash, animeCount, rowCount }
//   data/skip/<malId>.json   — { malId, episodes: { "<ep>": [ {type,s,e,len?,votes}, … ] } }
//
// Selection: AniSkip is crowdsourced against many different encodes, so the same episode has submissions at
// different episode lengths (TV vs BD vs per-provider top-and-tail). We KEEP every distinct length as its own
// candidate — for each (anime, episode, normalized-type, length) the highest-voted row wins — so the client can
// pick the candidate whose length is nearest the encode IT is playing (and never silently drop op/ed the way the
// live API's episodeLength filter does). Times are seconds. `len` is omitted when the dump didn't record one.
//
// NOTE: this is the v2 shape. v1 emitted a single best-voted entry per type as `{ op:[s,e], ed:[s,e], len }`;
// v2 emits the full candidate ARRAY so the receiver does the length matching. Bumping SCHEMA forces a full
// rebuild on the next sync even if the CSV hasn't changed.

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
const TYPE_ORDER = { op: 0, ed: 1, recap: 2 };
const SCHEMA = 2; // per-episode candidate ARRAY (see header). Bump to force a rebuild when the output shape changes.

const round = (n) => Math.round(n * 1000) / 1000;

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch ${SOURCE} -> ${res.status}`);
  const csv = await res.text();
  const sourceHash = 'sha256:' + createHash('sha256').update(csv).digest('hex');

  const versionPath = join(DATA, 'version.json');
  const prev = existsSync(versionPath) ? JSON.parse(await readFile(versionPath, 'utf8')) : null;
  if (prev && prev.sourceHash === sourceHash && prev.schema === SCHEMA) {
    console.log('Upstream CSV unchanged and schema current — nothing to do.');
    return;
  }

  // Columns: anime_id, episode_number, provider_name, skip_type, votes, start_time, end_time, episode_length, submit_date
  // No field in the dump contains commas, so a plain split on the fixed 9 columns is safe.
  const lines = csv.split('\n');
  const byAnime = new Map(); // malId -> Map(ep -> Map("type|len" -> { type, start, end, votes, len }))
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
    const rawLen = Number(f[7]); // episode_length the times were submitted against (for client-side length matching)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const len = Number.isFinite(rawLen) && rawLen > 0 ? round(rawLen) : 0; // 0 = the dump recorded no length
    rows++;
    let eps = byAnime.get(malId);
    if (!eps) byAnime.set(malId, (eps = new Map()));
    let cand = eps.get(ep);
    if (!cand) eps.set(ep, (cand = new Map()));
    // Bucket candidates by WHOLE-SECOND length: distinct encodes differ by many seconds (TV vs BD vs top-and-tail),
    // whereas sub-second jitter (1418.624 vs 1418.6) is the same encode — collapse it so votes, not rounding noise,
    // decides the winner within a length class. The precise `len` of the winning row is kept for client matching.
    const key = type + '|' + (len ? Math.round(len) : 0);
    const cur = cand.get(key);
    if (!cur || votes > cur.votes) cand.set(key, { type, start, end, votes, len });
  }

  await mkdir(SKIP, { recursive: true });

  const ids = new Set();
  let written = 0;
  for (const [malId, eps] of byAnime) {
    const episodes = {};
    for (const [ep, cand] of [...eps].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const arr = [...cand.values()].map((c) => {
        const o = { type: c.type, s: round(c.start), e: round(c.end) };
        if (c.len > 0) o.len = c.len; // omit unknown lengths rather than emit a misleading 0
        o.votes = c.votes;
        return o;
      });
      if (!arr.length) continue;
      // Deterministic order (stable diffs + a sensible fallback when the client has no duration): type, then
      // most-voted, then shortest length.
      arr.sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (b.votes - a.votes) || ((a.len || 0) - (b.len || 0)));
      episodes[ep] = arr;
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
    schema: SCHEMA,
    source: SOURCE,
    sourceHash,
    animeCount: ids.size,
    rowCount: rows,
  };
  await writeFile(versionPath, JSON.stringify(version, null, 2) + '\n');
  console.log(`schema=${SCHEMA} anime=${ids.size} rows=${rows} written=${written} pruned=${pruned}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
