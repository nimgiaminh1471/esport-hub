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
  if (!data.ok) throw new Error(`Slack từ chối: ${data.error}${data.errors ? ` ${JSON.stringify(data.errors)}` : ''}`);
  return { ts: data.ts };
}
