/**
 * Cloudflare Worker phục vụ slash command `/lol`.
 *
 * Vì sao cần Worker: slash command bắt buộc phải có một endpoint HTTP trả lời
 * Slack trong 3 giây. GitHub Actions cron không nhận request nên không làm được
 * việc này — nó chỉ lo phần tự động thông báo. Worker chạy miễn phí, không phải
 * duy trì máy chủ, và cũng là chỗ duy nhất cần giữ bí mật (signing secret).
 *
 * Import thẳng lol-core.js và blocks.js của dự án — wrangler tự bundle, nên
 * logic gọi API và dựng Block Kit không bị viết lại lần hai.
 */
import * as lol from '../../docs/assets/lol-core.js';
import { scheduleMessage, matchMessage } from '../../src/lib/blocks.js';

/** Slack huỷ kết nối sau 3s; chốt 2,5s rồi chuyển sang trả lời trễ qua response_url. */
const FAST_PATH_MS = 2500;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Endpoint slash command của Esports Hub. Dùng POST từ Slack.', { status: 405 });
    }

    const raw = await request.text();
    if (!(await verifySlackSignature(request, raw, env.SLACK_SIGNING_SECRET))) {
      return new Response('Chữ ký không hợp lệ', { status: 401 });
    }

    const body = Object.fromEntries(new URLSearchParams(raw));
    const work = handleCommand(body, env).catch((err) => ({
      response_type: 'ephemeral',
      text: `Lỗi khi xử lý lệnh: ${err.message}`,
    }));

    // Trả thẳng nếu kịp; nếu chậm thì báo "đang tra" rồi bắn kết quả vào
    // response_url (Slack cho phép trả trễ trong vòng 30 phút).
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), FAST_PATH_MS));
    const fast = await Promise.race([work, timeout]);

    if (fast) return json(fast);

    ctx.waitUntil(
      work.then((late) =>
        fetch(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(late),
        }),
      ),
    );
    return json({ response_type: 'ephemeral', text: ':hourglass: Đang tra cứu…' });
  },
};

/* ------------------------------------------------------------------ định tuyến */

async function handleCommand(body, env) {
  const args = (body.text ?? '').trim().split(/\s+/).filter(Boolean);

  // `--share` / `công khai` ở bất kỳ đâu trong lệnh sẽ đăng cho cả kênh thấy.
  const shareIndex = args.findIndex((a) => a === '--share' || a === 'share');
  const share = shareIndex !== -1;
  if (share) args.splice(shareIndex, 1);

  const [sub = 'help', ...rest] = args;
  const url = (matchId) =>
    env.PAGES_BASE_URL ? `${env.PAGES_BASE_URL.replace(/\/+$/, '')}/match.html?match=${matchId}` : null;
  const responseType = share ? 'in_channel' : 'ephemeral';

  switch (sub) {
    case 'schedule':
    case 'lich':
    case 'lịch': {
      const hours = Number(rest[0]) || 24;
      const events = await lol.getUpcoming({ withinMinutes: hours * 60, limit: 20 });
      return { response_type: responseType, ...scheduleMessage(events, {
        title: `Lịch thi đấu ${hours} giờ tới`,
        empty: `Không có trận nào trong ${hours} giờ tới.`,
        url,
      }) };
    }

    case 'live':
    case 'dang':
    case 'đang': {
      const events = await lol.getLive();
      return { response_type: responseType, ...scheduleMessage(events, {
        title: 'Trận đang diễn ra',
        empty: 'Hiện không có trận nào đang diễn ra.',
        url,
      }) };
    }

    case 'match':
    case 'tran':
    case 'trận': {
      const id = rest[0];
      if (!/^\d+$/.test(id ?? '')) {
        return { response_type: 'ephemeral', text: 'Cần ID trận dạng số. Ví dụ: `/lol match 116878159559860047`' };
      }

      const match = await lol.getMatch(id);
      if (!match) return { response_type: 'ephemeral', text: `Không tìm thấy trận \`${id}\`.` };

      const playable =
        match.games.find((g) => g.state === 'inProgress') ??
        match.games.findLast((g) => g.state === 'completed');
      const snapshot = playable ? await lol.getGameSnapshot(playable.id, { withDetails: false }).catch(() => null) : null;

      return { response_type: responseType, ...matchMessage(match, snapshot, url(id)) };
    }

    default:
      return {
        response_type: 'ephemeral',
        text: [
          '*Esports Hub — các lệnh*',
          '`/lol schedule [số giờ]` — lịch thi đấu sắp tới (mặc định 24 giờ)',
          '`/lol live` — các trận đang diễn ra',
          '`/lol match <id>` — chi tiết và chỉ số một trận',
          '',
          'Thêm `--share` vào cuối để đăng cho cả kênh thấy thay vì chỉ mình bạn.',
        ].join('\n'),
      };
  }
}

/* ------------------------------------------------------------ xác thực Slack */

/**
 * https://api.slack.com/authentication/verifying-requests-from-slack
 * Kiểm tra timestamp trước để một request cũ bị ghi lại không dùng lại được.
 */
async function verifySlackSignature(request, rawBody, signingSecret) {
  if (!signingSecret) return false;

  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  const expected = `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  return timingSafeEqual(expected, signature);
}

/** So sánh không phụ thuộc thời gian, tránh lộ thông tin qua độ trễ. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (payload) =>
  new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
