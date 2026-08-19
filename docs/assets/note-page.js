/**
 * Trang xem sổ ghi chú, chạy trên GitHub Pages.
 *
 * Không có chỗ nào trong site trỏ tới trang này — cố ý. Dữ liệu nằm ở Worker
 * (Cloudflare KV); trang chỉ đọc qua `GET /note.json`.
 *
 * Cố ý KHÔNG import `note-core.js`: file đó nằm trong `worker/` (chỉ Worker dùng),
 * và endpoint đã trả về `summary` tính sẵn nên trang chẳng cần tính lại gì. Nhờ
 * vậy phần tính toán chỉ có một bản, ở một nơi.
 *
 * Trang không tự kiểm tra quyền: ai biết đường dẫn đều xem được. Bù lại số để
 * trần và không có tên người nên nhìn vào chỉ là một cột số vô danh.
 */
import { el, clear, setStatus } from './ui.js';

/**
 * URL Worker. Không phải bí mật — chính Slack cũng gọi vào đây — nhưng phải khớp
 * với subdomain thật của tài khoản Cloudflare (in ra ở cuối lệnh
 * `npx wrangler deploy`). Subdomain này không suy ra được từ repo.
 *
 * Sai URL thì mở trang kèm `?api=https://...` để chữa tạm mà không phải sửa code.
 */
const DEFAULT_API = 'https://esports-hub-slack.esport-slack.workers.dev';

const params = new URLSearchParams(location.search);
const API = (params.get('api') || DEFAULT_API).replace(/\/+$/, '');
const period = params.get('period');
const month = params.get('month');

const dom = {
  status: document.getElementById('status'),
  days: document.getElementById('days'),
  sum: document.getElementById('sum'),
  rows: document.getElementById('rows'),
};

load().catch(reportError);

function reportError(err) {
  setStatus(
    dom.status,
    `Không tải được sổ: ${err.message}. Kiểm tra URL Worker trong note-page.js, ` +
      'hoặc mở trang kèm ?api=<url worker>.',
    true,
  );
}

async function load() {
  const q = new URLSearchParams();
  if (period) q.set('period', period);
  if (month) q.set('month', month);

  const query = String(q);
  const res = await fetch(`${API}/note.json${query ? `?${query}` : ''}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  dom.status.hidden = true;
  renderDays(data);
  renderSummary(data);
  renderRows(data);
}

/** `+7` / `-3` / `0` — luôn hiện dấu để đọc lướt biết ngay chiều. */
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Số của phần theo ngày là SỐ NGUYÊN 1/100 (xem `SCALE` trong
 * `worker/src/day-core.js`) nên phải chia trước khi hiển thị — dùng nhầm `signed`
 * ở đây sẽ ra con số gấp trăm lần.
 */
const fmt = (units) => {
  const n = (units ?? 0) / 100;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
};

/** `2026-08-19` -> `19/08` */
const dayLabel = (day) => {
  const [, m, d] = String(day).split('-');
  return `${d}/${m}`;
};

/** `YYYY-MM` cộng/trừ tháng. Chỉ dùng cho hai nút bấm nên tính tại chỗ là đủ. */
function shiftMonth(value, delta) {
  const [y, m] = String(value).split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Giữ nguyên tham số đang có, chỉ đổi một cái — để `?api=` không bị mất khi bấm qua lại. */
function hrefFor(key, value) {
  const q = new URLSearchParams(location.search);
  q.set(key, value);
  return `./note.html?${q}`;
}

/**
 * Một dòng tổng kết. Nhận CHUỖI đã định dạng sẵn chứ không nhận số: sổ nhập tay
 * dùng `signed`, phần theo ngày dùng `fmt`.
 */
const line = (label, text, meta, total = false) =>
  el('div', { class: `compare-row${total ? ' compare-row--total' : ''}` }, [
    el('div', { class: 'v v--blue', text: label }),
    el('div', { class: 'mid' }, [el('div', { class: 'label', text: meta ?? '' })]),
    el('div', { class: 'v v--red', text }),
  ]);

function renderDays({ ngay }) {
  // Worker cũ chưa trả phần này thì ẩn hẳn thẻ, đừng ném lỗi — ném ở đây sẽ kéo
  // sập cả trang, kể cả phần sổ nhập tay vốn chẳng liên quan gì.
  if (!ngay) return;

  const { month, days, total } = ngay;

  clear(dom.days).append(
    el('header', {}, [
      el('h2', { text: `Theo ngày · ${month}` }),
      el('span', { class: 'spacer' }),
      el('a', { class: 'game-tab', href: hrefFor('month', shiftMonth(month, -1)), text: '‹ tháng trước' }),
      el('a', { class: 'game-tab', href: hrefFor('month', shiftMonth(month, 1)), text: 'tháng sau ›' }),
    ]),
    line('Lãi', fmt(total.profitUnits), `${total.days} ngày · ${total.lai} lãi, ${total.lo} lỗ`),
    line('Đối tác', fmt(total.doiTacUnits), ''),
    line('Còn lại', fmt(total.minhUnits), '', true),
    days.length
      ? el('div', { class: 'scroll-x' }, [
          el('table', {}, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Ngày' }),
                el('th', { text: 'Ghi chú' }),
                el('th', { class: 'num', text: 'Lãi' }),
                el('th', { class: 'num', text: 'Đối tác' }),
                el('th', { class: 'num', text: 'Còn lại' }),
              ]),
            ]),
            el(
              'tbody',
              {},
              days.map((d) =>
                el('tr', {}, [
                  el('td', { text: dayLabel(d.day) }),
                  el('td', {
                    text: [d.note, d.suaTu !== undefined ? `sửa từ ${fmt(d.suaTu)}` : null]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                  el('td', { class: 'num', text: fmt(d.profitUnits) }),
                  el('td', { class: 'num', text: fmt(d.doiTacUnits) }),
                  el('td', { class: 'num', text: fmt(d.minhUnits) }),
                ]),
              ),
            ),
          ]),
        ])
      : el('p', { class: 'empty', text: 'Tháng này chưa có ngày nào được chốt.' }),
  );
  dom.days.hidden = false;
}

function renderSummary({ range, summary, prev, next }) {
  clear(dom.sum).append(
    el('header', {}, [
      el('h2', { text: `Theo trận · kỳ ${range.label}` }),
      el('span', { class: 'spacer' }),
      el('a', { class: 'game-tab', href: hrefFor('period', prev), text: '‹ kỳ trước' }),
      el('a', { class: 'game-tab', href: hrefFor('period', next), text: 'kỳ sau ›' }),
    ]),
    line('Chung', signed(summary.chung), `${summary.chungPlus} lần + · ${summary.chungMinus} lần −`),
    line('Riêng', signed(summary.rieng), summary.riengList.map(signed).join(', ')),
    line('Tổng', signed(summary.tong), `${summary.count} dòng`, true),
  );
  dom.sum.hidden = false;
}

function renderRows({ entries }) {
  clear(dom.rows).append(
    el('header', {}, [el('h2', { text: 'Chi tiết theo trận' })]),
    entries.length
      ? el('div', { class: 'scroll-x' }, [
          el('table', {}, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Ngày' }),
                el('th', { text: 'Nội dung' }),
                el('th', { class: 'num', text: 'Chung' }),
                el('th', { class: 'num', text: 'Riêng' }),
              ]),
            ]),
            el('tbody', {}, entries.map(row)),
          ]),
        ])
      : el('p', { class: 'empty', text: 'Kỳ này chưa có dòng nào.' }),
  );
  dom.rows.hidden = false;
}

function row(entry) {
  const d = new Date(entry.at);
  const when = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const what = [entry.label, entry.gameNumber ? `ván ${entry.gameNumber}` : null, entry.note]
    .filter(Boolean)
    .join(' · ');

  return el('tr', {}, [
    el('td', { text: when }),
    el('td', { text: what }),
    el('td', { class: 'num', text: (entry.chung ?? entry.dir) ? signed(entry.chung ?? entry.dir) : '' }),
    el('td', {
      class: 'num',
      text: Number.isFinite(entry.rieng) && entry.rieng ? signed(entry.rieng) : '',
    }),
  ]);
}
