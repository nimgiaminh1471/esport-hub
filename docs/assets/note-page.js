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

const dom = {
  status: document.getElementById('status'),
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
  const url = `${API}/note.json${period ? `?period=${encodeURIComponent(period)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  dom.status.hidden = true;
  renderSummary(data);
  renderRows(data);
}

/** `+7` / `-3` / `0` — luôn hiện dấu để đọc lướt biết ngay chiều. */
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** Giữ nguyên tham số đang có, chỉ đổi kỳ — để `?api=` không bị mất khi bấm qua lại. */
function hrefFor(nextPeriod) {
  const q = new URLSearchParams(location.search);
  q.set('period', nextPeriod);
  return `./note.html?${q}`;
}

function renderSummary({ range, summary, prev, next }) {
  const line = (label, value, meta, total = false) =>
    el('div', { class: `compare-row${total ? ' compare-row--total' : ''}` }, [
      el('div', { class: 'v v--blue', text: label }),
      el('div', { class: 'mid' }, [el('div', { class: 'label', text: meta ?? '' })]),
      el('div', { class: 'v v--red', text: signed(value) }),
    ]);

  clear(dom.sum).append(
    el('header', {}, [
      el('h2', { text: `Kỳ ${range.label}` }),
      el('span', { class: 'spacer' }),
      el('a', { class: 'game-tab', href: hrefFor(prev), text: '‹ kỳ trước' }),
      el('a', { class: 'game-tab', href: hrefFor(next), text: 'kỳ sau ›' }),
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
  const d = new Date(entry.at);
  const when = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const what = [entry.label, entry.gameNumber ? `ván ${entry.gameNumber}` : null, entry.note]
    .filter(Boolean)
    .join(' · ');

  return el('tr', {}, [
    el('td', { text: when }),
    el('td', { text: what }),
    el('td', { class: 'num', text: entry.dir ? signed(entry.dir) : '' }),
    el('td', {
      class: 'num',
      text: Number.isFinite(entry.rieng) && entry.rieng ? signed(entry.rieng) : '',
    }),
  ]);
}
