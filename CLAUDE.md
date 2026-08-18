# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run smoke        # hit the real Riot API: prints live matches, 24h schedule, one game's stats
npm run notify:dry   # run the cron entrypoint, print Block Kit to stdout, send nothing to Slack
npm run notify       # send for real (needs .env with SLACK_BOT_TOKEN + SLACK_CHANNEL_ID)
npm run serve        # static server for docs/ on http://localhost:8080

node src/providers/lol.js --stats <gameId>    # one game's live stats
node src/providers/lol.js --match <matchId>   # full match JSON

cd worker && npx wrangler dev      # slash command locally (needs worker/.dev.vars)
cd worker && npx wrangler deploy
```

There is no test framework, linter, or build step — nothing to install (`node_modules` stays
empty; the project has zero dependencies and runs on Node 22+ globals). Verification is done
against live data:

- `npm run smoke` — checks the provider layer end to end.
- `npm run notify:dry` **twice in a row** — the dedup check. The second run must print no
  messages. Delete `state/announced.json` to make them reappear.

## Architecture

Three surfaces, none of which needs a long-running server:

| Surface | Runs on | Job |
|---|---|---|
| `src/notify.js` | GitHub Actions cron, every 5 min | announce upcoming / started / finished matches |
| `worker/src/index.js` | Cloudflare Workers | `/lol schedule`, `/lol live`, `/lol match <id>` |
| `docs/` | GitHub Pages | live in-game stats page, polls every 10s |

### `docs/assets/lol-core.js` is the single source of truth

Every call to Riot's API lives in that one file, and all three surfaces import it:

```
docs/assets/lol-core.js
  ├── src/providers/lol.js       (Node, relative import + CLI)
  ├── docs/assets/*-page.js      (browser, direct ESM import)
  └── worker/src/index.js        (wrangler bundles it)
```

**This constrains what may go in it.** `lol-core.js` must stay plain ESM using only globals
available in both Node 22+ and browsers (`fetch`, `AbortSignal.timeout`, `crypto`) — no
`node:*` imports, no DOM, no dependencies. `src/lib/blocks.js` has the same constraint (it is
shared by the Node cron and the Worker). `docs/assets/ddragon.js` may use `localStorage`
because only the browser imports it.

Consequence: `docs/` is not just the published site, it is also a source directory that Node
and the Worker import from. Moving or renaming files there breaks the bot.

### Adding another game

1. Write `docs/assets/<game>-core.js` exporting the same interface as `lolProvider` in
   `lol-core.js` (`getSchedule`, `getUpcoming`, `getLive`, `getMatch`, `getGameSnapshot`,
   `getLeagues`, `getGameStart`, `getTimeline`).
2. `src/providers/<game>.js` re-exports it.
3. Add one line to `src/providers/index.js`.

Slack blocks, the workflow, and the web pages need no changes — they only consume the
normalized event shape produced by `normalizeEvent`.

### Dedup is state-based, not time-based

GitHub cron is routinely 5–15 minutes late, so `src/notify.js` never reasons about "this run
covers this time window". Instead `state/announced.json` records the last announced state per
match, the job compares against it, and the workflow commits the file back to the repo
(`.github/workflows/notify.yml`, with rebase-and-retry on push races). `saveState` skips
writing when nothing changed so cron does not create an empty commit every 5 minutes.

Only matches that got an "upcoming" post produce `inProgress` / `completed` replies, and
those replies go into that post's thread via the stored `slackTs`. A match the channel never
saw gets no commentary. If cron is late enough to miss `inProgress` entirely, the bot skips
straight to the finished message — one lost message, never wrong data.

### Riot API constraints (do not "fix" these)

- **Livestats are ~3.5 minutes behind broadcast.** Riot rejects windows ending newer than
  `now - 190s` with `400 BAD_QUERY_PARAMETER`; `FEED_DELAY_SECONDS = 210` in `lol-core.js`
  gives clock-skew margin. Anti-cheat measure, not a bug — the UI states it explicitly.
- **Calling `window` without `startingTime` returns the game's *first* frame** (all zeros),
  not the latest state. `getWindow` always supplies a timestamp unless `fromStart: true`.
- **HTTP 204 means "no livestats yet"** and `fetchJson` maps it to `null`. Callers must
  distinguish `null` from an object; `getGameSnapshot` returns `null` for a game not started.
- **Some leagues have livestats switched off entirely** (regional/academy — e.g.
  `north_regional_league`). Every request *with* `startingTime` returns `404
  RESOURCE_NOT_FOUND "Stats are disabled for game …"`, while the same request *without*
  `startingTime` returns 200 — but only the all-zero first frame. Do not "fix" the 404 by
  dropping `startingTime`; that shows 0/0/0 as if it were real data. `feedGet` maps this 404
  to `null`, remembers the game in `isStatsDisabled(gameId)` so callers stop polling, and
  still throws on the other 404 (`"does not exist"`, i.e. a wrong id).
- `API_KEY` in `lol-core.js` is the public key lolesports.com itself ships to browsers. It is
  intentionally committed and must be in client code — it is not a leaked secret.
- Riot returns image URLs over `http://`; `secureUrl()` rewrites the scheme so GitHub Pages
  does not block them as mixed content.
- This is an undocumented internal API with no stability guarantee. Schema changes should only
  ever require editing `lol-core.js`.
- `getEventDetails` omits `startTime`, `state`, `blockName` and team records, so `getMatch`
  derives state from its games and backfills the rest from `getLive`/`getSchedule`
  (`enrich: false` skips those extra requests).

### Config and secrets

- Env vars are read in `src/lib/config.js` only. `.env.example` documents them; `DRY_RUN=1`
  bypasses the Slack-config assertion.
- League filtering lives in `config/leagues.json` (`mode: "all"` + `exclude`, or
  `mode: "include"`). Slugs come from `getLeagues`. Default is all leagues, which is noisy.
- The Worker holds the only real secret (`SLACK_SIGNING_SECRET`, via `wrangler secret put` or
  `worker/.dev.vars`). `PAGES_BASE_URL` is a plain var in `wrangler.toml`.
- Slack gives slash commands 3 seconds; the Worker races the work against `FAST_PATH_MS`
  (2.5s) and falls back to a deferred reply via `response_url`.

## Conventions

- Comments, log output, Slack copy, UI strings, and commit messages are in **Vietnamese**.
  Match that in anything you add. Timezone for fallback formatting is `Asia/Ho_Chi_Minh`;
  Slack timestamps use `<!date^…>` so each reader sees their own timezone.
- Comments in this codebase explain *why* (the Riot quirk, the race, the anti-pattern avoided),
  not what the line does. Keep that register.
- `chart.js` deliberately draws a diverging gold-diff area rather than two gold lines or a
  dual-axis chart; that choice is documented in its header.
- Browser pages stop polling when the tab is hidden and resume on focus.
