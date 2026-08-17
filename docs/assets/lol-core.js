/**
 * lol-core.js — toàn bộ chỗ chạm vào API LoL Esports của Riot.
 *
 * File này là ESM thuần, chỉ dùng `fetch` toàn cục nên chạy được ở CẢ HAI nơi:
 *   - browser  (trang GitHub Pages import trực tiếp)
 *   - Node 22+ (src/providers/lol.js import qua đường dẫn tương đối)
 * Nhờ vậy chỉ có một nguồn sự thật. Riot đổi schema thì chỉ phải sửa file này.
 *
 * API của Riot là API nội bộ, không có cam kết ổn định. Nhưng nó trả
 * `Access-Control-Allow-Origin: *` nên trang tĩnh gọi thẳng được, không cần backend.
 */

/** Key public mà chính web lolesports.com dùng — không phải bí mật, không cần giấu. */
export const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const ESPORTS_API = 'https://esports-api.lolesports.com/persisted/gw';
const FEED = 'https://feed.lolesports.com/livestats/v1';

/**
 * Feed livestats bị Riot khoá không cho đọc dữ liệu quá mới (chống ăn gian).
 * Đo thực tế: yêu cầu cửa sổ kết thúc muộn hơn `now - 190s` bị trả về
 *   400 BAD_QUERY_PARAMETER "disallowed window with end time less than 190 sec old".
 * Cửa sổ dài 10s nên startingTime phải <= now - 200s; để dư biên cho lệch đồng hồ
 * máy client, dùng 210s. Nghĩa là số liệu luôn trễ ~3,5 phút so với sóng — đây là
 * giới hạn của Riot, không phải bug, và phải nói rõ trên UI.
 */
export const FEED_DELAY_SECONDS = 210;

/* ------------------------------------------------------------------ helpers */

/**
 * Response của Riot trả ảnh qua `http://static.lolesports.com/...`.
 * GitHub Pages chạy HTTPS nên browser sẽ chặn mixed-content. Host có hỗ trợ
 * HTTPS, chỉ là response ghi sai scheme, nên rewrite là đủ.
 */
export function secureUrl(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url;
}

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} — ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * GET JSON với timeout + retry. Trả `null` khi 204 (feed dùng 204 cho
 * "ván chưa có dữ liệu"), nên chỗ gọi phải phân biệt null với object.
 */
async function fetchJson(url, { headers = {}, timeoutMs = 15000, retries = 2 } = {}) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gwUrl = (path, params = {}) => {
  const qs = new URLSearchParams({ hl: 'en-US', ...clean(params) });
  return `${ESPORTS_API}/${path}?${qs}`;
};

const gw = (path, params) => fetchJson(gwUrl(path, params), { headers: { 'x-api-key': API_KEY } });

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Feed chỉ nhận timestamp là bội số của 10 giây và không có mili-giây;
 * đưa giờ hiện tại vào sẽ bị 400 vì frame chưa tồn tại, nên lùi lại
 * FEED_DELAY_SECONDS.
 */
export function feedTimestamp(date = new Date(), { lagSeconds = FEED_DELAY_SECONDS } = {}) {
  const ms = date.getTime() - lagSeconds * 1000;
  return new Date(Math.floor(ms / 10000) * 10000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------------------- chuẩn hoá dữ liệu */

/**
 * Gom event của Riot về shape chung mà Slack, trang web và các game khác
 * đều dùng được. Provider của game mới chỉ cần trả đúng shape này.
 */
export function normalizeEvent(event) {
  if (!event) return null;
  const match = event.match ?? {};
  return {
    game: 'lol',
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

/* ----------------------------------------------------------------- endpoints */

/** Danh mục giải, dùng để build bộ lọc. */
export async function getLeagues() {
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
 * (vừa completed vừa unstarted). `pageToken` lấy từ `pages.older` / `pages.newer`.
 */
export async function getSchedule({ leagueId, pageToken } = {}) {
  const data = await gw('getSchedule', { leagueId, pageToken });
  const schedule = data?.data?.schedule ?? {};
  return {
    events: (schedule.events ?? []).filter((e) => e.type === 'match').map(normalizeEvent),
    pages: schedule.pages ?? {},
  };
}

/** Các trận đang diễn ra. */
export async function getLive() {
  const data = await gw('getLive');
  return (data?.data?.schedule?.events ?? [])
    .filter((e) => e.type === 'match' || e.match)
    .map(normalizeEvent);
}

/**
 * Trận sắp diễn ra trong `withinMinutes` phút tới, sắp xếp theo giờ bắt đầu.
 * Tự lật sang trang `newer` khi cửa sổ dài hơn dữ liệu trang đầu.
 */
export async function getUpcoming({ withinMinutes = 60, limit = 50, now = Date.now() } = {}) {
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
export async function getMatch(matchId, { enrich = true } = {}) {
  const data = await gw('getEventDetails', { id: matchId });
  const event = data?.data?.event;
  if (!event) return null;

  const normalized = normalizeEvent({ ...event, id: event.id ?? matchId, type: 'match' });
  normalized.id = String(matchId);
  normalized.games = (event.match?.games ?? []).map((g) => ({
    id: String(g.id),
    number: g.number,
    state: g.state, // unstarted | inProgress | completed
    vods: g.vods ?? [],
  }));
  normalized.streams = (event.streams ?? []).map((s) => ({
    provider: s.provider,
    parameter: s.parameter,
    locale: s.locale,
  }));
  normalized.state = deriveState(normalized.games);

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

function deriveState(games) {
  if (!games.length) return 'unstarted';
  if (games.some((g) => g.state === 'inProgress')) return 'inProgress';
  if (games.every((g) => g.state === 'completed')) return 'completed';
  return games.some((g) => g.state === 'completed') ? 'inProgress' : 'unstarted';
}

/** Tìm trận trong getLive (nhẹ) rồi mới tới getSchedule. */
async function findScheduledEvent(matchId) {
  const id = String(matchId);
  const live = await getLive();
  const fromLive = live.find((e) => e.id === id);
  if (fromLive) return fromLive;

  const { events } = await getSchedule();
  return events.find((e) => e.id === id) ?? null;
}

/**
 * Chỉ số live cấp đội + KDA/CS/gold từng người.
 *
 * Lưu ý bẫy lớn: gọi KHÔNG kèm `startingTime` thì Riot trả về frame ở ĐẦU ván
 * (mọi chỉ số bằng 0), chứ không phải trạng thái mới nhất. Vì vậy mặc định ở đây
 * luôn hỏi mốc `now - FEED_DELAY_SECONDS`. Muốn lấy đầu ván thì truyền
 * `fromStart: true`.
 *
 * Với ván đã kết thúc, feed tự kẹp về frame cuối cùng có dữ liệu nên vẫn dùng
 * mốc hiện tại được, không cần biết ván kết thúc lúc nào.
 *
 * Trả `null` nếu ván chưa có dữ liệu (Riot trả 204).
 */
export async function getWindow(gameId, { startingTime, fromStart = false } = {}) {
  return feedGet('window', gameId, { startingTime, fromStart });
}

/** Chỉ số sâu: item, ngọc, damage share, ward. `null` nếu chưa có dữ liệu. */
export async function getDetails(gameId, { startingTime, fromStart = false } = {}) {
  return feedGet('details', gameId, { startingTime, fromStart });
}

async function feedGet(kind, gameId, { startingTime, fromStart }) {
  const t = fromStart ? null : (startingTime ?? feedTimestamp());
  const qs = t ? `?startingTime=${encodeURIComponent(t)}` : '';
  let data;
  try {
    data = await fetchJson(`${FEED}/${kind}/${gameId}${qs}`);
  } catch (err) {
    // Đồng hồ client chạy nhanh -> cửa sổ "quá mới" -> lùi thêm rồi thử lại một lần.
    if (err.status === 400 && t && /end time less than/i.test(err.message)) {
      const retryAt = feedTimestamp(new Date(), { lagSeconds: FEED_DELAY_SECONDS + 120 });
      data = await fetchJson(`${FEED}/${kind}/${gameId}?startingTime=${encodeURIComponent(retryAt)}`);
    } else {
      throw err;
    }
  }
  return data?.frames?.length ? data : null;
}

/**
 * Mốc thời gian của frame đầu tiên có dữ liệu — dùng làm gốc để vẽ biểu đồ.
 * Trả `null` nếu ván chưa bắt đầu.
 */
export async function getGameStart(gameId) {
  const data = await getWindow(gameId, { fromStart: true });
  return data?.frames?.[0]?.rfc460Timestamp ?? null;
}

/**
 * Gộp window + details thành một snapshot phẳng cho UI và Slack.
 * Trả `null` khi ván chưa bắt đầu.
 */
export async function getGameSnapshot(gameId, { startingTime, withDetails = true } = {}) {
  const [window, details] = await Promise.all([
    getWindow(gameId, { startingTime }),
    withDetails ? getDetails(gameId, { startingTime }).catch(() => null) : null,
  ]);
  if (!window) return null;

  const frame = window.frames.at(-1);
  const detailFrame = details?.frames?.at(-1) ?? null;
  const meta = window.gameMetadata;

  const buildSide = (side, metaKey) => {
    const teamMeta = meta[metaKey];
    return {
      esportsTeamId: teamMeta.esportsTeamId,
      totalGold: frame[side].totalGold,
      kills: frame[side].totalKills,
      towers: frame[side].towers,
      inhibitors: frame[side].inhibitors,
      barons: frame[side].barons,
      dragons: frame[side].dragons ?? [],
      participants: teamMeta.participantMetadata.map((pm) => {
        const live = frame[side].participants.find((p) => p.participantId === pm.participantId) ?? {};
        const deep = detailFrame?.participants?.find((p) => p.participantId === pm.participantId) ?? {};
        return {
          participantId: pm.participantId,
          summonerName: pm.summonerName,
          championId: pm.championId,
          role: pm.role,
          level: live.level ?? 0,
          kills: live.kills ?? 0,
          deaths: live.deaths ?? 0,
          assists: live.assists ?? 0,
          creepScore: live.creepScore ?? 0,
          totalGold: live.totalGold ?? 0,
          currentHealth: live.currentHealth ?? 0,
          maxHealth: live.maxHealth ?? 0,
          items: deep.items ?? [],
          perks: deep.perkMetadata ?? null,
          killParticipation: deep.killParticipation ?? null,
          championDamageShare: deep.championDamageShare ?? null,
          wardsPlaced: deep.wardsPlaced ?? null,
          wardsDestroyed: deep.wardsDestroyed ?? null,
          attackDamage: deep.attackDamage ?? null,
          abilityPower: deep.abilityPower ?? null,
        };
      }),
    };
  };

  return {
    gameId: String(window.esportsGameId),
    matchId: String(window.esportsMatchId),
    patch: meta.patchVersion ?? null,
    timestamp: frame.rfc460Timestamp,
    gameState: frame.gameState, // in_game | paused | finished
    blue: buildSide('blueTeam', 'blueTeamMetadata'),
    red: buildSide('redTeam', 'redTeamMetadata'),
    frames: window.frames,
  };
}

/**
 * Dựng chuỗi thời gian gold/kill để vẽ biểu đồ.
 *
 * Mỗi lần gọi `window` chỉ trả một cửa sổ 10 giây, nên phải lấy mẫu nhiều lần.
 * Lấy mẫu mỗi `stepSeconds` từ lúc ván bắt đầu tới mốc mới nhất đọc được, giới hạn
 * `maxSamples` request để không bắn hàng trăm request cho ván dài.
 */
export async function getTimeline(gameId, {
  startTime,
  stepSeconds = 120,
  maxSamples = 40,
  concurrency = 4,
  signal,
} = {}) {
  const startMs = Date.parse(startTime ?? (await getGameStart(gameId)) ?? '');
  if (!Number.isFinite(startMs)) return [];

  // Với ván đã kết thúc, feed kẹp mọi mốc quá khứ về frame cuối cùng — nên một
  // lần hỏi mốc mới nhất là biết ván kết thúc lúc nào. Nếu lấy thẳng "bây giờ"
  // làm mốc cuối thì với ván xong từ nhiều giờ trước, các mẫu sẽ rải hết vào
  // khoảng thời gian chết sau trận và biểu đồ chỉ còn một hai điểm.
  const probe = await getWindow(gameId);
  const endMs = probe?.frames?.at(-1)
    ? Date.parse(probe.frames.at(-1).rfc460Timestamp)
    : Date.parse(feedTimestamp());

  const span = endMs - startMs;
  if (span <= 0) return [];

  // Ván càng dài thì giãn bước lấy mẫu ra để tổng số request không vượt maxSamples.
  const step = Math.max(stepSeconds, Math.ceil(span / 1000 / maxSamples / 10) * 10) * 1000;

  const stamps = [];
  for (let t = startMs; t <= endMs && stamps.length < maxSamples; t += step) {
    stamps.push(feedTimestamp(new Date(t), { lagSeconds: 0 }));
  }

  const points = new Array(stamps.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < stamps.length) {
      const i = cursor++;
      if (signal?.aborted) return;
      try {
        const data = await getWindow(gameId, { startingTime: stamps[i] });
        const frame = data?.frames?.at(-1);
        if (frame) {
          points[i] = {
            timestamp: frame.rfc460Timestamp,
            elapsedSeconds: Math.round((Date.parse(frame.rfc460Timestamp) - startMs) / 1000),
            blueGold: frame.blueTeam.totalGold,
            redGold: frame.redTeam.totalGold,
            blueKills: frame.blueTeam.totalKills,
            redKills: frame.redTeam.totalKills,
          };
        }
      } catch {
        // Một mẫu hỏng chỉ làm biểu đồ thưa hơn, không nên phá cả biểu đồ.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, stamps.length) }, worker));
  return points.filter(Boolean);
}

/* ------------------------------------------------------------------ provider */

/**
 * Interface mà mọi game phải implement. Thêm Valorant/CS2 = thêm một file
 * export đúng các hàm này rồi đăng ký vào providers/index.js.
 */
export const lolProvider = {
  id: 'lol',
  name: 'League of Legends',
  emoji: ':video_game:',
  getLeagues,
  getSchedule,
  getUpcoming,
  getLive,
  getMatch,
  getGameSnapshot,
  getGameStart,
  getTimeline,
};

export default lolProvider;
