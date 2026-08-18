/**
 * day.js — chốt lãi theo ngày và cất vào Cloudflare KV.
 *
 * MỘT KHOÁ MỘT NGÀY (`d:YYYY-MM-DD`). Ở đây gom cả ngày vào một khoá là an toàn,
 * khác hẳn sổ nhập tay: chỉ cron ghi, mỗi ngày ghi đúng một lần, không có cảnh
 * hai người cùng ghi rồi đè mất nhau. Tiền tố `d:` tách hẳn khỏi `e:` của sổ tay
 * nên `listPeriod` bên `note.js` không bị ảnh hưởng.
 *
 * Tổng kết nằm ở `metadata` (giới hạn 1024 byte) còn danh sách vị thế nằm ở
 * VALUE: `list()` trả kèm metadata nên đọc tổng kết cả tháng chỉ tốn một lời gọi,
 * còn chi tiết chỉ tải khi thật sự mở ra xem.
 *
 * Chạy thử bằng Node mà không cần KV: thay `env.NOTE` bằng một object bọc `Map`
 * có `get`/`put`/`list`/`getWithMetadata`.
 */
import { getSettledPositions, getWalletAddress } from './binance.js';
import {
  dayBounds,
  dayOf,
  recentDays,
  shareFrom,
  shiftDay,
  splitDay,
  summariseDays,
  today,
} from './day-core.js';

const KEY = (day) => `d:${day}`;

/** Rà ngược tối đa bấy nhiêu ngày mỗi lần cron chạy. */
const BACKLOG_DAYS = 7;

/**
 * Chỉ giữ lại các trường thật sự dùng để hiển thị và đối chiếu.
 *
 * Cất nguyên payload của Binance thì mỗi lần họ thêm trường là dung lượng phình
 * ra, mà sổ chỉ cần đúng chừng này để trả lời câu "số này ở đâu ra".
 */
const slim = (p) => ({
  marketTitle: p.marketTitle ?? p.marketTopicTitle ?? null,
  outcomeName: p.outcomeName ?? null,
  shares: p.shares ?? null,
  avgPrice: p.avgPrice ?? null,
  realizedPnl: p.realizedPnl ?? p.pnl ?? null,
  isWinner: p.isWinner ?? null,
  settledDate: p.settledDate ?? null,
});

/* ------------------------------------------------------------------- đọc */

/** Tổng kết một ngày đã chốt, hoặc `null` nếu chưa chốt. */
export async function getDay(env, day) {
  const { metadata } = await env.NOTE.getWithMetadata(KEY(day));
  return metadata ?? null;
}

/** Danh sách vị thế của một ngày đã chốt. Chưa chốt thì `[]`. */
export async function getDayPositions(env, day) {
  const raw = await env.NOTE.get(KEY(day));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    // Value hỏng thì vẫn còn tổng kết ở metadata — mất chi tiết còn hơn mất cả ngày.
    return [];
  }
}

/** Các ngày đã chốt trong một tháng `YYYY-MM`, cũ trước mới sau. */
export async function listDays(env, month) {
  const { keys } = await env.NOTE.list({ prefix: `d:${month}` });
  return keys
    .map((k) => ({ day: k.name.slice(2), ...(k.metadata ?? {}) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/* ------------------------------------------------------------------ chốt */

/**
 * Cộng lãi đã chốt của một ngày từ Binance, chưa ghi gì cả.
 *
 * Tách riêng khỏi `settleDay` để `/note today` xem được ngày đang chạy mà không
 * vô tình chốt sớm một ngày còn chưa hết.
 */
export async function computeDay(env, day) {
  const address = await getWalletAddress(env);
  const { startMs, endMs } = dayBounds(day);
  const positions = await getSettledPositions(env, address, { startMs, endMs });

  return { day, positions, ...splitDay(positions, shareFrom(env)) };
}

/**
 * Chốt một ngày và ghi vào KV.
 *
 * ĐÃ CÓ KHOÁ THÌ TRẢ VỀ LUÔN, không ghi đè. Cloudflare có thể gọi lại cùng một
 * nhịp cron, và ghi đè nghĩa là đăng Slack lần hai cho một ngày đã chốt xong —
 * đúng kiểu hỏng mà `state/announced.json` bên GitHub Actions đã né bằng cách so
 * với trạng thái đã lưu thay vì suy ra từ thời gian.
 *
 * @returns {{row: object, created: boolean}}
 */
export async function settleDay(env, day, { force = false } = {}) {
  const existing = await getDay(env, day);
  if (existing && !force) return { row: existing, created: false };

  if (day >= today()) {
    throw new Error(`Ngày ${day} chưa kết thúc theo giờ VN, chưa chốt được.`);
  }

  const { positions, ...summary } = await computeDay(env, day);
  const row = { day, ...summary, settledAt: new Date().toISOString() };

  await env.NOTE.put(KEY(day), JSON.stringify(positions.map(slim)), { metadata: row });
  return { row, created: true };
}

/**
 * Chốt mọi ngày còn thiếu trong khoảng gần đây, mới nhất chốt sau cùng.
 *
 * Vì sao rà ngược thay vì chỉ chốt "hôm qua": cron lỡ nhịp là chuyện thường, và
 * một lần lỡ mà chỉ chốt hôm qua thì ngày bị bỏ sẽ vĩnh viễn trống mà không báo
 * gì. Rà ngược thì lỡ nhịp chỉ làm tổng kết tới muộn.
 *
 * Một ngày lỗi không được làm hỏng cả lượt: gom lỗi lại trả về để chỗ gọi ghi log,
 * còn các ngày khác vẫn chốt xong.
 *
 * @returns {{created: object[], errors: {day: string, message: string}[]}}
 */
export async function settleBacklog(env, { days = BACKLOG_DAYS, from = shiftDay(today(), -1) } = {}) {
  const created = [];
  const errors = [];

  // Cũ trước mới sau để tin Slack lên đúng thứ tự thời gian.
  for (const day of recentDays(from, days).reverse()) {
    try {
      const { row, created: isNew } = await settleDay(env, day);
      if (isNew) created.push(row);
    } catch (err) {
      errors.push({ day, message: err.message });
    }
  }

  return { created, errors };
}

/* -------------------------------------------------------------- tổng hợp */

/** Dữ liệu phần "theo ngày" cho trang xem và `/note.json`. */
export async function daySnapshot(env, month = today().slice(0, 7)) {
  const rows = await listDays(env, month);
  return { month, days: rows, total: summariseDays(rows) };
}

export { dayOf, shiftDay, today };
