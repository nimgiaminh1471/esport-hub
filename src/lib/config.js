/** Đọc cấu hình từ biến môi trường + config/leagues.json. */
import { readFile } from 'node:fs/promises';
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

let leaguesPromise = null;

export function loadLeagueFilter() {
  leaguesPromise ??= readFile(resolve(ROOT, 'config/leagues.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ mode: 'all', exclude: [] }));
  return leaguesPromise;
}

/**
 * `mode: "all"` = nhận tất cả trừ `exclude`; `mode: "include"` = chỉ nhận `include`.
 *
 * Cấu hình riêng từng game nằm ở `games.<id>`; không khai báo thì rơi về cấu hình
 * gốc ở cấp cao nhất — nên khi file chưa có key `games`, hành vi của LoL y hệt
 * như trước, chứng minh được chứ không phải "chắc là không sao".
 */
export async function makeLeagueFilter(game = 'lol') {
  const root = await loadLeagueFilter();
  const cfg = root.games?.[game] ?? root;
  const exclude = new Set(cfg.exclude ?? []);
  const include = new Set(cfg.include ?? []);
  return (event) => {
    const slug = event.league?.slug;
    if (cfg.mode === 'include') return include.has(slug);
    return !exclude.has(slug);
  };
}

export function assertSlackConfigured() {
  if (config.dryRun) return;
  const missing = ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Thiếu biến môi trường: ${missing.join(', ')}. Đặt DRY_RUN=1 để chạy thử không cần Slack.`);
  }
}
