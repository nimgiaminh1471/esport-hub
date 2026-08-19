/**
 * day.js — sổ chốt theo ngày, lưu trong Cloudflare KV.
 *
 * MỘT KHOÁ MỘT NGÀY (`d:YYYY-MM-DD`). Ở đây gom cả ngày vào một khoá là an toàn,
 * khác hẳn sổ nhập tay theo dòng: mỗi ngày chỉ ghi đúng một con số tổng, không có
 * cảnh hai dòng nhập sát nhau rồi đè mất nhau. Tiền tố `d:` tách hẳn khỏi `e:`
 * của sổ dòng nên `listPeriod` bên `note.js` không bị ảnh hưởng.
 *
 * Số liệu do người gõ vào, không lấy từ đâu về: đọc lãi qua API sàn đòi một khoá
 * có quyền giao dịch, mà khoá kiểu đó hết hạn sau 90 ngày nếu không khoá theo IP —
 * Worker lại không có IP cố định để khoá. Đổi lại quy trình phải nhớ gõ.
 *
 * Chạy thử bằng Node mà không cần KV: thay `env.NOTE` bằng một object bọc `Map`
 * có `get`/`put`/`list`/`getWithMetadata`.
 */
import { dayOf, shareFrom, shiftDay, splitAmount, summariseDays, today } from './day-core.js';

const KEY = (day) => `d:${day}`;

/** Ghi chú kèm theo một ngày. Metadata của KV tối đa 1024 byte, chừa biên rộng. */
const MAX_NOTE_LEN = 200;

/* ------------------------------------------------------------------- đọc */

/** Một ngày đã chốt, hoặc `null` nếu chưa. */
export async function getDay(env, day) {
  const { metadata } = await env.NOTE.getWithMetadata(KEY(day));
  return metadata ?? null;
}

/** Các ngày đã chốt trong một tháng `YYYY-MM`, cũ trước mới sau. */
export async function listDays(env, month) {
  const { keys } = await env.NOTE.list({ prefix: `d:${month}` });
  return keys
    .map((k) => ({ day: k.name.slice(2), ...(k.metadata ?? {}) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/* ------------------------------------------------------------------ ghi */

/**
 * Chốt một ngày với con số đã nhập.
 *
 * NGÀY ĐÃ CHỐT KHÔNG TỰ ĐỘNG BỊ ĐÈ — muốn sửa phải nói rõ (`force`). Kênh đã nhận
 * con số cũ rồi; đè im lặng nghĩa là tổng tháng đổi mà không có gì giải thích, mà
 * gõ nhầm ngày là kiểu nhầm dễ xảy ra nhất khi nhập tay.
 *
 * Tỉ lệ chia được LƯU vào chính dòng này, không đọc lại lúc hiển thị: đổi
 * `DOI_TAC_SHARE` sau này mà tính lại thì mọi ngày đã chốt xong tự đổi số, không
 * còn đối chiếu được với lần chia trước. Cùng lý do với `RATE` trong `note-core.js`.
 *
 * @returns {{row: object, truocDo: object | null}} `truocDo` khác null nghĩa là vừa sửa đè.
 */
export async function settleDay(env, day, profitUnits, { force = false, note = null } = {}) {
  if (day > today()) throw new Error(`Ngày ${day} chưa tới.`);

  const existing = await getDay(env, day);
  if (existing && !force) {
    throw new Error(
      `Ngày ${day} đã chốt (${(existing.profitUnits / 100).toFixed(2)}). ` +
        'Thêm `--sua` vào cuối nếu thật sự muốn ghi đè.',
    );
  }

  const row = {
    day,
    ...splitAmount(profitUnits, shareFrom(env)),
    note: note ? note.slice(0, MAX_NOTE_LEN) : null,
    at: new Date().toISOString(),
    // Giữ lại dấu vết đã sửa để sau này nhìn dòng là biết, khỏi phải lần ra tin Slack cũ.
    ...(existing ? { suaTu: existing.profitUnits } : {}),
  };

  await env.NOTE.put(KEY(day), '', { metadata: row });
  return { row, truocDo: existing };
}

/** Xoá hẳn một ngày khỏi sổ. Dùng khi chốt nhầm ngày chứ không phải nhầm số. */
export async function removeDay(env, day) {
  const existing = await getDay(env, day);
  if (!existing) return null;
  await env.NOTE.delete(KEY(day));
  return existing;
}

/* -------------------------------------------------------------- tổng hợp */

/** Dữ liệu phần "theo ngày" cho trang xem và `/note.json`. */
export async function daySnapshot(env, month = today().slice(0, 7)) {
  const rows = await listDays(env, month);
  return { month, days: rows, total: summariseDays(rows) };
}

export { dayOf, shiftDay, today };
