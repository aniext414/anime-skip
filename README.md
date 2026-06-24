# anime-skip

Sharded, CDN-friendly mirror of anime opening/ending **skip times**, keyed by MyAnimeList id.

The data is sourced from [AniSkip's public dump](https://github.com/aniskip/sanitize_db_dump)
(`skip_times_public.csv`) — community-crowdsourced timings. This repo re-shapes that single growing CSV
into one tiny file per anime so a client fetches only the title it's playing (~1 KB) instead of the whole
database, and so updates reach clients with no app release.

## Layout

```
data/version.json        # { generated, schema, source, sourceHash, animeCount, rowCount }
data/skip/<malId>.json   # one file per anime, keyed by MAL id
```

Per-anime shape (`schema: 2`; times in **seconds**). Each episode is an **array of candidate submissions** —
every distinct submission *length* is kept (AniSkip is crowdsourced against many encodes — TV vs BD vs
per-provider top-and-tail — so the same op/ed lives at several lengths), de-duplicated to the highest-voted row
per `(type, length)`:

```json
{
  "malId": 52991,
  "episodes": {
    "1": [
      { "type": "op", "s": 93,   "e": 183,  "len": 1440, "votes": 50 },
      { "type": "op", "s": 95,   "e": 185,  "len": 1421, "votes": 12 },
      { "type": "ed", "s": 1340, "e": 1430, "len": 1440, "votes": 40 }
    ]
  }
}
```

`type` is `op` | `ed` | `recap`. `len` is the episode length the times were submitted against — match it to the
encode you're playing to pick the candidate whose absolute times line up; `len` is **omitted** when the dump
recorded none. `votes` is the community vote count (break ties / fall back when no length matches). A missing
`data/skip/<malId>.json` (404) simply means "no skip data" — clients treat it as empty.

> **Migration:** `schema: 1` emitted a single best-voted entry per type as `{ op:[s,e], ed:[s,e], len }`. The
> array shape lets the client do its own length matching instead of the producer pre-picking one length.

## Consuming it (no rate limits)

Fetch through a CDN that fronts this repo — **not** `raw.githubusercontent.com` (it throttles). Examples:

```
https://cdn.jsdelivr.net/gh/aniext414/anime-skip@main/data/skip/52991.json
https://raw.githack.com/aniext414/anime-skip/main/data/skip/52991.json
```

Read `data/version.json` (short cache) to decide when to refresh your local cache.

## How it updates

`.github/workflows/sync.yml` runs daily, fetches the upstream CSV, and regenerates the shards **only when
the CSV actually changed** (`scripts/build.mjs` compares a hash and rewrites just the files whose content
differs). Run it manually any time from the Actions tab.

Regenerate locally:

```
node scripts/build.mjs
```

## Attribution

Skip-time data © its contributors via [AniSkip](https://github.com/aniskip). This repo only reshapes and
redistributes their published public dump.
