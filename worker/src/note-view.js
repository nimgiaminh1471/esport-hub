/**
 * note-view.js — trang HTML xem sổ, do chính Worker trả về.
 *
 * Vì sao không đặt trang này trong `docs/`: `docs/` được GitHub Pages publish nên
 * trang sẽ nằm ở một đường dẫn đoán được trên site công khai. Để Worker trả thì
 * trang chỉ tồn tại sau URL của Worker — URL đó không nằm trong repo, không có
 * chỗ nào trỏ tới, và cũng khỏi phải hardcode địa chỉ Worker vào code (subdomain
 * `workers.dev` do tài khoản Cloudflare đặt, không đoán được).
 *
 * Kèm lợi ích phụ: cùng origin nên không cần CORS, và trang tự chứa nên không
 * phụ thuộc gì vào Pages.
 */
import { shiftPeriod, signed } from './note-core.js';
import { dayLabel, fmt } from './day-core.js';

/** Chuỗi do người dùng gõ (nhãn, ghi chú) phải escape trước khi nhét vào HTML. */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
:root{color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;--surface-2:#222220;
--ink:#fff;--ink-2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;
--border:rgba(255,255,255,.1);--radius:10px;--font:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);font-family:var(--font);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.card>header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.spacer{margin-left:auto}
a{color:var(--muted);text-decoration:none;font-size:13px;padding:5px 10px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
a:hover{color:var(--ink-2);border-color:var(--border)}
.row{display:grid;grid-template-columns:64px 1fr 90px;align-items:center;gap:14px;padding:11px 0;border-top:1px solid var(--grid)}
.row:first-of-type{border-top:none}
.row .k{font-size:17px;font-weight:600}
.row .m{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;text-align:center}
.row .v{font-size:17px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.row--total{border-top:2px solid var(--axis)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:0 8px 9px;white-space:nowrap}
td{padding:8px;border-top:1px solid var(--grid);vertical-align:middle}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.empty{color:var(--muted);font-size:14px;padding:6px 0;margin:0}
.scroll{overflow-x:auto}
/* Bảng đứng ngay dưới khối tổng kết thì hai đường kẻ dính vào nhau. */
.row+.scroll,.row+.empty{margin-top:18px}
`;

/**
 * `value` nhận CHUỖI đã định dạng sẵn, không phải số: sổ nhập tay dùng `signed`
 * (số nguyên), phần theo ngày dùng `fmt` (số nguyên 1/100). Để hàm này tự đoán
 * cách hiển thị là chuyện sớm muộn cũng in sai một trong hai.
 */
function summaryRow(label, value, meta, total = false) {
  return `<div class="row${total ? ' row--total' : ''}">
    <div class="k">${esc(label)}</div>
    <div class="m">${esc(meta)}</div>
    <div class="v">${esc(value)}</div>
  </div>`;
}

function detailRows(entries) {
  if (!entries.length) return '<p class="empty">Kỳ này chưa có dòng nào.</p>';

  const body = entries
    .map((e) => {
      const d = new Date(e.at);
      const when = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const what = [e.label, e.gameNumber ? `ván ${e.gameNumber}` : null, e.note]
        .filter(Boolean)
        .map(esc)
        .join(' · ');
      return `<tr>
        <td>${when}</td>
        <td>${what}</td>
        <td class="n">${(e.chung ?? e.dir) ? esc(signed(e.chung ?? e.dir)) : ''}</td>
        <td class="n">${Number.isFinite(e.rieng) && e.rieng ? esc(signed(e.rieng)) : ''}</td>
      </tr>`;
    })
    .join('');

  return `<div class="scroll"><table>
    <thead><tr><th>Ngày</th><th>Nội dung</th><th class="n">Chung</th><th class="n">Riêng</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** Bảng các ngày đã chốt trong tháng. */
function dayRows(days) {
  if (!days.length) return '<p class="empty">Tháng này chưa có ngày nào được chốt.</p>';

  const body = days
    .map(
      (d) => `<tr>
        <td>${esc(dayLabel(d.day))}</td>
        <td class="n">${esc(fmt(d.profitUnits))}</td>
        <td class="n">${esc(fmt(d.doiTacUnits))}</td>
        <td class="n">${esc(fmt(d.minhUnits))}</td>
      </tr>`,
    )
    .join('');

  return `<div class="scroll"><table>
    <thead><tr><th>Ngày</th><th class="n">Lãi</th><th class="n">Đối tác</th><th class="n">Còn lại</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** Trang tự chứa, không gọi ra ngoài, không script. */
export function renderNotePage(snapshot) {
  const { range, summary, entries, prev, next, ngay } = snapshot;

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Ghi chú</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head><body><main>

<section class="card">
  <header>
    <h2>Theo ngày · ${esc(ngay.month)}</h2>
    <span class="spacer"></span>
    <a href="?month=${esc(shiftPeriod(ngay.month, -1))}">‹ tháng trước</a>
    <a href="?month=${esc(shiftPeriod(ngay.month, 1))}">tháng sau ›</a>
  </header>
  ${summaryRow('Lãi', fmt(ngay.total.profitUnits), `${ngay.total.days} ngày · ${ngay.total.count} vị thế`)}
  ${summaryRow('Đối tác', fmt(ngay.total.doiTacUnits), `${ngay.total.wins} thắng · ${ngay.total.losses} thua`)}
  ${summaryRow('Còn lại', fmt(ngay.total.minhUnits), '', true)}
  ${dayRows(ngay.days)}
</section>

<section class="card">
  <header>
    <h2>Nhập tay · kỳ ${esc(range.label)}</h2>
    <span class="spacer"></span>
    <a href="?period=${esc(prev)}">‹ kỳ trước</a>
    <a href="?period=${esc(next)}">kỳ sau ›</a>
  </header>
  ${summaryRow('Chung', signed(summary.chung), `${summary.chungPlus} lần + · ${summary.chungMinus} lần −`)}
  ${summaryRow('Riêng', signed(summary.rieng), summary.riengList.map(signed).join(', '))}
  ${summaryRow('Tổng', signed(summary.tong), `${summary.count} dòng`, true)}
</section>

<section class="card">
  <header><h2>Chi tiết nhập tay</h2></header>
  ${detailRows(entries)}
</section>

</main></body></html>`;
}
