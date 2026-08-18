/**
 * Cloudflare Worker phục vụ slash command `/lol` và `/val`.
 *
 * Vì sao cần Worker: slash command bắt buộc phải có một endpoint HTTP trả lời
 * Slack trong 3 giây. GitHub Actions cron không nhận request nên không làm được
 * việc này — nó chỉ lo phần tự động thông báo. Worker chạy miễn phí, không phải
 * duy trì máy chủ, và cũng là chỗ duy nhất cần giữ bí mật (signing secret).
 *
 * Import thẳng registry và blocks.js của dự án — wrangler tự bundle, nên logic
 * gọi API và dựng Block Kit không bị viết lại lần hai.
 *
 * Nhiều game dùng CHUNG một Worker: Slack gửi kèm `body.command` (`/lol` hay
 * `/val`) nên chỉ cần đăng ký thêm slash command trỏ vào ĐÚNG URL cũ, không phải
 * deploy thêm gì.
 */
import { getProvider, resolveGame, DEFAULT_GAME } from '../../docs/assets/games.js';
import { makeLeagueFilter, filterByLeague, hasLeagueFilter } from '../../docs/assets/leagues.js';
import { scheduleMessage, matchMessage } from '../../src/lib/blocks.js';
import { handleNote, noteSnapshot } from './note.js';
import { renderNotePage } from './note-view.js';

/** Slack huỷ kết nối sau 3s; chốt 2,5s rồi chuyển sang trả lời trễ qua response_url. */
const FAST_PATH_MS = 2500;

/**
 * Cửa duy nhất kiểm tra quyền cho trang xem sổ.
 *
 * Hiện luôn cho qua: người dùng chọn trang không đặt token, chỉ dựa vào việc
 * không có chỗ nào trỏ tới. Gom vào một hàm để nếu sau này muốn siết thì chỉ sửa
 * đúng chỗ này, không phải lần mò khắp file.
 */
function isAllowed() {
  return true;
}

export default {
  async fetch(request, env, ctx) {
    // Trang xem sổ gọi bằng GET từ trình duyệt nên không có chữ ký Slack. Nhánh
    // này phải nằm TRƯỚC chỗ chặn non-POST, và tuyệt đối không đụng tới đường
    // POST bên dưới — chữ ký Slack vẫn phải verify y như cũ.
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/note' || url.pathname === '/note.json')) {
      if (!isAllowed(request, env)) return new Response('Không có quyền', { status: 403 });
      if (!env.NOTE) {
        return json({ error: 'Chưa gắn kho dữ liệu' }, { status: 500, headers: NOTE_HEADERS });
      }

      const snapshot = await noteSnapshot(env, url.searchParams.get('period') || undefined);

      // `/note` trả trang xem; `/note.json` trả dữ liệu thô nếu cần tự xử lý.
      if (url.pathname === '/note.json') return json(snapshot, { headers: NOTE_HEADERS });

      return new Response(renderNotePage(snapshot), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...NOTE_HEADERS },
      });
    }

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

export async function handleCommand(body, env = {}) {
  const cmd = String(body.command ?? '').trim();

  // Nhánh sổ ghi chú phải đứng TRƯỚC resolveGame, vì `/note` không phải tên game
  // nên sẽ rơi vào nhánh báo lỗi "chưa nối với game nào".
  if (cmd === '/note') {
    const args = (body.text ?? '').trim().split(/\s+/).filter(Boolean);
    try {
      return await handleNote(args, env);
    } catch (err) {
      // Lỗi cú pháp của người dùng cũng trả ephemeral, không ném ra ngoài.
      return { response_type: 'ephemeral', text: `Không ghi được: ${err.message}` };
    }
  }

  const game = cmd ? resolveGame(cmd) : DEFAULT_GAME;

  // Không được im lặng rơi về game mặc định: nếu ai đó đăng ký lệnh `/valorant2`
  // mà registry không nhận ra, fallback sẽ phục vụ dữ liệu LoL dưới một lệnh
  // Valorant — trông vẫn như đang chạy tốt nên rất lâu mới phát hiện ra.
  if (!game) {
    return {
      response_type: 'ephemeral',
      text: `Lệnh \`${cmd}\` chưa được nối với game nào. Hiện có: \`/lol\`, \`/val\`.`,
    };
  }

  const provider = getProvider(game);
  const args = (body.text ?? '').trim().split(/\s+/).filter(Boolean);

  // `--share` / `công khai` ở bất kỳ đâu trong lệnh sẽ đăng cho cả kênh thấy.
  const shareIndex = args.findIndex((a) => a === '--share' || a === 'share');
  const share = shareIndex !== -1;
  if (share) args.splice(shareIndex, 1);

  // `all` ở bất kỳ đâu = bỏ bộ lọc giải. Tách ra khỏi args TRƯỚC khi đọc tham số
  // để `schedule 15 all` và `schedule all` đều hiểu đúng.
  const allIndex = args.findIndex((a) => ['all', '--all', 'tatca', 'tất cả'].includes(a));
  const showAll = allIndex !== -1;
  if (showAll) args.splice(allIndex, 1);

  const [sub = 'help', ...rest] = args;

  // Chỉ gọi là "giải lớn" khi thật sự đang lọc — gõ `all` (hoặc game không lọc
  // gì như Valorant) mà vẫn báo "không có trận giải lớn nào" là nói sai.
  const filtering = hasLeagueFilter(game) && !showAll;
  const scope = filtering ? ' giải lớn' : '';
  const self = cmd || `/${game}`;
  const url = (matchId) => {
    if (!env.PAGES_BASE_URL) return null;
    // `?game=` đã bị dùng cho id ván; môn thể thao đi bằng `?sport=`. LoL không
    // gắn gì để link cũ giữ nguyên.
    const sport = game === DEFAULT_GAME ? '' : `&sport=${encodeURIComponent(game)}`;
    return `${env.PAGES_BASE_URL.replace(/\/+$/, '')}/match.html?match=${matchId}${sport}`;
  };
  const responseType = share ? 'in_channel' : 'ephemeral';

  switch (sub) {
    case 'schedule':
    case 'lich':
    case 'lịch': {
      const hours = Number(rest[0]) || 24;
      // `limit: Infinity` để lấy TRỌN cửa sổ rồi mới lọc. Xin sẵn 20 thì
      // getUpcoming cắt 20 trận sớm nhất của MỌI giải trước, lọc sau có khi còn 0
      // dù trong cửa sổ vẫn có trận LCK. Phân trang của nó chạy theo thời gian
      // chứ không theo số lượng nên xin nhiều không tốn thêm request nào.
      const all = await provider.getUpcoming({ withinMinutes: hours * 60, limit: Infinity });
      const { events, skipped } = filterByLeague(all, makeLeagueFilter(game, { all: showAll }));

      return { response_type: responseType, ...scheduleMessage(events, {
        title: `Lịch thi đấu ${hours} giờ tới`,
        empty: `Không có trận${scope} nào trong ${hours} giờ tới.`,
        url,
        note: skippedNote(skipped, `${self} schedule ${hours} all`),
      }) };
    }

    case 'live':
    case 'dang':
    case 'đang': {
      const all = await provider.getLive();
      const { events, skipped } = filterByLeague(all, makeLeagueFilter(game, { all: showAll }));

      return { response_type: responseType, ...scheduleMessage(events, {
        title: 'Trận đang diễn ra',
        empty: `Hiện không có trận${scope} nào đang diễn ra.`,
        url,
        note: skippedNote(skipped, `${self} live all`),
      }) };
    }

    case 'match':
    case 'tran':
    case 'trận': {
      const id = rest[0];
      if (!/^\d+$/.test(id ?? '')) {
        return { response_type: 'ephemeral', text: `Cần ID trận dạng số. Ví dụ: \`${self} match 116878159559860047\`` };
      }

      const match = await provider.getMatch(id);
      if (!match) return { response_type: 'ephemeral', text: `Không tìm thấy trận \`${id}\`.` };

      // Game không có feed chỉ số (Valorant) thì bỏ hẳn bước này — matchMessage
      // đã bọc phần chỉ số trong `if (snapshot)` nên truyền null là an toàn.
      const playable = provider.capabilities.liveStats
        ? match.games.find((g) => g.state === 'inProgress') ??
          match.games.findLast((g) => g.state === 'completed')
        : null;
      const snapshot = playable
        ? await provider.getGameSnapshot(playable.id, { withDetails: false }).catch(() => null)
        : null;

      return { response_type: responseType, ...matchMessage(match, snapshot, url(id)) };
    }

    default:
      return {
        response_type: 'ephemeral',
        text: [
          `*Esports Hub — ${provider.name}*`,
          `\`${self} schedule [số giờ]\` — lịch thi đấu sắp tới (mặc định 24 giờ)`,
          `\`${self} live\` — các trận đang diễn ra`,
          `\`${self} match <id>\` — chi tiết${provider.capabilities.liveStats ? ' và chỉ số' : ''} một trận`,
          '',
          ...(hasLeagueFilter(game)
            ? [`Mặc định chỉ hiện các giải lớn. Thêm \`all\` để xem hết: \`${self} schedule 24 all\`.`]
            : []),
          'Thêm `--share` vào cuối để đăng cho cả kênh thấy thay vì chỉ mình bạn.',
        ].join('\n'),
      };
  }
}

/**
 * Dòng "đã bỏ qua N trận" kèm cách xem hết.
 *
 * Không bỏ qua trận nào thì không hiện gì — người dùng gõ `all` mà vẫn thấy dòng
 * "đã bỏ qua 0 trận" thì chỉ tổ rối.
 */
function skippedNote(skipped, howToSeeAll) {
  if (!skipped) return null;
  return `Đã bỏ qua ${skipped} trận ở các giải khác · gõ \`${howToSeeAll}\` để xem hết`;
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

const json = (payload, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

/**
 * Header cho trang xem sổ.
 *
 * CORS mở là BẮT BUỘC: trang trên GitHub Pages gọi `/note.json` từ origin khác.
 * Endpoint này vốn đã không đặt token nên siết CORS cũng chẳng chặn được ai —
 * chỉ làm trang của mình gãy.
 *
 * `noindex` để máy tìm kiếm không lập chỉ mục — không phải bảo mật, chỉ là không
 * tự quảng cáo.
 */
const NOTE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};
