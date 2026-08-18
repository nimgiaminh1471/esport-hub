/**
 * games.js — registry game DUY NHẤT của dự án.
 *
 * Cả ba mặt đều lấy provider từ đây: bot Slack (`src/providers/index.js` re-export
 * lại), Cloudflare Worker (wrangler bundle vào), và trang web (browser import
 * thẳng). File phải nằm trong `docs/` vì đó là thư mục duy nhất cả ba với tới
 * được — browser không import được từ `src/`.
 *
 * ---------------------------------------------------------------------------
 * INTERFACE CỦA MỘT PROVIDER — đây là định nghĩa chuẩn duy nhất.
 * (README.md và CLAUDE.md trỏ về đây, không chép lại, để khỏi lệch nhau.)
 *
 * BẮT BUỘC
 *   id            'lol' | 'val' — trùng với `event.game`
 *   name          tên hiển thị
 *   emoji         emoji Slack
 *   capabilities  { liveStats: boolean, feedDelaySeconds: number|null }
 *   terms         { unit: string } — 'Ván' với LoL, 'Map' với Valorant
 *   getLeagues()                      -> [{id, slug, name, region, image, priority}]
 *   getSchedule({leagueId, pageToken}) -> {events: Event[], pages}      ← LƯU Ý: object
 *   getUpcoming({withinMinutes, limit, now}) -> Event[]
 *   getLive()                          -> Event[]
 *   getMatch(id, {enrich})             -> Event & {games[], streams[]} | null
 *
 * TUỲ CHỌN — chỉ có ý nghĩa khi `capabilities.liveStats === true`
 *   getGameSnapshot(gameId, opts) -> Snapshot | null
 *   getGameStart(gameId)          -> ISO string | null
 *   getTimeline(gameId, opts)     -> Point[]
 *   getWindow / getDetails        -> raw feed | null
 *   isStatsDisabled(gameId)       -> boolean
 *
 * Game không có chỉ số vẫn phải có các hàm tuỳ chọn, trả `null` / `[]` — mọi chỗ
 * gọi đã null-guard sẵn nên không cần `?.` rải khắp nơi. Xem `val-core.js`.
 *
 * Bất đối xứng CÓ CHỦ Ý, đừng "sửa": `getSchedule` trả `{events, pages}` vì chỗ
 * gọi cần `pages` để lật trang, còn `getLive`/`getUpcoming` trả thẳng mảng.
 *
 * ---------------------------------------------------------------------------
 * THÊM GAME MỚI
 *   1. Viết `docs/assets/<game>-core.js` — thường chỉ là một lời gọi
 *      `createRiotGateway({...})` nếu game đó cũng chạy trên gateway của Riot.
 *   2. Thêm một dòng vào `providers` bên dưới.
 *   3. (tuỳ chọn) thêm mục vào `LEAGUE_POLICY` trong `docs/assets/leagues.js`;
 *      không khai báo thì mặc định lấy tất cả giải.
 *   4. (tuỳ chọn) đăng ký slash command `/<game>` trỏ vào ĐÚNG Worker URL cũ.
 *
 * `src/notify.js`, `src/lib/*`, `worker/`, workflow và các trang web không phải
 * sửa gì — lần này là thật.
 */
import lol from './lol-core.js';
import val from './val-core.js';

export const providers = { lol, val };

export const DEFAULT_GAME = 'lol';

/** Tên khác mà người dùng hay gõ (slash command, query param). */
const ALIASES = {
  lol: 'lol',
  lmht: 'lol',
  leagueoflegends: 'lol',
  val: 'val',
  valorant: 'val',
  vlr: 'val',
};

/**
 * Đổi tên người dùng gõ thành id game, `null` nếu không nhận ra.
 *
 * Trả `null` chứ KHÔNG fallback về game mặc định: nếu ai đó đăng ký slash command
 * là `/valorant` mà registry không nhận ra, fallback im lặng sẽ phục vụ dữ liệu
 * LoL dưới một lệnh Valorant — kiểu hỏng tệ nhất vì trông vẫn như đang chạy tốt.
 */
export function resolveGame(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/^\//, '');
  return ALIASES[key] ?? null;
}

export function getProvider(game = DEFAULT_GAME) {
  const provider = providers[resolveGame(game) ?? game];
  if (!provider) {
    throw new Error(`Chưa hỗ trợ game "${game}". Hiện có: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

/* --------------------------------------------------------------- định tuyến web */

/**
 * Môn thể thao đi bằng `?sport=`, KHÔNG phải `?game=`.
 *
 * `?game=` đã được dùng cho id ván từ trước (`match.html?game=<gameId>`, có trong
 * README) nên chiếm nó sẽ âm thầm phá mọi link LoL đang lưu hành. `sport` cũng
 * đúng tên Riot đặt trong API.
 */
export function gameFromSearch(search = '') {
  return resolveGame(new URLSearchParams(search).get('sport')) ?? DEFAULT_GAME;
}

/** Link tương đối tới trang chi tiết trận; game mặc định không gắn gì thêm. */
export function matchHref(matchId, game = DEFAULT_GAME) {
  const sport = game && game !== DEFAULT_GAME ? `&sport=${encodeURIComponent(game)}` : '';
  return `./match.html?match=${encodeURIComponent(matchId)}${sport}`;
}

export default providers;
