/** Tiện ích dùng chung cho cả trang danh sách và trang chi tiết trận. */

export const TZ = 'Asia/Ho_Chi_Minh';

export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const clear = (node) => {
  node.replaceChildren();
  return node;
};

/* ------------------------------------------------------------------- số má */

/** 12345 -> "12,3k" — dùng cho vàng, nơi con số chính xác không quan trọng bằng độ lớn. */
export const compactGold = (n) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(Math.round(n));

export const signed = (n) => (n > 0 ? `+${n.toLocaleString('vi-VN')}` : n.toLocaleString('vi-VN'));

export const percent = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

/* ---------------------------------------------------------------- thời gian */

export const timeVN = (iso) =>
  new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

export const dateVN = (iso) =>
  new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: TZ });

export const dateTimeVN = (iso) => `${timeVN(iso)} · ${dateVN(iso)}`;

/** "trong 12 phút" / "3 giờ trước" — nhìn phát biết ngay còn bao lâu. */
export function relativeVN(iso, now = Date.now()) {
  const diffMinutes = Math.round((Date.parse(iso) - now) / 60000);
  const rtf = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
  const abs = Math.abs(diffMinutes);
  if (abs < 60) return rtf.format(diffMinutes, 'minute');
  if (abs < 60 * 24) return rtf.format(Math.round(diffMinutes / 60), 'hour');
  return rtf.format(Math.round(diffMinutes / 1440), 'day');
}

export const clock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/* --------------------------------------------------------------- hiển thị */

const STATE_LABEL = {
  inProgress: ['Đang diễn ra', 'badge--live'],
  unstarted: ['Sắp diễn ra', 'badge--upcoming'],
  completed: ['Đã kết thúc', 'badge--done'],
};

export function stateBadge(state) {
  const [label, cls] = STATE_LABEL[state] ?? [state, ''];
  return el('span', { class: `badge ${cls}`, text: label });
}

export const ROLE_VN = {
  top: 'Top',
  jungle: 'Rừng',
  mid: 'Mid',
  bottom: 'ADC',
  support: 'Hỗ trợ',
};

export const DRAGON_VN = {
  infernal: 'Hoả',
  ocean: 'Thuỷ',
  cloud: 'Phong',
  mountain: 'Thổ',
  hextech: 'Hextech',
  chemtech: 'Hoá học',
  elder: 'Elder',
};

/** Không có URL, hoặc ảnh hỏng, thì bỏ hẳn thẻ thay vì để icon vỡ. */
export const img = (src, attrs = {}) =>
  src ? el('img', { src, loading: 'lazy', onerror: (e) => e.target.remove(), ...attrs }) : null;

export function setStatus(node, message, isError = false) {
  clear(node);
  node.className = `status${isError ? ' status--error' : ''}`;
  node.textContent = message;
  node.hidden = false;
}
