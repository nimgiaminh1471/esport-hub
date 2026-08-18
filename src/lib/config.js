/** Đọc cấu hình từ biến môi trường. Bộ lọc giải xem `docs/assets/leagues.js`. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const config = {
  slackToken: process.env.SLACK_BOT_TOKEN ?? '',
  slackChannel: process.env.SLACK_CHANNEL_ID ?? '',
  pagesBaseUrl: (process.env.PAGES_BASE_URL ?? '').replace(/\/+$/, ''),
  /** Báo trước bao nhiêu phút. Cửa sổ phải rộng hơn chu kỳ cron để cron trễ vẫn không mất tin. */
  leadMinutes: Number(process.env.LEAD_MINUTES ?? 30),
  dryRun: process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',
  /**
   * Giới hạn chỉ chạy vài game: `GAME=val` hoặc `GAME=lol,val`.
   * Rỗng = chạy mọi game đã đăng ký trong registry — nhờ vậy thêm game mới
   * không phải sửa workflow.
   */
  games: (process.env.GAME ?? '').split(/[,\s]+/).filter(Boolean),
};

/**
 * Link tới trang chi tiết trận.
 *
 * `?game=` ĐÃ bị dùng cho id ván (xem `docs/assets/match-page.js`) và có trong
 * tài liệu README, nên môn thể thao phải đi bằng `?sport=` — đúng tên Riot đặt
 * trong API. LoL không gắn gì để mọi link cũ giữ nguyên từng byte.
 */
export function matchUrl(matchId, game = 'lol') {
  if (!config.pagesBaseUrl) return null;
  const sport = game && game !== 'lol' ? `&sport=${encodeURIComponent(game)}` : '';
  return `${config.pagesBaseUrl}/match.html?match=${encodeURIComponent(matchId)}${sport}`;
}

/**
 * Bộ lọc giải nằm ở `docs/assets/leagues.js`, không phải ở đây.
 *
 * Lý do: Worker và trình duyệt cũng cần đúng bộ lọc đó, mà file này dùng
 * `node:fs` nên Worker không import được, còn `config/` thì trình duyệt không
 * tải được (GitHub Pages chỉ phục vụ `docs/`). Re-export lại để `src/` giữ
 * nguyên đường import quen thuộc.
 */
export { makeLeagueFilter, filterByLeague, unknownSlugs } from '../../docs/assets/leagues.js';

export function assertSlackConfigured() {
  if (config.dryRun) return;
  const missing = ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Thiếu biến môi trường: ${missing.join(', ')}. Đặt DRY_RUN=1 để chạy thử không cần Slack.`);
  }
}
