/**
 * riot-core.js — phần dùng chung cho mọi game chạy trên gateway esports của Riot.
 *
 * Hoá ra LoL và Valorant dùng CHUNG một gateway, CHUNG một API key public, và trả
 * về CÙNG một shape event. Khác biệt duy nhất là host và query param `sport`:
 *
 *   LoL       https://esports-api.lolesports.com/persisted/gw/<endpoint>
 *   Valorant  https://esports-api.service.valorantesports.com/persisted/val/<endpoint>?sport=val
 *
 * Nên toàn bộ phần lịch/giải/chi tiết trận gom về một factory ở đây, mỗi game chỉ
 * còn khai báo host + khả năng của mình. Phần riêng của từng game (LoL có feed
 * livestats, Valorant không có) nằm ở file `<game>-core.js`.
 *
 * File này là ESM thuần, chỉ dùng `fetch` toàn cục nên chạy được ở CẢ HAI nơi:
 * browser (GitHub Pages) và Node 22+ (bot Slack, Worker). Không `node:*`, không DOM.
 */

/** Key public mà chính web lolesports.com dùng — không phải bí mật, không cần giấu. */
export const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

/* ------------------------------------------------------------------ helpers */

/**
 * Response của Riot trả ảnh qua `http://static.lolesports.com/...` — kể cả ảnh
 * giải và đội của Valorant cũng nằm trên host này. GitHub Pages chạy HTTPS nên
 * browser sẽ chặn mixed-content. Host có hỗ trợ HTTPS, chỉ là response ghi sai
 * scheme, nên rewrite là đủ.
 */
export function secureUrl(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url;
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} — ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON với timeout + retry. Trả `null` khi 204 (feed dùng 204 cho
 * "ván chưa có dữ liệu"), nên chỗ gọi phải phân biệt null với object.
 */
export async function fetchJson(url, { headers = {}, timeoutMs = 15000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 204) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, body);
        // 4xx (trừ 429) là lỗi của mình, retry vô nghĩa.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        lastError = err;
        continue;
      }
      return await res.json();
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/* ------------------------------------------------------------------ factory */

/**
 * Dựng bộ hàm lịch/giải/trận cho một game trên gateway của Riot.
 *
 * @param {object}  opts
 * @param {string}  opts.id            'lol' | 'val' — đi thẳng vào `event.game`
 * @param {string}  opts.base          host + đường dẫn gốc, không có `/` cuối
 * @param {string=} opts.sport         gắn `?sport=` vào mọi request (Valorant cần, LoL không)
 * @param {'native'|'derive'} opts.live  xem `getLive` bên dưới
 * @param {object=} opts.capabilities  { liveStats, feedDelaySeconds } — chỗ gọi đọc để tự giảm cấp
 * @param {object=} opts.terms         { unit } — 'Ván' với LoL, 'Map' với Valorant
 */
export function createRiotGateway({
  id,
  name,
  emoji,
  base,
  sport,
  live = 'native',
  capabilities = {},
  terms = {},
}) {
  const gwUrl = (path, params = {}) => {
    const qs = new URLSearchParams({ hl: 'en-US', ...(sport ? { sport } : {}), ...clean(params) });
    return `${base}/${path}?${qs}`;
  };

  const gw = (path, params) => fetchJson(gwUrl(path, params), { headers: { 'x-api-key': API_KEY } });

  /* --------------------------------------------------------- chuẩn hoá dữ liệu */

  /**
   * Gom event của Riot về shape chung mà Slack, trang web và các game khác đều
   * dùng được.
   *
   * `id` được đóng kín trong closure chứ KHÔNG nhận qua tham số thứ hai: các chỗ
   * gọi bên dưới dùng `.map(normalizeEvent)`, mà `.map` truyền index của mảng vào
   * tham số thứ hai. Vì hiện chưa ai đọc `event.game`, lỗi đó sẽ im lặng ghi
   * `game: 0` thay vì ném ra — tệ hơn crash nhiều.
   */
  function normalizeEvent(event) {
    if (!event) return null;
    const match = event.match ?? {};
    return {
      game: id,
      id: String(match.id ?? event.id ?? ''),
      startTime: event.startTime,
      state: event.state, // unstarted | inProgress | completed
      blockName: event.blockName ?? null,
      league: {
        id: event.league?.id ?? null,
        name: event.league?.name ?? 'Unknown',
        slug: event.league?.slug ?? null,
        image: secureUrl(event.league?.image),
      },
      tournamentId: event.tournament?.id ?? null,
      strategy: {
        type: match.strategy?.type ?? 'bestOf',
        count: match.strategy?.count ?? 1,
      },
      teams: (match.teams ?? []).map((t) => ({
        id: t.id ?? null,
        name: t.name ?? 'TBD',
        code: t.code ?? '???',
        image: secureUrl(t.image),
        record: t.record ?? null, // {wins, losses}
        wins: t.result?.gameWins ?? 0,
        outcome: t.result?.outcome ?? null, // win | loss | null
      })),
    };
  }

  /* ------------------------------------------------------------- endpoints */

  /** Danh mục giải, dùng để build bộ lọc. */
  async function getLeagues() {
    const data = await gw('getLeagues');
    return (data?.data?.leagues ?? []).map((l) => ({
      id: l.id,
      slug: l.slug,
      name: l.name,
      region: l.region,
      image: secureUrl(l.image),
      priority: l.priority,
    }));
  }

  /**
   * Lịch thi đấu. Không truyền gì thì Riot trả ~80 event quanh thời điểm hiện tại
   * (đủ cả completed, inProgress và unstarted). `pageToken` lấy từ
   * `pages.older` / `pages.newer`.
   */
  async function getSchedule({ leagueId, pageToken } = {}) {
    const data = await gw('getSchedule', { leagueId, pageToken });
    const schedule = data?.data?.schedule ?? {};
    return {
      events: (schedule.events ?? []).filter((e) => e.type === 'match').map((e) => normalizeEvent(e)),
      pages: schedule.pages ?? {},
    };
  }

  /**
   * Các trận đang diễn ra.
   *
   * Valorant KHÔNG có endpoint `getLive` (mọi biến thể đều trả 400), nên với
   * `live: 'derive'` ta lọc thẳng từ trang lịch — trang mặc định luôn nằm quanh
   * thời điểm hiện tại nên chắc chắn chứa các trận đang đá.
   */
  async function getLive() {
    if (live === 'derive') {
      const { events } = await getSchedule();
      return events.filter((e) => e.state === 'inProgress');
    }

    const data = await gw('getLive');
    return (data?.data?.schedule?.events ?? [])
      .filter((e) => e.type === 'match' || e.match)
      .map((e) => normalizeEvent(e));
  }

  /**
   * Trận sắp diễn ra trong `withinMinutes` phút tới, sắp xếp theo giờ bắt đầu.
   * Tự lật sang trang `newer` khi cửa sổ dài hơn dữ liệu trang đầu.
   */
  async function getUpcoming({ withinMinutes = 60, limit = 50, now = Date.now() } = {}) {
    const deadline = now + withinMinutes * 60_000;
    const found = [];
    let pageToken;

    for (let page = 0; page < 5; page++) {
      const { events, pages } = await getSchedule({ pageToken });
      for (const ev of events) {
        const startsAt = Date.parse(ev.startTime);
        if (ev.state === 'unstarted' && startsAt >= now && startsAt <= deadline) found.push(ev);
      }
      // Còn dữ liệu chưa quét hết cửa sổ thì mới sang trang tiếp.
      const latest = events.reduce((max, e) => Math.max(max, Date.parse(e.startTime) || 0), 0);
      if (!pages.newer || latest >= deadline || events.length === 0) break;
      pageToken = pages.newer;
    }

    return found.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).slice(0, limit);
  }

  /**
   * Chi tiết một series: thông tin trận + danh sách ván (gameId) kèm trạng thái.
   *
   * `getEventDetails` KHÔNG trả `startTime`, `state`, `blockName` hay thành tích
   * đội — chỉ có đội, tỉ số và danh sách ván. Nên `state` được suy ra từ các ván,
   * còn phần lịch được bù lại từ getLive/getSchedule (tắt bằng `enrich: false`
   * nếu chỉ cần chỉ số và muốn tiết kiệm request).
   */
  async function getMatch(matchId, { enrich = true } = {}) {
    const data = await gw('getEventDetails', { id: matchId });
    const event = data?.data?.event;
    if (!event) return null;

    const normalized = normalizeEvent({ ...event, id: event.id ?? matchId, type: 'match' });
    normalized.id = String(matchId);
    normalized.games = (event.match?.games ?? []).map((g) => ({
      id: String(g.id),
      number: g.number,
      state: g.state, // unstarted | inProgress | completed | unneeded
      // Valorant trả [{id, side:"blue"|"red"}] cho từng map; LoL không có field này.
      teams: g.teams ?? [],
      vods: g.vods ?? [],
    }));
    normalized.streams = (event.streams ?? []).map((s) => ({
      provider: s.provider,
      parameter: s.parameter,
      locale: s.locale,
    }));
    normalized.state = deriveState(normalized.games, normalized);

    if (enrich) {
      const scheduled = await findScheduledEvent(matchId).catch(() => null);
      if (scheduled) {
        normalized.startTime ??= scheduled.startTime;
        normalized.blockName ??= scheduled.blockName;
        normalized.state = scheduled.state ?? normalized.state;
        normalized.strategy = scheduled.strategy ?? normalized.strategy;
        for (const team of normalized.teams) {
          team.record ??= scheduled.teams.find((t) => t.id === team.id || t.code === team.code)?.record ?? null;
        }
      }
    }

    return normalized;
  }

  /** Tìm trận trong getLive (nhẹ) rồi mới tới getSchedule. */
  async function findScheduledEvent(matchId) {
    const id = String(matchId);

    // Ở chế độ 'derive', getLive() CHÍNH LÀ getSchedule() đã lọc — dò trước ở đó
    // chỉ tổ bắn hai request y hệt nhau.
    if (live === 'native') {
      const fromLive = await getLive();
      const hit = fromLive.find((e) => e.id === id);
      if (hit) return hit;
    }

    const { events } = await getSchedule();
    return events.find((e) => e.id === id) ?? null;
  }

  /**
   * Bảng xếp hạng của một giai đoạn giải.
   *
   * Vòng loại trực tiếp thì `rankings` RỖNG — đúng bản chất, knockout không có
   * bảng. Chỗ gọi phải phân biệt "rỗng vì knockout" với "lỗi", đừng hiện bảng
   * trắng như thể mất dữ liệu.
   *
   * Hai game trả cấu trúc lồng khác nhau nên đi dò phòng thủ thay vì bám cứng
   * đường dẫn.
   */
  async function getStandings({ tournamentId } = {}) {
    if (!tournamentId) return [];
    const data = await gw('getStandings', { tournamentId });

    const out = [];
    for (const standing of data?.data?.standings ?? []) {
      for (const stage of standing.stages ?? []) {
        for (const section of stage.sections ?? []) {
          out.push({
            stage: stage.name ?? null,
            section: section.name ?? null,
            rankings: (section.rankings ?? []).map((r) => ({
              ordinal: r.ordinal,
              teams: (r.teams ?? []).map((t) => ({
                id: t.id ?? null,
                name: t.name ?? 'TBD',
                code: t.code ?? '???',
                image: secureUrl(t.image),
                record: t.record ?? null,
              })),
            })),
          });
        }
      }
    }
    return out;
  }

  /**
   * Các trận đã qua của một giải, lấy bằng cách lật `pages.older` về quá khứ.
   *
   * Cố ý KHÔNG dùng `getCompletedEvents`: nó tồn tại cho LoL nhưng Valorant trả
   * 400, lại phải xin `getTournamentsForLeague` (Valorant cũng 400) để biết id
   * từng split. Lật trang lịch chạy cho cả hai game, và đo thực tế còn sâu hơn —
   * 5 trang phủ khoảng hai năm.
   */
  async function getLeagueHistory({ leagueId, pages = 5, signal, onPage } = {}) {
    if (!leagueId) return [];

    const out = [];
    let pageToken;
    for (let page = 0; page < pages; page++) {
      if (signal?.aborted) break;
      const { events, pages: nav } = await getSchedule({ leagueId, pageToken });
      out.push(...events);
      // Các trang phải lấy tuần tự vì trang sau cần token của trang trước, không
      // song song hoá được — nên báo tiến độ để mấy giây chờ đỡ mù.
      onPage?.({ page: page + 1, of: pages, events: out.length });
      if (!nav?.older || !events.length) break;
      pageToken = nav.older;
    }
    return out;
  }

  return {
    id,
    name,
    emoji,
    capabilities,
    terms,
    normalizeEvent,
    getLeagues,
    getSchedule,
    getUpcoming,
    getLive,
    getMatch,
    getStandings,
    getLeagueHistory,
  };
}

/**
 * Ai thắng một trận đã xong.
 *
 * Phải so `wins` (gameWins) chứ KHÔNG đọc `outcome`: dữ liệu quá khứ lấy qua
 * `getSchedule` không có `outcome` (đã kiểm chứng — luôn null), nên tin vào nó là
 * ra kết quả rỗng mà không báo lỗi gì.
 */
export function winnerCode(event) {
  const [a, b] = event.teams ?? [];
  if (!a || !b || a.wins === b.wins) return null;
  return a.wins > b.wins ? a.code : b.code;
}

/**
 * Gom lịch sử một giải thành phần nhận định trước trận: đối đầu, tỉ số đối đầu,
 * và phong độ gần đây của từng đội.
 *
 * Khớp đội theo `code` chứ KHÔNG theo `id`: dữ liệu quá khứ không kèm `id` đội
 * (đã kiểm chứng — `id` luôn undefined), khớp theo id sẽ ra 0 kết quả trong im
 * lặng. `code` chỉ cần duy nhất trong phạm vi một giải, và ở đây đúng như vậy.
 */
export function summariseMatchup(events, codeA, codeB, { formSize = 5 } = {}) {
  const done = (events ?? [])
    .filter((e) => e.state === 'completed' && (e.teams ?? []).length === 2)
    .sort((x, y) => Date.parse(y.startTime) - Date.parse(x.startTime));

  const meetings = done.filter((e) => {
    const codes = e.teams.map((t) => t.code);
    return codes.includes(codeA) && codes.includes(codeB);
  });

  const score = { [codeA]: 0, [codeB]: 0 };
  for (const m of meetings) {
    const w = winnerCode(m);
    if (w in score) score[w] += 1;
  }

  const formOf = (code) =>
    done
      .filter((e) => e.teams.some((t) => t.code === code))
      .slice(0, formSize)
      .map((e) => {
        const self = e.teams.find((t) => t.code === code);
        const other = e.teams.find((t) => t.code !== code);
        return {
          win: winnerCode(e) === code,
          at: e.startTime,
          opponent: other?.code ?? '???',
          score: `${self?.wins ?? 0}–${other?.wins ?? 0}`,
        };
      });

  return {
    meetings,
    score,
    form: { [codeA]: formOf(codeA), [codeB]: formOf(codeB) },
    scanned: done.length,
  };
}

/**
 * Suy trạng thái series từ danh sách ván.
 *
 * Hai cái bẫy, cả hai đều do Valorant lộ ra nhưng LoL Bo5 cũng dính:
 *
 * 1. Map không phải đá trong Bo3/Bo5 mang state `"unneeded"`, không phải
 *    `"unstarted"`. Kiểm tra `every(state === 'completed')` sẽ khiến một Bo3
 *    thắng 2–0 KHÔNG BAO GIỜ ra `completed`. Nên phải loại `unneeded` ra trước.
 * 2. Có lúc Riot chưa kịp lật map cuối sang `unneeded` — series đã xong nhưng map
 *    còn lại vẫn `unstarted`, suy theo map sẽ ra "đang diễn ra" mãi. Đủ số ván
 *    thắng thì chốt luôn, không cần đợi map.
 */
export function deriveState(games, { teams = [], strategy } = {}) {
  const played = games.filter((g) => g.state !== 'unneeded');
  if (!played.length) return 'unstarted';

  const needed = Math.ceil((strategy?.count ?? 1) / 2);
  if (teams.some((t) => (t.wins ?? 0) >= needed)) return 'completed';

  if (played.some((g) => g.state === 'inProgress')) return 'inProgress';
  if (played.every((g) => g.state === 'completed')) return 'completed';
  return played.some((g) => g.state === 'completed') ? 'inProgress' : 'unstarted';
}
