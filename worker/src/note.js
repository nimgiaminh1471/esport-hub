/**
 * note.js — sổ ghi chú cá nhân, lưu trong Cloudflare KV.
 *
 * Vì sao KV chứ không phải file trong repo: Worker không có ổ đĩa và không commit
 * được, nên nhập bằng slash command thì dữ liệu buộc phải nằm ở kho ngoài. Tiện
 * thể KV nằm trong tài khoản Cloudflare, không nằm trong repo, nên xem repo cũng
 * không thấy số liệu.
 *
 * MỖI DÒNG MỘT KEY, không gom cả kỳ vào một key. Gom lại thì nhập hai dòng gần
 * nhau sẽ dính read-modify-write và mất một dòng mà không báo gì — với sổ đối
 * soát đó là kiểu hỏng tệ nhất vì tới lúc chốt mới phát hiện, mà lúc đó không
 * còn cách nào dựng lại.
 *
 * Nội dung dòng nằm ở `metadata` của key, không phải ở value: `list()` trả kèm
 * metadata nên đọc cả kỳ chỉ tốn MỘT lời gọi KV, thay vì list rồi get từng cái.
 */
import { providers } from '../../docs/assets/games.js';
import {
  currentPeriod,
  formatEntry,
  parseAdd,
  periodOf,
  periodRange,
  shiftPeriod,
  signed,
  summarise,
} from '../../docs/assets/note-core.js';

/** Metadata của KV tối đa 1024 byte; chừa biên cho các trường khác. */
const MAX_NOTE_LEN = 300;

const keyPrefix = (period) => `e:${period}:`;

/* ------------------------------------------------------------------- KV */

async function listPeriod(env, period) {
  const { keys } = await env.NOTE.list({ prefix: keyPrefix(period) });
  // Key chứa mốc ISO nên thứ tự chữ cái đã là thứ tự thời gian.
  return keys
    .map((k) => ({ key: k.name, ...(k.metadata ?? {}) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

async function putEntry(env, entry) {
  const rand = Math.random().toString(36).slice(2, 6);
  const key = `${keyPrefix(entry.period)}${entry.at}:${rand}`;
  await env.NOTE.put(key, '', { metadata: entry });
  return key;
}

/* --------------------------------------------------------------- tra cứu */

/**
 * Mã số thì tra xem thuộc game nào để lấy mã đội; không phải mã số thì coi như
 * nhãn người dùng tự gõ.
 *
 * Hai game dùng chung dải mã nên không phân biệt được bằng hình dạng — thử lần
 * lượt, mã sai game sẽ ném lỗi và bị bỏ qua. `enrich: false` để mỗi lần thử chỉ
 * tốn một request; mã đội có sẵn trong `getEventDetails`, không cần bù thêm.
 */
async function resolveRef(ref) {
  if (!/^\d{6,}$/.test(ref)) return { label: ref, matchId: null, game: null };

  for (const provider of Object.values(providers)) {
    try {
      const match = await provider.getMatch(ref, { enrich: false });
      if (!match) continue;
      const label = match.teams.map((t) => t.code).join(' vs ');
      return { label: label || ref, matchId: ref, game: provider.id };
    } catch {
      // Mã không thuộc game này — thử game tiếp theo.
    }
  }

  // Tra không ra thì vẫn ghi, chỉ là không có mã đội. Chặn ở đây sẽ khiến mất
  // dòng chỉ vì mạng lỗi hoặc Riot đổi schema.
  return { label: ref, matchId: ref, game: null };
}

/* ------------------------------------------------------------ trả lời Slack */

const reply = (text) => ({ response_type: 'ephemeral', text });

const replyBlocks = (text, lines) => ({
  response_type: 'ephemeral',
  text,
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text } },
    ...(lines.length
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: lines.join('\n') }] }]
      : []),
  ],
});

function reportText(period, entries) {
  const s = summarise(entries);
  const range = periodRange(period);

  const detail = [];
  if (s.chungPlus || s.chungMinus) detail.push(`${s.chungPlus} lần +, ${s.chungMinus} lần −`);

  return [
    `*Kỳ ${range.label}* · ${s.count} dòng`,
    '```',
    `Chung : ${signed(s.chung).padStart(4)}${detail.length ? `   (${detail[0]})` : ''}`,
    `Riêng : ${signed(s.rieng).padStart(4)}${s.riengList.length ? `   (${s.riengList.map(signed).join(', ')})` : ''}`,
    '──────────────',
    `Tổng  : ${signed(s.tong).padStart(4)}`,
    '```',
  ].join('\n');
}

/* ------------------------------------------------------------------ lệnh */

const HELP = [
  '*Sổ ghi chú* — chỉ mình bạn thấy các trả lời này.',
  '```',
  '/note add <mã> +              chung +1',
  '/note add <mã> -              chung −1',
  '/note add <mã> + --r +10      chung +1, riêng +10',
  '/note add <mã> --r -5         chỉ riêng, không có chung',
  '/note add <mã> ván 2 +        ghi theo ván',
  '/note report [YYYY-MM]        cộng sổ một kỳ',
  '/note list [YYYY-MM]          liệt kê từng dòng',
  '/note undo                    xoá dòng vừa nhập',
  '```',
  'Mã trận lấy ở dòng nhạt trong `/lol schedule` hoặc `/val schedule`.',
  'Kỳ chạy từ 26 tháng trước tới hết 25 tháng này.',
].join('\n');

/**
 * @param {string[]} args  đã tách khoảng trắng, đã bỏ tên lệnh
 */
export async function handleNote(args, env) {
  if (!env?.NOTE) {
    return reply('Chưa gắn kho dữ liệu. Xem hướng dẫn tạo namespace trong `CLAUDE.md`.');
  }

  const [sub = 'help', ...rest] = args;

  switch (sub) {
    case 'add': {
      const parsed = parseAdd(rest); // ném lỗi có thông điệp rõ ràng nếu thiếu
      const ref = await resolveRef(parsed.ref);

      // Kỳ tính theo LÚC NHẬP, không theo ngày thi đấu. Nếu lấy ngày thi đấu thì
      // ghi bù một trận cũ sẽ rơi vào kỳ đã chốt xong, làm con số của kỳ đó đổi
      // ngược về sau — sổ đã chốt thì không được tự đổi nữa.
      // GIỮ mili-giây: khoá xếp theo thứ tự chữ cái để ra thứ tự thời gian, cắt
      // mili-giây đi thì mấy dòng nhập trong cùng một giây có khoá bằng nhau và
      // `list` sắp lộn xộn theo phần ngẫu nhiên ở cuối khoá.
      const at = new Date().toISOString();
      const entry = {
        at,
        period: periodOf(at),
        matchId: ref.matchId,
        label: ref.label,
        game: ref.game,
        gameNumber: parsed.gameNumber,
        dir: parsed.dir,
        rieng: parsed.rieng,
        note: parsed.note ? parsed.note.slice(0, MAX_NOTE_LEN) : null,
      };

      await putEntry(env, entry);
      const entries = await listPeriod(env, entry.period);

      return replyBlocks(`Đã ghi · ${formatEntry(entry)}`, [
        `Kỳ ${periodRange(entry.period).label} · tổng đang là ${signed(summarise(entries).tong)}`,
      ]);
    }

    case 'report':
    case 'tong': {
      const period = rest[0] || currentPeriod();
      const entries = await listPeriod(env, period);
      if (!entries.length) {
        return reply(`Kỳ ${periodRange(period).label} chưa có dòng nào.`);
      }
      return replyBlocks(reportText(period, entries), [
        `Kỳ trước: \`/note report ${shiftPeriod(period, -1)}\``,
      ]);
    }

    case 'list': {
      const period = rest[0] || currentPeriod();
      const entries = await listPeriod(env, period);
      if (!entries.length) {
        return reply(`Kỳ ${periodRange(period).label} chưa có dòng nào.`);
      }
      return replyBlocks(
        `*Kỳ ${periodRange(period).label}* · ${entries.length} dòng`,
        entries.map(formatEntry),
      );
    }

    case 'undo': {
      const period = currentPeriod();
      const entries = await listPeriod(env, period);
      const last = entries.at(-1);
      if (!last) return reply(`Kỳ ${periodRange(period).label} chưa có dòng nào để xoá.`);

      await env.NOTE.delete(last.key);
      const left = await listPeriod(env, period);
      return replyBlocks(`Đã xoá · ${formatEntry(last)}`, [
        `Còn ${left.length} dòng · tổng ${signed(summarise(left).tong)}`,
      ]);
    }

    default:
      return reply(HELP);
  }
}

/** Dữ liệu cho trang xem. */
export async function noteSnapshot(env, period = currentPeriod()) {
  const entries = await listPeriod(env, period);
  return {
    period,
    range: periodRange(period),
    prev: shiftPeriod(period, -1),
    next: shiftPeriod(period, 1),
    summary: summarise(entries),
    entries,
  };
}
