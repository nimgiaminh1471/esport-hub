/** Lớp mỏng bọc Slack Web API. Chỉ cần chat.postMessage nên không kéo SDK về. */
import { config } from './lib/config.js';

const API = 'https://slack.com/api';

/**
 * @returns {Promise<{ts: string} | null>} `ts` để về sau reply đúng thread.
 *   Trả `null` khi chạy DRY_RUN.
 */
export async function postMessage({ text, blocks, threadTs }) {
  const payload = {
    channel: config.slackChannel,
    text, // fallback cho thông báo đẩy và trình đọc màn hình
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  };

  if (config.dryRun) {
    console.log(`\n--- [DRY_RUN] ${threadTs ? `reply → ${threadTs}` : 'tin mới'} ---`);
    console.log(text);
    console.log(JSON.stringify(blocks, null, 2));
    return null;
  }

  const res = await fetch(`${API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.slackToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json();
  // Slack trả HTTP 200 kể cả khi lỗi — phải xem cờ `ok` mới biết.
  if (!data.ok) throw new Error(describeError(data));
  return { ts: data.ts };
}

/**
 * Log của cron là thứ duy nhất người sửa nhìn thấy, nên nhét luôn cách khắc phục
 * vào message. Riêng `missing_scope` Slack có trả kèm `needed`/`provided` —
 * không in ra thì không biết thiếu scope nào.
 */
function describeError(data) {
  const hints = {
    missing_scope: 'thêm scope vào Bot Token Scopes rồi CÀI LẠI app vào workspace (token đổi -> cập nhật secret SLACK_BOT_TOKEN)',
    invalid_auth: 'token sai hoặc đã bị thu hồi — tạo lại và cập nhật secret SLACK_BOT_TOKEN',
    not_in_channel: `mời bot vào kênh: /invite @<tên bot> trong ${config.slackChannel}`,
    channel_not_found: `SLACK_CHANNEL_ID sai, hoặc kênh riêng tư mà bot chưa được mời (${config.slackChannel})`,
    invalid_blocks: 'Block Kit sai định dạng — chạy npm run notify:dry để xem payload',
  };
  const detail = [
    data.needed ? `cần: ${data.needed}` : null,
    data.provided ? `đang có: ${data.provided}` : null,
    data.errors ? JSON.stringify(data.errors) : null,
    hints[data.error] ?? null,
  ].filter(Boolean);
  return `Slack từ chối: ${data.error}${detail.length ? ` (${detail.join(' · ')})` : ''}`;
}
