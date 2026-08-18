/**
 * slack-post.js — đăng tin vào kênh từ Worker.
 *
 * Vì sao không import `src/slack.js` cho khỏi viết hai lần: file đó import
 * `src/lib/config.js`, mà `config.js` dùng `node:url` + `node:path` — Worker
 * không bundle được. Đây là lớp mỏng nhất có thể, chỉ `chat.postMessage`.
 *
 * Khác `src/slack.js` ở một điểm nữa: không có `DRY_RUN`. Muốn thử mà không gửi
 * thật thì bỏ trống `SLACK_BOT_TOKEN` trong `worker/.dev.vars` — hàm sẽ báo thiếu
 * cấu hình và trả `null` thay vì ném lỗi, để cron local vẫn chạy hết lượt.
 */

const API = 'https://slack.com/api/chat.postMessage';

/**
 * @returns {Promise<{ts: string} | null>} `null` khi chưa cấu hình Slack.
 */
export async function postToChannel(env, { text, blocks }) {
  if (!env?.SLACK_BOT_TOKEN || !env?.SLACK_CHANNEL_ID) {
    console.warn('Chưa cấu hình SLACK_BOT_TOKEN / SLACK_CHANNEL_ID — bỏ qua bước gửi Slack.');
    return null;
  }

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL_ID,
      text, // fallback cho thông báo đẩy và trình đọc màn hình
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  // Slack trả HTTP 200 kể cả khi lỗi — phải xem cờ `ok` mới biết.
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack từ chối: ${data.error}${data.needed ? ` (cần: ${data.needed})` : ''}`);
  return { ts: data.ts };
}
