/**
 * day-core.js — phần tính toán thuần của vòng chốt theo ngày.
 *
 * Không chạm KV, không gọi mạng, không `node:*` — chạy được bằng Node trần nên
 * kiểm chứng phần số má không cần khoá Binance cũng chẳng cần dựng Worker. Cùng
 * lý do đã tách `note-core.js` khỏi `note.js`.
 *
 * Mỗi ngày là một chu kỳ KHÉP KÍN: cộng lãi đã chốt trong ngày, chia theo tỉ lệ,
 * xong. Ngày lỗ chia cả lỗ theo đúng tỉ lệ đó và KHÔNG chuyển sang ngày sau —
 * cộng dồn lỗ qua ngày là thứ tới lúc thanh toán mới phát hiện hai bên đang hiểu
 * khác nhau.
 *
 * Số để trần, không đơn vị.
 */
import { partsVN } from './note-core.js';

/** Mọi mốc thời gian quy về giờ Việt Nam trước khi xét ngày. */
export const TZ = 'Asia/Ho_Chi_Minh';

/**
 * Mọi số tiền lưu dưới dạng SỐ NGUYÊN của 1/100 đơn vị, không lưu số thực.
 *
 * Binance trả chuỗi thập phân; cộng chúng bằng số thực rồi mới làm tròn sẽ lệch
 * dần theo số dòng, và sổ đối soát lệch dù chỉ một đơn vị là mất tin tưởng vào cả
 * sổ. Cộng bằng số nguyên thì phép cộng chính xác tuyệt đối.
 *
 * Tên trường vì thế luôn có đuôi `Units` để không ai đọc nhầm thành số hiển thị.
 */
export const SCALE = 100;

/** Tỉ lệ mặc định khi chưa cấu hình gì: chia đôi. */
export const DEFAULT_SHARE = 0.5;

/* ---------------------------------------------------------------- mốc ngày */

/** `YYYY-MM-DD` theo giờ VN của một mốc thời gian. */
export function dayOf(dateIso) {
  const { y, m, day } = partsVN(dateIso);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Ngày đang chạy tính tới lúc này. */
export const today = () => dayOf(new Date().toISOString());

/**
 * Mốc đầu và cuối một ngày giờ VN, quy về epoch ms.
 *
 * Ghi thẳng `+07:00` chứ không tra offset động: Việt Nam bỏ giờ mùa hè từ 1975
 * nên offset cố định, mà tra động thì phải dựng ngược từ `Intl` — dài hơn, dễ sai
 * hơn, và không đúng thêm được ngày nào.
 */
export function dayBounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`Ngày không hợp lệ: ${day}`);
  const startMs = Date.parse(`${day}T00:00:00.000+07:00`);
  if (Number.isNaN(startMs)) throw new Error(`Ngày không hợp lệ: ${day}`);
  return { startMs, endMs: startMs + 86_400_000 - 1 };
}

/**
 * Ngày liền trước / liền sau.
 *
 * Cộng ngày ở mốc GIỮA ngày (12:00 VN) rồi mới quy về `YYYY-MM-DD`: cộng ở mốc
 * 00:00 thì chỉ cần lệch một mili-giây là rơi sang ngày bên cạnh.
 */
export function shiftDay(day, delta) {
  const { startMs } = dayBounds(day);
  return dayOf(new Date(startMs + 43_200_000 + delta * 86_400_000).toISOString());
}

/** Dải ngày liên tiếp, mới nhất trước — dùng để rà ngược khi cron lỡ nhịp. */
export function recentDays(from, count) {
  return Array.from({ length: count }, (_, i) => shiftDay(from, -i));
}

/** `25/12` — dạng ngắn để đọc lướt, cùng kiểu với `formatEntry` của sổ tay. */
export function dayLabel(day) {
  const [, m, d] = String(day).split('-');
  return `${d}/${m}`;
}

/* ------------------------------------------------------------------ số má */

/** Chuỗi thập phân của Binance -> số nguyên 1/100, làm tròn đúng một lần. */
export const toUnits = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
};

/** Số nguyên 1/100 -> chuỗi hiển thị, luôn kèm dấu để đọc lướt biết ngay chiều. */
export function fmt(units) {
  const n = (units ?? 0) / SCALE;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/**
 * Cộng và chia lãi của một ngày.
 *
 * Cộng ở độ chính xác cao hơn hiển thị rồi mới làm tròn MỘT LẦN cho cả ngày —
 * làm tròn từng vị thế trước khi cộng thì sai số nhân theo số vị thế.
 *
 * `minh` lấy phần dư của phép làm tròn (`profit - doiTac`) chứ không tính riêng,
 * nhờ vậy `doiTac + minh === profit` đúng tuyệt đối, không bao giờ lệch một đơn vị
 * ở dòng tổng. Công thức này tự chạy đúng cho ngày âm nên không cần nhánh riêng —
 * đúng với quy ước "chia cả lỗ".
 */
export function splitDay(positions, ratio = DEFAULT_SHARE) {
  let micro = 0;
  let wins = 0;
  let losses = 0;

  for (const p of positions) {
    // `realizedPnl` là trường chuẩn; `pnl` là tên Binance dùng ở vài chỗ trong
    // cùng schema. Đọc cả hai để một lần đổi tên phía họ không làm ngày đó về 0.
    const raw = p.realizedPnl ?? p.pnl;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    micro += Math.round(n * 1_000_000);
    if (n > 0) wins++;
    else if (n < 0) losses++;
  }

  const profitUnits = Math.round(micro / (1_000_000 / SCALE));
  const doiTacUnits = Math.round(profitUnits * ratio);

  return {
    profitUnits,
    doiTacUnits,
    minhUnits: profitUnits - doiTacUnits,
    ratio,
    count: positions.length,
    wins,
    losses,
  };
}

/**
 * Cộng nhiều ngày đã chốt lại.
 *
 * Cộng các con số ĐÃ chia của từng ngày chứ không chia lại trên tổng: tỉ lệ có
 * thể đã đổi giữa chừng, và ngày đã chốt thì không được tính lại.
 */
export function summariseDays(rows) {
  const s = { profitUnits: 0, doiTacUnits: 0, minhUnits: 0, days: rows.length, wins: 0, losses: 0, count: 0 };
  for (const r of rows) {
    s.profitUnits += r.profitUnits ?? 0;
    s.doiTacUnits += r.doiTacUnits ?? 0;
    s.minhUnits += r.minhUnits ?? 0;
    s.wins += r.wins ?? 0;
    s.losses += r.losses ?? 0;
    s.count += r.count ?? 0;
  }
  return s;
}

/* ------------------------------------------------------------ hiển thị */

/**
 * Ba dòng tổng kết một ngày, dùng chung cho Slack lẫn chỗ nào cần in ra text.
 *
 * Căn cột bằng `padStart` trong khối code để ba con số thẳng hàng — cùng cách đã
 * dùng ở `reportText` của sổ tay, đọc lướt là thấy ngay chênh lệch.
 */
export function dayLines(row) {
  const pad = (u) => fmt(u).padStart(10);
  return [
    `Lãi ngày : ${pad(row.profitUnits)}`,
    `Đối tác  : ${pad(row.doiTacUnits)}   (${Math.round((row.ratio ?? DEFAULT_SHARE) * 100)}%)`,
    '────────────────────────',
    `Còn lại  : ${pad(row.minhUnits)}`,
  ];
}

/**
 * Block Kit tổng kết một ngày.
 *
 * Để ở đây chứ không ở `src/lib/blocks.js`: file kia là Block Kit của phần
 * esports và có import registry game — sổ riêng cố ý không dính vào đó.
 *
 * Không nêu tên ai, không gắn ký hiệu tiền tệ: cả kênh đọc được tin này.
 */
export function dayMessage(row) {
  const head = row.profitUnits >= 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
  const detail = [
    `${row.count} vị thế`,
    row.wins ? `${row.wins} thắng` : null,
    row.losses ? `${row.losses} thua` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    text: `Chốt ngày ${dayLabel(row.day)}: ${fmt(row.profitUnits)}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${head} *Chốt ngày ${dayLabel(row.day)}*\n\`\`\`\n${dayLines(row).join('\n')}\n\`\`\`` },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: detail || 'Không có vị thế nào tất toán trong ngày' }] },
    ],
  };
}

/**
 * Cảnh báo khi có ngày không chốt được.
 *
 * MỘT tin cho cả lượt, không phải mỗi ngày một tin: hỏng kiểu thường gặp nhất
 * (khoá hết hạn, mất quyền) làm cả 7 ngày trong cửa sổ rà ngược cùng lỗi, mà 7
 * tin giống nhau thì đọc xong chẳng rõ hơn một tin.
 *
 * Tin này lặp lại mỗi đêm cho tới khi sửa xong — cố ý. Cảnh báo mà tự tắt là cảnh
 * báo bị bỏ lỡ. Nó tự hết om sòm mà không cần cơ chế gì thêm: ngày lỗi cũ dần rồi
 * rơi ra khỏi cửa sổ 7 ngày.
 *
 * KHÔNG kèm chi tiết kỹ thuật (tên sàn, mã lỗi) — cả kênh đọc được tin này, và sổ
 * này cố ý giữ từ ngữ trung tính. Nguyên văn lỗi nằm ở log Worker, xem bằng
 * `npx wrangler tail`.
 */
export function alertMessage(errors) {
  const days = errors.map((e) => dayLabel(e.day)).join(', ');
  const text = `Chưa lấy được số liệu để chốt ${errors.length} ngày: ${days}`;

  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${text}*` } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Sửa xong thì gõ \`/note settle ${errors[0].day}\` để chốt bù · chi tiết lỗi xem \`wrangler tail\``,
          },
        ],
      },
    ],
  };
}

/**
 * Đọc tỉ lệ chia từ cấu hình.
 *
 * Chỉ nhận trong khoảng [0, 1]. Cấu hình sai mà im lặng rơi về mặc định là kiểu
 * hỏng tệ nhất ở đây: mọi thứ trông vẫn chạy, chỉ có tiền chia sai — và phải tới
 * lúc đối chiếu mới biết.
 */
export function shareFrom(env) {
  const raw = env?.DOI_TAC_SHARE;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SHARE;

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`DOI_TAC_SHARE phải là số trong khoảng 0–1, đang là \`${raw}\`.`);
  }
  return n;
}
