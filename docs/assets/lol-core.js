/**
 * lol-core.js — phần riêng của League of Legends.
 *
 * Lịch, giải và chi tiết trận chạy trên gateway chung của Riot nên nằm ở
 * `riot-core.js`; file này chỉ còn phần LoL mới có: **feed livestats** (vàng, hạ
 * gục, trụ, rồng, KDA/CS từng người). Valorant không có feed tương đương.
 *
 * Vẫn là ESM thuần, chỉ dùng `fetch` toàn cục nên chạy được ở CẢ HAI nơi:
 *   - browser  (trang GitHub Pages import trực tiếp)
 *   - Node 22+ (src/providers/lol.js import qua đường dẫn tương đối)
 *
 * API của Riot là API nội bộ, không có cam kết ổn định. Nhưng nó trả
 * `Access-Control-Allow-Origin: *` nên trang tĩnh gọi thẳng được, không cần backend.
 */
import { createRiotGateway, fetchJson, API_KEY, secureUrl } from './riot-core.js';

export { API_KEY, secureUrl };

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

/**
 * Một số giải (regional/academy — ví dụ north_regional_league) bị Riot tắt hẳn
 * livestats: mọi request kèm `startingTime` trả về
 *   404 RESOURCE_NOT_FOUND "Stats are disabled for game EsportsGameId{...}".
 * Bẫy ở đây: request KHÔNG kèm `startingTime` vẫn trả 200 — nhưng đó là frame
 * đầu ván toàn số 0 (xem `getWindow`). Nên tuyệt đối không được "chữa" 404 bằng
 * cách bỏ `startingTime` đi: UI sẽ hiện 0/0/0 như thể là số liệu thật.
 * Coi ván đó là không có dữ liệu và nhớ lại để chỗ gọi khỏi poll 404 mỗi 10 giây.
 */
const statsDisabledGames = new Set();

/** Ván bị Riot tắt livestats (đã phát hiện qua một request trước đó). */
export function isStatsDisabled(gameId) {
  return statsDisabledGames.has(String(gameId));
}

/* ------------------------------------------------------- lịch / giải / trận */

const gateway = createRiotGateway({
  id: 'lol',
  name: 'League of Legends',
  emoji: ':video_game:',
  base: ESPORTS_API,
  live: 'native',
  capabilities: { liveStats: true, feedDelaySeconds: FEED_DELAY_SECONDS },
  terms: { unit: 'Ván' },
});

export const {
  normalizeEvent,
  getLeagues,
  getSchedule,
  getUpcoming,
  getLive,
  getMatch,
} = gateway;

/* ---------------------------------------------------------- feed livestats */

/**
 * Feed chỉ nhận timestamp là bội số của 10 giây và không có mili-giây;
 * đưa giờ hiện tại vào sẽ bị 400 vì frame chưa tồn tại, nên lùi lại
 * FEED_DELAY_SECONDS.
 */
export function feedTimestamp(date = new Date(), { lagSeconds = FEED_DELAY_SECONDS } = {}) {
  const ms = date.getTime() - lagSeconds * 1000;
  return new Date(Math.floor(ms / 10000) * 10000).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  if (isStatsDisabled(gameId)) return null;

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
    } else if (err.status === 404 && /stats are disabled/i.test(err.message)) {
      // Ván có thật nhưng Riot không mở livestats — "không có dữ liệu", không phải lỗi.
      // 404 "does not exist" (id sai) thì vẫn ném ra để chỗ gọi báo sai ID.
      statsDisabledGames.add(String(gameId));
      return null;
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

/** Interface đầy đủ của game — xem định nghĩa chuẩn ở `docs/assets/games.js`. */
export const lolProvider = {
  ...gateway,
  getGameSnapshot,
  getGameStart,
  getTimeline,
  getWindow,
  getDetails,
  isStatsDisabled,
};

export default lolProvider;
