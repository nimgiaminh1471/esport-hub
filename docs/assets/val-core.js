/**
 * val-core.js — phần riêng của VALORANT.
 *
 * Valorant chạy trên CÙNG gateway esports của Riot với LoL, cùng API key public,
 * cùng `Access-Control-Allow-Origin: *`, và trả về cùng một shape event. Khác
 * biệt duy nhất là host và query param `sport=val`. Nên gần như toàn bộ file này
 * chỉ là một lời gọi `createRiotGateway`.
 *
 * HAI GIỚI HẠN CỦA RIOT — đã kiểm chứng bằng request thật, không phải phỏng đoán:
 *
 * 1. **Không tồn tại feed livestats cho Valorant.** `feed.valorantesports.com`
 *    không phân giải được DNS, còn feed của LoL trả 204 cho mọi gameId Valorant.
 *    Không có chỉ số trong trận, không có timeline, không có gì cả. Đây là giới
 *    hạn VĨNH VIỄN, không phải "chưa làm" — đừng đi tìm endpoint khác.
 *    Vì vậy `capabilities.liveStats = false` và các hàm chỉ số đều trả `null`.
 *
 * 2. **Không có endpoint `getLive`.** Mọi biến thể đều trả 400. Nên dùng
 *    `live: 'derive'` để lọc từ trang lịch (xem `riot-core.js`).
 *
 * Ngoài ra `getEventDetails` KHÔNG trả tên map (Bind/Haven/...), chỉ có
 * `{number, id, state, teams[{id, side}]}` — nên UI chỉ hiển thị được "Map 1/2/3",
 * đừng bịa tên map ra.
 */
import { createRiotGateway } from './riot-core.js';

const VAL_API = 'https://esports-api.service.valorantesports.com/persisted/val';

const gateway = createRiotGateway({
  id: 'val',
  name: 'VALORANT',
  emoji: ':dart:',
  base: VAL_API,
  sport: 'val',
  live: 'derive',
  capabilities: { liveStats: false, feedDelaySeconds: null },
  terms: { unit: 'Map' },
});

export const {
  normalizeEvent,
  getLeagues,
  getSchedule,
  getUpcoming,
  getLive,
  getMatch,
} = gateway;

/* ------------------------------------------------------------------- stubs */

/**
 * Các hàm chỉ số trả rỗng thay vì biến mất hẳn.
 *
 * Mọi chỗ gọi trong repo đã null-guard sẵn (vì với LoL, Riot trả 204 cho ván chưa
 * bắt đầu), nên Valorant chỉ đơn giản là "luôn ở nhánh null" — không chỗ nào phải
 * sửa để khỏi crash. Nếu bỏ hẳn các hàm này thì mọi chỗ gọi lại phải thêm `?.`,
 * tức là nhiều thay đổi hơn chứ không ít hơn.
 *
 * Còn việc hiển thị đúng thông điệp ("Riot không có feed cho Valorant" thay vì
 * "ván chưa bắt đầu") là việc của `capabilities.liveStats`.
 */
export async function getWindow() {
  return null;
}

export async function getDetails() {
  return null;
}

export async function getGameSnapshot() {
  return null;
}

export async function getGameStart() {
  return null;
}

export async function getTimeline() {
  return [];
}

/** Không có feed thì cũng không có khái niệm "giải bị tắt stats". */
export function isStatsDisabled() {
  return false;
}

/* ---------------------------------------------------------------- provider */

/** Interface đầy đủ của game — xem định nghĩa chuẩn ở `docs/assets/games.js`. */
export const valProvider = {
  ...gateway,
  getGameSnapshot,
  getGameStart,
  getTimeline,
  getWindow,
  getDetails,
  isStatsDisabled,
};

export default valProvider;
