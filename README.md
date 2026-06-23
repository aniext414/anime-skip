# anime-skip

Sharded, CDN-friendly mirror of anime opening/ending **skip times**, keyed by MyAnimeList id.

The data is sourced from [AniSkip's public dump](https://github.com/aniskip/sanitize_db_dump)
(`skip_times_public.csv`) — community-crowdsourced timings. This repo re-shapes that single growing CSV
into one tiny file per anime so a client fetches only the title it's playing (~1 KB) instead of the whole
database, and so updates reach clients with no app release.

## Layout

```
data/version.json        # { generated, source, sourceHash, animeCount, rowCount }
data/skip/<malId>.json   # one file per anime, keyed by MAL id
```

Per-anime shape (times in **seconds**, best-voted entry per episode/type):

```json
{
  "malId": 52991,
  "episodes": {
    "1": { "op": [93, 183], "ed": [1340, 1430] },
    "2": { "op": [90, 180], "ed": [1340, 1430], "recap": [90, 121] }
  }
}
```

A missing `data/skip/<malId>.json` (404) simply means "no skip data" — clients treat it as empty.

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
