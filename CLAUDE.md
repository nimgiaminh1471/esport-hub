# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run smoke        # LoL: live matches, 24h schedule, one game's stats
npm run smoke:val    # Valorant: leagues, live, 24h schedule, one series' map list
npm run notify:dry   # run the cron entrypoint, print Block Kit to stdout, send nothing to Slack
npm run notify       # send for real (needs .env with SLACK_BOT_TOKEN + SLACK_CHANNEL_ID)
npm run serve        # static server for docs/ on http://localhost:8080

node src/providers/lol.js --stats <gameId>       # one game's live stats
node src/providers/lol.js --match <matchId>      # full match JSON
node src/providers/valorant.js --match <matchId> # series + map list (no stats exist)
# /note is Slack-only; stub KV with a Map to exercise it from Node (see worker/src/note.js)
GAME=val npm run notify:dry                      # only Valorant

cd worker && npx wrangler dev      # slash command locally (needs worker/.dev.vars)
cd worker && npx wrangler deploy
```

There is no test framework, linter, or build step — nothing to install (`node_modules` stays
empty; the project has zero dependencies and runs on Node 22+ globals). Verification is done
against live data:

- `npm run smoke` — checks the provider layer end to end.
- `npm run notify:dry` **twice in a row** — the dedup check. The second run must print no
  messages for either game. Delete `state/announced*.json` to make them reappear.

## Architecture

Three surfaces, none of which needs a long-running server:

| Surface | Runs on | Job |
|---|---|---|
| `src/notify.js` | GitHub Actions cron, every 5 min | announce upcoming / started / finished, for every registered game |
| `worker/src/index.js` | Cloudflare Workers | `/lol` and `/val` — `schedule`, `live`, `match <id>`; plus `/note` |
| `docs/` | GitHub Pages | schedule + live in-game stats (LoL only), polls every 10s |

### `docs/assets/` is the single source of truth

Every call to Riot's API lives in `docs/assets/*-core.js`, and all three surfaces import them:

```
docs/assets/riot-core.js + <game>-core.js + games.js
  ├── src/providers/*.js         (Node, relative import + CLI)
  ├── docs/assets/*-page.js      (browser, direct ESM import)
  └── worker/src/index.js        (wrangler bundles it)
```

**This constrains what may go in them.** Every `*-core.js` must stay plain ESM using only globals
available in both Node 22+ and browsers (`fetch`, `AbortSignal.timeout`, `crypto`) — no
`node:*` imports, no DOM, no dependencies. `src/lib/blocks.js` has the same constraint (it is
shared by the Node cron and the Worker). `docs/assets/ddragon.js` may use `localStorage`
because only the browser imports it.

Consequence: `docs/` is not just the published site, it is also a source directory that Node
and the Worker import from. Moving or renaming files there breaks the bot.

### Multi-game

Two games ship today: `lol` and `val` (VALORANT). **The canonical provider interface — which
methods are required, which are capability-gated, and how to add a third game — is the header
comment of [docs/assets/games.js](docs/assets/games.js).** Do not restate it here or in the
README; three copies had already drifted apart before it was consolidated.

The layering:

```
docs/assets/riot-core.js    transport + createRiotGateway() — no game knowledge
  ├── lol-core.js           gateway('native' live) + the livestats feed
  └── val-core.js           gateway(sport:'val', 'derive' live) + null stubs
docs/assets/games.js        the registry all three surfaces import
```

`docs/assets/games.js` is the single registry; `src/providers/index.js` is only a re-export so
`src/` keeps its familiar import path. It must live in `docs/` because that is the only
directory Node, the Worker and the browser can all reach.

**Capabilities, not `if (game === 'lol')`.** A provider declares
`capabilities.liveStats`. Games without it still expose `getGameSnapshot`/`getTimeline`/etc.
returning `null`/`[]` — every caller already null-guards (Riot returns 204 for a game that
hasn't started), so nothing needs `?.`. The flag exists to fix *messaging* and skip wasted
work, and only three places read it: the Worker's `match` case, `match-page.js`, and the
Valorant smoke CLI.

### Valorant has no in-match stats — permanently

Riot publishes no livestats feed for Valorant. `feed.valorantesports.com` does not resolve at
all, and the LoL feed returns 204 for Valorant game IDs. `getLive` also 400s on every variant,
so `val-core.js` derives it by filtering `getSchedule()` for `inProgress`. Do not go hunting
for another endpoint — verify with a request before believing any claim otherwise.

Valorant also adds the game state **`"unneeded"`** (unplayed maps in a decided Bo3) and per-map
`teams[].side`, and returns **no map names** (Bind/Haven…) — only map numbers.

### `?sport=`, never `?game=`, for selecting the game

`?game=` was already taken: `match.html?game=<gameId>` selects a *map*, and it is documented in
the README. The sport travels as `?sport=val`; LoL omits it entirely so every existing URL is
byte-identical. See `gameFromSearch` / `matchHref` in `games.js` and `matchUrl` in
`src/lib/config.js`.

### One process, all games — not a workflow matrix

`src/notify.js` loops every registered game in one process (`GAME=val` narrows it for local
testing). A matrix would race: `concurrency: {group: notify}` serialises workflow *runs*, not
matrix legs, so two legs would both `git add state/` and the rebase-retry loop would hit a
conflict rather than a merge. Each game gets its own try/catch and its own state file
(`state/announced.json` for LoL, `state/announced-<game>.json` otherwise), with
`process.exitCode` set only after every game has saved.

League filtering lives in `docs/assets/leagues.js` — see below.

### `/note` — personal ledger, deliberately undiscoverable

A private running tally, unrelated to the esports features. Stored in a **Cloudflare KV
namespace** (`env.NOTE`) and viewable two ways. Two halves that share only the storage and the
views: the **per-match ledger** below (entered with `/note add`, period 26→25) and the **daily
settlement** further down (one typed total a day, split with the other party). Keys are `e:`
and `d:` respectively, so neither listing sees the other's rows.

- **Data lives in KV, not in this repo** — that is the whole point. `worker/src/note.js` is the
  only file that touches it; `docs/assets/note-core.js` holds the pure maths so it is testable
  from Node without KV (stub it with a `Map`; see the header of `note.js`).
- **One KV key per row**, entry payload in the key's `metadata`. Never collapse a period into a
  single key: two rows entered seconds apart would race on read-modify-write and one would
  vanish silently. Keys keep milliseconds so lexicographic order equals chronological order.
- **Periods run the 26th to the 25th, computed in `Asia/Ho_Chi_Minh`.** `01:00` on the 26th
  local is `18:00` on the 25th UTC — computing in UTC lands rows in the wrong period, and you
  would only notice at settlement. `periodOf()` converts via `Intl.DateTimeFormat('en-CA')`.
- A row's period comes from **when it was entered**, not the match date, so a closed period can
  never change retroactively.
- Two independent columns, each carrying its own sign; neither is derivable from the other.
  `--r 10` with no sign means `+10` and does **not** inherit the row's direction.
- **Two view routes, deliberately.** `docs/note.html` on GitHub Pages (fetches
  `<worker>/note.json`) and `<worker>/note` served straight from the Worker
  (`worker/src/note-view.js`, self-contained HTML). The Pages one is the nicer URL; the Worker
  one needs no configuration and is the fallback when the hardcoded URL is stale.
- **`DEFAULT_API` in `docs/assets/note-page.js` must match the real Worker URL.** The
  `workers.dev` subdomain belongs to the Cloudflare account and **cannot be derived from
  anything in this repo** — do not guess it. It is printed at the end of `wrangler deploy`.
  `?api=<url>` overrides it at runtime so a stale constant is recoverable without a code change.
- `note-page.js` deliberately does **not** import `worker/src/note-core.js`: `/note.json`
  already returns a computed `summary`, so the arithmetic exists in exactly one place. That is
  also why `note-core.js` sits in `worker/` and not in `docs/assets/`.
- The page is **not linked from anywhere** and has **no access check** — `isAllowed()` in
  `worker/src/index.js` returns `true` by design (the owner's explicit choice). It is the single
  place to change if that should ever be gated. `noindex` is set, which is not a control.
- The page is a plain template string with **no client-side script**; user-supplied labels and
  notes go through `esc()` before interpolation.
- **Anyone in the Slack workspace can run `/note`** and would see this same ledger —
  `body.user_id` is available but unused. Known gap, not yet closed.
- The `/note` branch in `handleCommand` must stay **above** `resolveGame` — `/note` is not a
  game id and would otherwise hit the "unknown command" path.
- Keep the vocabulary here neutral and the figures unitless. Do not add a currency symbol, and
  do not name anyone. **This applies to the daily settlement too** — the other party is
  `doiTac` / "đối tác" in code, Slack and UI, never a real name, even though that message goes
  to a shared channel.

### Daily settlement — one number a day, split, posted

The other half of `/note`: at the end of each day the owner types the day's total profit,
the Worker splits it, writes one KV row, and posts the summary to the Slack channel.
`/note chot | day | days | xoa` are the whole surface.

- **The number is typed, not fetched — and that is a decision, not a shortcut.** Binance does
  expose the Prediction Markets PnL (`/sapi/v1/w3w/wallet/prediction/position/settled-history`),
  and this was built against it first. It was dropped because reading it needs a key with
  *Prediction Trading* permission, which Binance expires after 90 days unless the key is pinned
  to an IP allowlist — and Workers have no fixed egress IP to pin. A ledger that silently stops
  every 90 days is worse than one that needs a daily message. Git history has the working
  transport (`worker/src/binance.js`, `src/pnl.js`) if a static egress IP ever exists.
- **Money is stored as integers of 1/100** (`SCALE` in `day-core.js`), never as floats. Fields
  carry the `Units` suffix for that reason. `parseAmount` accepts `12,5` as well as `12.5` — a
  Vietnamese keyboard gives the comma, and `Number('12,5')` is `NaN`, which would land as a
  0.00 day indistinguishable from breaking even. It also rejects absurd magnitudes, because a
  typed ledger's likeliest error is one digit too many.
- **`minh = profit − doiTac`**, not computed independently, so the two shares always add back
  to the total exactly. The formula needs no branch for a losing day — losses split at the same
  ratio, and **a day never carries into the next one**.
- **The ratio in force is written onto each settled row.** `DOI_TAC_SHARE` (a `[vars]` entry,
  default 0.5) only affects days settled from then on. Reading the live ratio at display time
  would silently restate every already-settled day — the same trap `RATE` avoids in
  `note-core.js`.
- **One KV key per day (`d:YYYY-MM-DD`)**, the whole row in `metadata`, empty value. Collapsing
  a day into one key is safe *here* — one number, written once — which is exactly the opposite
  of the per-row ledger's constraint. `list()` then reads a whole month in one call.
- **Re-typing a settled day is refused; `--sua` overwrites and posts a *correction* message
  naming the old number.** The channel already received the first figure and the other party
  may have acted on it, so a silent swap leaves the month's total changed with nothing to
  explain it. The overwritten value is also kept on the row as `suaTu`.
- `/note xoa` deletes a day outright and deliberately posts nothing: it is for settling the
  *wrong date*, where the correcting announcement is the `chot` of the right date right after.
- **There is no cron.** Nothing can be computed without the typed number, so a scheduled job
  would have nothing to do; a nagging reminder was considered and declined. A forgotten day
  stays empty until `/note chot <date> <number>` fills it, which works for any past date.
- Slack Block Kit for this lives in `day-core.js`, not `src/lib/blocks.js` — that file is the
  esports Block Kit and imports the game registry, which `/note` deliberately stays clear of.
  `worker/src/slack-post.js` exists because `src/slack.js` pulls in `src/lib/config.js`
  (`node:url`), which the Worker cannot bundle.

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
- **League filtering is in `docs/assets/leagues.js`, not `config/`.** It has to be somewhere
  all three surfaces can import: the Worker cannot import `src/lib/config.js` (it uses
  `node:fs`), and the browser cannot fetch anything outside `docs/` (GitHub Pages serves only
  that directory). It is `.js` rather than `.json` because the repo has no JSON-import
  precedent and `wrangler.toml` declares no loader — plain ESM sidesteps the question.
  `src/lib/config.js` re-exports it so `src/` keeps its familiar import path.
- LoL filters down to 13 leagues; Valorant is `mode: "all"` (measured at ~5 matches/24h).
  A misspelled slug makes that league vanish with no error, so `npm run smoke` cross-checks
  every configured slug against the live `getLeagues()` and warns.
- **Filtering is client-side on purpose.** The API *does* accept `leagueId=id1,id2,id3`
  (comma-separated, survives `URLSearchParams` percent-encoding, works for Valorant too) — but
  you cannot count what you never fetched, and the "đã bỏ qua N trận" line is what tells the
  reader the filter is on rather than the bot being broken.
- **Callers must pass `limit: Infinity` to `getUpcoming` before filtering.** It applies
  `slice(0, limit)` *after* collecting across every league, so asking for 20 and filtering
  afterwards can yield zero even when the window holds LCK matches. Its pagination is driven by
  time, not count, so a large limit costs no extra requests.
- Escape hatches: `all` token on the slash command (`/lol schedule 24 all`), `?leagues=all`
  on the web.
- The Worker's secrets go in via `wrangler secret put` (or `worker/.dev.vars` locally):
  `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`. `PAGES_BASE_URL`, `SLACK_CHANNEL_ID` and
  `DOI_TAC_SHARE` are plain vars in `wrangler.toml`.
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
