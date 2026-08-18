/**
 * note-core.js — phần tính toán thuần của sổ ghi chú cá nhân.
 *
 * Không chạm KV, không chạm DOM, không `node:*` — Worker và trang web dùng chung,
 * và test được bằng Node mà không cần dựng gì.
 *
 * Sổ gồm hai mục độc lập nhau:
 *   - chung : mỗi dòng ±1
 *   - riêng : mức do đối tác đưa ra, mang dấu của chính nó
 * Hai mục cộng riêng suốt kỳ, tới lúc chốt mới gộp lại thành một con số.
 *
 * Số để trần, không đơn vị.
 */

/** Mọi mốc thời gian quy về giờ Việt Nam trước khi xét ngày. */
export const TZ = 'Asia/Ho_Chi_Minh';

/**
 * Tách năm/tháng/ngày theo giờ VN.
 *
 * Bắt buộc phải quy đổi múi giờ chứ không dùng `getUTCDate()`: 01:00 ngày 26 giờ
 * VN là 18:00 ngày 25 giờ UTC — xét theo UTC sẽ rơi nhầm kỳ, mà sai kiểu này thì
 * tới lúc chốt sổ mới phát hiện.
 */
function partsVN(dateIso) {
  const d = dateIso ? new Date(dateIso) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`Mốc thời gian không hợp lệ: ${dateIso}`);

  // en-CA cho ra dạng YYYY-MM-DD nên tách bằng dấu gạch là đủ.
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(d)
    .split('-')
    .map(Number);

  return { y, m, day };
}

/**
 * Kỳ chứa mốc thời gian này, dạng `YYYY-MM` — tháng ghi trong tên kỳ là tháng
 * CHỐT, tức ngày 25 kết thúc kỳ đó.
 *
 * Ngày ≥ 26 thuộc kỳ chốt tháng sau; ngày ≤ 25 thuộc kỳ chốt tháng này.
 */
export function periodOf(dateIso) {
  const { y, m, day } = partsVN(dateIso);
  const monthsFromYearStart = m - 1 + (day >= 26 ? 1 : 0);
  const year = y + Math.floor(monthsFromYearStart / 12);
  const month = (monthsFromYearStart % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Kỳ đang chạy tính tới lúc này. */
export const currentPeriod = () => periodOf(new Date().toISOString());

/** Khoảng ngày của một kỳ, để in ra cho dễ đọc: 26 tháng trước → 25 tháng này. */
export function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) throw new Error(`Kỳ không hợp lệ: ${period}`);

  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const pad = (n) => String(n).padStart(2, '0');
  return {
    from: `26/${pad(prev.m)}/${prev.y}`,
    to: `25/${pad(m)}/${y}`,
    label: `26/${pad(prev.m)} – 25/${pad(m)}/${y}`,
  };
}

/** Kỳ liền trước / liền sau, để bấm qua lại trên trang xem. */
export function shiftPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ số má */

/** `+7`, `-3`, `0` — luôn hiện dấu để đọc lướt biết ngay chiều. */
export const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Cộng sổ một kỳ.
 *
 * Hai mục cộng TÁCH BẠCH rồi mới gộp ở `tong`. Gộp sớm là mất khả năng đối chiếu
 * khi hai bên lệch nhau, mà đó lại chính là lúc cần đối chiếu nhất.
 */
export function summarise(entries) {
  const s = {
    chung: 0,
    rieng: 0,
    tong: 0,
    count: entries.length,
    chungPlus: 0,
    chungMinus: 0,
    riengList: [],
  };

  for (const e of entries) {
    if (e.dir) {
      s.chung += e.dir;
      if (e.dir > 0) s.chungPlus++;
      else s.chungMinus++;
    }
    if (Number.isFinite(e.rieng) && e.rieng !== 0) {
      s.rieng += e.rieng;
      s.riengList.push(e.rieng);
    }
  }

  s.tong = s.chung + s.rieng;
  return s;
}

/** Một dòng để in ra Slack hoặc web. */
export function formatEntry(entry) {
  const { day, m } = partsVN(entry.at);
  const when = `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}`;

  const what = [entry.label, entry.gameNumber ? `ván ${entry.gameNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  // Không có mục nào thì bỏ hẳn, đừng chèn dấu giữ chỗ — dòng đó sẽ ra "· · ·".
  const cols = [
    entry.dir ? `chung ${signed(entry.dir)}` : null,
    Number.isFinite(entry.rieng) && entry.rieng !== 0 ? `riêng ${signed(entry.rieng)}` : null,
    entry.note || null,
  ].filter(Boolean);

  return [when, what, ...cols].join(' · ');
}

/* ------------------------------------------------------------ đọc câu lệnh */

/**
 * Tách các phần của lệnh thêm dòng. Thuần, không gọi mạng — chỗ gọi tự tra cứu
 * `ref` sau.
 *
 * Trả `{ ref, dir, rieng, gameNumber, note }`:
 *   ref        chuỗi đầu tiên: mã trận, hoặc nhãn tự gõ
 *   dir        +1 / -1 / null (null = dòng này không có mục chung)
 *   rieng      số mang dấu, hoặc null
 *   gameNumber số ván, hoặc null
 *
 * `--r 10` không dấu hiểu là `+10`. KHÔNG cho nó thừa hưởng dấu của `dir`: suy
 * diễn ngầm trên sổ sách là thứ vài tháng sau không ai nhớ nổi quy tắc nào đang
 * áp dụng, và sai thì sai âm thầm.
 */
export function parseAdd(tokens) {
  const rest = [...tokens];
  let dir = null;
  let rieng = null;
  let gameNumber = null;

  // --r <số> ở bất kỳ đâu
  const ri = rest.findIndex((t) => t === '--r' || t === '-r');
  if (ri !== -1) {
    const raw = rest[ri + 1];
    if (raw === undefined) throw new Error('`--r` phải đi kèm một số, ví dụ `--r +10`.');
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`\`--r\` cần một số, nhận được \`${raw}\`.`);
    rieng = n;
    rest.splice(ri, 2);
  }

  // "ván 2" / "van 2" / "map 2"
  const gi = rest.findIndex((t) => ['ván', 'van', 'map'].includes(t.toLowerCase()));
  if (gi !== -1) {
    const n = Number(rest[gi + 1]);
    if (Number.isFinite(n)) {
      gameNumber = n;
      rest.splice(gi, 2);
    }
  }

  // dấu + / - đứng riêng
  const di = rest.findIndex((t) => t === '+' || t === '-');
  if (di !== -1) {
    dir = rest[di] === '+' ? 1 : -1;
    rest.splice(di, 1);
  }

  const ref = rest.shift() ?? '';
  const note = rest.join(' ').trim() || null;

  if (dir === null && rieng === null) {
    throw new Error('Cần ít nhất `+`, `-` hoặc `--r <số>`, nếu không thì dòng này chẳng ghi gì.');
  }
  if (!ref) throw new Error('Cần mã trận hoặc một nhãn để biết dòng này thuộc về đâu.');

  return { ref, dir, rieng, gameNumber, note };
}
