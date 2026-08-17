/**
 * Registry provider theo game.
 *
 * Thêm game mới:
 *   1. Viết `docs/assets/<game>-core.js` export đúng interface của lol-core.js
 *      (getUpcoming, getLive, getMatch, getGameSnapshot, getLeagues, getSchedule).
 *   2. Tạo `src/providers/<game>.js` re-export core đó.
 *   3. Thêm một dòng vào đây.
 * Không phần nào khác của bot cần sửa.
 */
import lol from './lol.js';

export const providers = { lol };

export const DEFAULT_GAME = 'lol';

export function getProvider(game = DEFAULT_GAME) {
  const provider = providers[game];
  if (!provider) {
    throw new Error(`Chưa hỗ trợ game "${game}". Hiện có: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

export default providers;
