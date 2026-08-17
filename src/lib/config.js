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
};

export function matchUrl(matchId) {
  return config.pagesBaseUrl
    ? `${config.pagesBaseUrl}/match.html?match=${encodeURIComponent(matchId)}`
    : null;
}

let leaguesPromise = null;

export function loadLeagueFilter() {
  leaguesPromise ??= readFile(resolve(ROOT, 'config/leagues.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ mode: 'all', exclude: [] }));
  return leaguesPromise;
}

/** `mode: "all"` = nhận tất cả trừ `exclude`; `mode: "include"` = chỉ nhận `include`. */
export async function makeLeagueFilter() {
  const cfg = await loadLeagueFilter();
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
