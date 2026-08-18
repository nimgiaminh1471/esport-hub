/**
 * Trang xem sổ ghi chú.
 *
 * Không có chỗ nào trong site trỏ tới trang này — cố ý. Dữ liệu nằm ở Worker
 * (KV), trang chỉ đọc qua `GET /note`. Trang không tự kiểm tra quyền: ai biết
 * đường dẫn đều xem được. Bù lại số để trần và không có tên người nên nhìn vào
 * chỉ là một cột số vô danh.
 */
import { el, clear, setStatus } from './ui.js';
import { formatEntry, signed } from './note-core.js';

/**
 * URL Worker — không phải bí mật (chính Slack cũng gọi vào đây), nhưng phải khớp
 * với tên worker đã deploy. Đổi ở đây nếu đổi tên worker.
 */
const API = 'https://esports-hub-slack.esport-slack.workers.dev';

const dom = {
  status: document.getElementById('status'),
  sum: document.getElementById('sum'),
  rows: document.getElementById('rows'),
};

const period = new URLSearchParams(location.search).get('period');

load().catch((err) => setStatus(dom.status, `Không tải được: ${err.message}`, true));

async function load() {
  const url = `${API}/note${period ? `?period=${encodeURIComponent(period)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  dom.status.hidden = true;
  renderSummary(data);
  renderRows(data);
}

function renderSummary({ range, summary, prev, next }) {
  const line = (label, value, extra, total = false) =>
    el('div', { class: `compare-row${total ? ' compare-row--total' : ''}` }, [
      el('div', { class: 'v v--blue', text: label }),
      el('div', { class: 'mid' }, [el('div', { class: 'label', text: extra ?? '' })]),
      el('div', { class: 'v v--red', text: signed(value) }),
    ]);

  clear(dom.sum).append(
    el('header', {}, [
      el('h2', { text: `Kỳ ${range.label}` }),
      el('span', { class: 'spacer' }),
      el('a', { class: 'game-tab', href: `./note.html?period=${prev}`, text: '‹ kỳ trước' }),
      el('a', { class: 'game-tab', href: `./note.html?period=${next}`, text: 'kỳ sau ›' }),
    ]),
    line('Chung', summary.chung, `${summary.chungPlus} lần + · ${summary.chungMinus} lần −`),
    line('Riêng', summary.rieng, summary.riengList.map(signed).join(', ')),
    line('Tổng', summary.tong, `${summary.count} dòng`, true),
  );
  dom.sum.hidden = false;
}

function renderRows({ entries }) {
  clear(dom.rows).append(
    el('header', {}, [el('h2', { text: 'Chi tiết' })]),
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
  // Dùng lại formatEntry để lấy phần ngày/nội dung y như trong Slack, khỏi lệch
  // cách hiển thị giữa hai nơi.
  const [when, ...whatParts] = formatEntry(entry).split(' · ');
  const what = whatParts
    .filter((p) => !p.startsWith('chung ') && !p.startsWith('riêng '))
    .join(' · ');

  return el('tr', {}, [
    el('td', { text: when }),
    el('td', { text: what }),
    el('td', { class: 'num', text: entry.dir ? signed(entry.dir) : '' }),
    el('td', { class: 'num', text: Number.isFinite(entry.rieng) && entry.rieng ? signed(entry.rieng) : '' }),
  ]);
}
