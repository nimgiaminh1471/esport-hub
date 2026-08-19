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

/** Số nguyên 1/100 -> chuỗi hiển thị, luôn kèm dấu để đọc lướt biết ngay chiều. */
export function fmt(units) {
  const n = (units ?? 0) / SCALE;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/**
 * Đọc con số người dùng gõ -> số nguyên 1/100.
 *
 * Nhận cả `12.5` lẫn `12,5`: bàn phím tiếng Việt cho dấu phẩy, và gõ nhầm dấu là
 * chuyện xảy ra hàng ngày. `Number('12,5')` ra `NaN`, mà `NaN` lọt xuống dưới sẽ
 * thành một ngày 0.00 trông y như ngày hoà vốn.
 *
 * Chặn số vô lý ngay tại đây: nhập tay thì gõ thừa một chữ số là chuyện thường,
 * và sổ đối soát nhận nhầm một con số to gấp mười thì tới lúc thanh toán mới cãi
 * nhau. Ngưỡng đặt rộng rãi, chỉ để bắt lỗi gõ chứ không phải để giới hạn.
 */
export const MAX_UNITS = 100_000_000; // 1 triệu đơn vị hiển thị

export function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error('Cần một con số. Ví dụ: `/note chot 12.5` hoặc `/note chot -8`.');
  }

  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`\`${raw}\` không phải là số.`);

  const units = Math.round(n * SCALE);
  if (Math.abs(units) > MAX_UNITS) {
    throw new Error(`\`${raw}\` lớn bất thường — kiểm tra lại xem có gõ thừa chữ số không.`);
  }
  return units;
}

/**
 * Chia lãi của một ngày theo tỉ lệ.
 *
 * `minh` lấy phần dư (`profit - doiTac`) chứ không tính riêng, nhờ vậy
 * `doiTac + minh === profit` đúng tuyệt đối, không bao giờ lệch một đơn vị ở dòng
 * tổng. Công thức tự chạy đúng cho ngày âm nên không cần nhánh riêng — đúng với
 * quy ước "chia cả lỗ".
 */
export function splitAmount(profitUnits, ratio = DEFAULT_SHARE) {
  const doiTacUnits = Math.round(profitUnits * ratio);
  return { profitUnits, doiTacUnits, minhUnits: profitUnits - doiTacUnits, ratio };
}

/**
 * Cộng nhiều ngày đã chốt lại.
 *
 * Cộng các con số ĐÃ chia của từng ngày chứ không chia lại trên tổng: tỉ lệ có
 * thể đã đổi giữa chừng, và ngày đã chốt thì không được tính lại.
 */
export function summariseDays(rows) {
  const s = { profitUnits: 0, doiTacUnits: 0, minhUnits: 0, days: rows.length, lai: 0, lo: 0 };
  for (const r of rows) {
    s.profitUnits += r.profitUnits ?? 0;
    s.doiTacUnits += r.doiTacUnits ?? 0;
    s.minhUnits += r.minhUnits ?? 0;
    if (r.profitUnits > 0) s.lai++;
    else if (r.profitUnits < 0) s.lo++;
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

  return {
    text: `Chốt ngày ${dayLabel(row.day)}: ${fmt(row.profitUnits)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${head} *Chốt ngày ${dayLabel(row.day)}*\n\`\`\`\n${dayLines(row).join('\n')}\n\`\`\``,
        },
      },
      ...(row.note ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: row.note }] }] : []),
    ],
  };
}

/**
 * Tin báo khi một ngày đã chốt bị sửa lại.
 *
 * Sửa số phải BÁO LÊN KÊNH kèm cả số cũ, không được im lặng thay số: kênh đã nhận
 * con số cũ rồi, đối tác có thể đã ghi lại hoặc đã trả tiền theo nó. Một dòng
 * "trước ghi X" là thứ duy nhất giải thích được vì sao tổng tháng đổi.
 */
export function correctionMessage(row, truocDo) {
  const text = `Sửa ngày ${dayLabel(row.day)}: ${fmt(truocDo.profitUnits)} → ${fmt(row.profitUnits)}`;

  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:pencil2: *${text}*\n\`\`\`\n${dayLines(row).join('\n')}\n\`\`\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: [`Trước đó: ${fmt(truocDo.profitUnits)} · đối tác ${fmt(truocDo.doiTacUnits)}`, row.note]
              .filter(Boolean)
              .join(' · '),
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
