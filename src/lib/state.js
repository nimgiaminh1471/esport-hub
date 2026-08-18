/**
 * Trạng thái đã thông báo, lưu thành file JSON và được GitHub Actions commit
 * ngược về repo.
 *
 * Đây là thứ giữ cho bot không gửi trùng: cron của GitHub chạy trễ 5–15 phút là
 * chuyện thường, nên không thể dựa vào "lần chạy này ứng với cửa sổ thời gian
 * kia". Thay vào đó, mỗi trận được nhớ theo trạng thái đã báo lần trước, và chỉ
 * báo khi trạng thái thực sự đổi.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ROOT } from './config.js';

const KEEP_DAYS = 7;

/**
 * Mỗi game một file riêng, không gộp chung một map.
 *
 * Gộp chung thì `prune()` của game này sẽ xoá nhầm entry của game kia, và nếu về
 * sau ai đó tách workflow ra chạy song song thì hai tiến trình ghi đè lẫn nhau.
 * LoL giữ nguyên đường cũ `state/announced.json` để file đã commit trong repo
 * không phải migrate gì.
 */
const statePath = (game) =>
  resolve(ROOT, game === 'lol' ? 'state/announced.json' : `state/announced-${game}.json`);

export async function loadState(game = 'lol') {
  try {
    const parsed = JSON.parse(await readFile(statePath(game), 'utf8'));
    return { version: 1, game, matches: {}, ...parsed };
  } catch {
    return { version: 1, game, matches: {} };
  }
}

/** Chỉ ghi khi nội dung thực sự đổi, để Actions không tạo commit rỗng mỗi 5 phút. */
export async function saveState(game, state) {
  prune(state);
  const path = statePath(game);
  const next = `${JSON.stringify(state, null, 2)}\n`;
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === next) return false;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return true;
}

function prune(state) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.matches)) {
    if (Date.parse(entry.updatedAt ?? entry.announcedAt ?? '') < cutoff) delete state.matches[id];
  }
}

export const getEntry = (state, matchId) => state.matches[String(matchId)] ?? null;

export function setEntry(state, matchId, patch) {
  const id = String(matchId);
  state.matches[id] = {
    ...(state.matches[id] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return state.matches[id];
}
