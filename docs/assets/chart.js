/**
 * Biểu đồ chênh lệch vàng — dạng diverging area quanh mốc 0.
 *
 * Chọn dạng này vì dữ liệu mang tính CỰC (ai đang dẫn), không phải độ lớn:
 * trên mốc 0 là phe xanh dẫn, dưới là phe đỏ dẫn, mốc 0 là màu xám trung tính
 * đọc ra "hoà". Vẽ hai đường gold riêng trên cùng một trục sẽ khó thấy khoảng
 * cách, còn hai trục y là sai (xem anti-pattern dual-axis).
 */
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 880;
const H = 280;
const PAD = { top: 18, right: 62, bottom: 30, left: 56 };

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  return node;
};

/** Bậc chia "đẹp" (1/2/5 × 10^n) để nhãn trục là số tròn. */
function niceStep(range, targetTicks = 4) {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find((m) => m * mag >= raw) * mag;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount   nơi gắn svg (phải position:relative để đặt tooltip)
 * @param {Array} opts.points        [{elapsedSeconds, blueGold, redGold, blueKills, redKills}]
 * @param {string} opts.blueName
 * @param {string} opts.redName
 */
export function renderGoldDiffChart({ mount, points, blueName, redName }) {
  mount.replaceChildren();

  const data = (points ?? []).filter((p) => Number.isFinite(p.elapsedSeconds));
  if (data.length < 2) {
    mount.append(el('p', { class: 'empty', text: 'Chưa đủ dữ liệu để vẽ biểu đồ.' }));
    return { destroy() {} };
  }

  const diffs = data.map((p) => p.blueGold - p.redGold);
  const maxAbs = Math.max(2000, ...diffs.map(Math.abs));
  // 3 vạch mỗi nhánh + 8% khoảng thở: đủ chỗ cho nhãn điểm cuối mà không để
  // đường dữ liệu bẹp dí ở giữa một trục quá rộng.
  const step = niceStep(maxAbs, 3);
  const yMax = Math.ceil((maxAbs * 1.08) / step) * step;
  const xMax = Math.max(60, data.at(-1).elapsedSeconds);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (s) => PAD.left + (s / xMax) * plotW;
  const y = (d) => PAD.top + plotH / 2 - (d / yMax) * (plotH / 2);
  const zeroY = y(0);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    tabindex: '0',
    'aria-label': `Chênh lệch vàng theo thời gian giữa ${blueName} và ${redName}`,
  });

  /* --- clip: nửa trên cho phe xanh, nửa dưới cho phe đỏ --------------- */
  const defs = svgEl('defs');
  for (const [id, yTop, height] of [
    ['clip-blue', PAD.top, zeroY - PAD.top],
    ['clip-red', zeroY, PAD.top + plotH - zeroY],
  ]) {
    const cp = svgEl('clipPath', { id });
    cp.append(svgEl('rect', { x: PAD.left, y: yTop, width: plotW, height: Math.max(0, height) }));
    defs.append(cp);
  }
  svg.append(defs);

  /* --- lưới: hairline liền nét, lùi về sau ---------------------------- */
  const grid = svgEl('g');
  for (let v = -yMax; v <= yMax; v += step) {
    if (v === 0) continue;
    grid.append(
      svgEl('line', {
        x1: PAD.left, x2: PAD.left + plotW, y1: y(v), y2: y(v),
        stroke: 'var(--grid)', 'stroke-width': 1,
      }),
    );
    const tick = svgEl('text', {
      x: PAD.left - 10, y: y(v) + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 11, 'font-variant-numeric': 'tabular-nums',
    });
    tick.textContent = `${v > 0 ? '+' : '−'}${Math.abs(v / 1000).toFixed(0)}k`;
    grid.append(tick);
  }
  svg.append(grid);

  /* --- trục x: mốc phút tròn ------------------------------------------ */
  const minuteStep = xMax > 2400 ? 600 : xMax > 1200 ? 300 : 120;
  for (let s = 0; s <= xMax; s += minuteStep) {
    const t = svgEl('text', {
      x: x(s), y: H - 10, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-size': 11, 'font-variant-numeric': 'tabular-nums',
    });
    t.textContent = `${Math.round(s / 60)}′`;
    svg.append(t);
  }

  /* --- vùng tô + đường, cắt theo dấu ---------------------------------- */
  const linePath = data.map((p, i) => `${i ? 'L' : 'M'}${x(p.elapsedSeconds)},${y(p.blueGold - p.redGold)}`).join('');
  const areaPath = `${linePath}L${x(data.at(-1).elapsedSeconds)},${zeroY}L${x(data[0].elapsedSeconds)},${zeroY}Z`;

  for (const [clip, color] of [['clip-blue', 'var(--blue)'], ['clip-red', 'var(--red)']]) {
    svg.append(svgEl('path', { d: areaPath, fill: color, 'fill-opacity': 0.1, 'clip-path': `url(#${clip})` }));
    svg.append(
      svgEl('path', {
        d: linePath, fill: 'none', stroke: color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'clip-path': `url(#${clip})`,
      }),
    );
  }

  /* --- mốc 0: đường trung tính, đọc ra "hoà" -------------------------- */
  svg.append(
    svgEl('line', {
      x1: PAD.left, x2: PAD.left + plotW, y1: zeroY, y2: zeroY,
      stroke: 'var(--axis)', 'stroke-width': 1,
    }),
  );

  /* --- điểm cuối + nhãn trực tiếp (chỉ một nhãn, không rải số) -------- */
  const last = data.at(-1);
  const lastDiff = last.blueGold - last.redGold;
  const leadColor = lastDiff >= 0 ? 'var(--blue)' : 'var(--red)';
  svg.append(
    svgEl('circle', {
      cx: x(last.elapsedSeconds), cy: y(lastDiff), r: 4.5,
      fill: leadColor, stroke: 'var(--surface)', 'stroke-width': 2,
    }),
  );
  const endLabel = svgEl('text', {
    x: x(last.elapsedSeconds) + 10,
    y: Math.min(Math.max(y(lastDiff) + 4, PAD.top + 10), PAD.top + plotH - 2),
    fill: 'var(--ink)', 'font-size': 12, 'font-weight': 600, 'font-variant-numeric': 'tabular-nums',
  });
  endLabel.textContent = `${lastDiff >= 0 ? '+' : '−'}${Math.abs(Math.round(lastDiff / 100) / 10)
    .toFixed(1)
    .replace('.', ',')}k`;
  svg.append(endLabel);

  /* --- lớp hover: crosshair + tooltip --------------------------------- */
  const cursor = svgEl('line', {
    y1: PAD.top, y2: PAD.top + plotH, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0,
  });
  const cursorDot = svgEl('circle', { r: 4.5, fill: 'var(--ink)', stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
  svg.append(cursor, cursorDot);

  const tip = el('div', { class: 'chart-tip', hidden: true });
  mount.append(svg, tip);

  let index = data.length - 1;

  const show = (i) => {
    index = Math.min(Math.max(i, 0), data.length - 1);
    const p = data[index];
    const d = p.blueGold - p.redGold;
    const px = x(p.elapsedSeconds);

    cursor.setAttribute('x1', px);
    cursor.setAttribute('x2', px);
    cursor.setAttribute('opacity', 1);
    cursorDot.setAttribute('cx', px);
    cursorDot.setAttribute('cy', y(d));
    cursorDot.setAttribute('opacity', 1);

    tip.hidden = false;
    tip.replaceChildren(
      el('div', { text: `Phút ${Math.round(p.elapsedSeconds / 60)}` }),
      el('div', { html: `${blueName} <b>${p.blueGold.toLocaleString('vi-VN')}</b> · ${p.blueKills}–${p.redKills} · <b>${redName}</b> ${p.redGold.toLocaleString('vi-VN')}` }),
      el('div', { html: `Chênh lệch <b>${d >= 0 ? '+' : '−'}${Math.abs(d).toLocaleString('vi-VN')}</b> nghiêng ${d >= 0 ? blueName : redName}` }),
    );

    // Quy đổi toạ độ viewBox -> pixel thật vì svg co giãn theo container.
    const scale = mount.clientWidth / W;
    const left = px * scale;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 4), mount.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(y(d) * scale - tip.offsetHeight - 12, 0)}px`;
  };

  const hide = () => {
    tip.hidden = true;
    cursor.setAttribute('opacity', 0);
    cursorDot.setAttribute('opacity', 0);
  };

  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const seconds = ((clientX - rect.left) / rect.width * W - PAD.left) / plotW * xMax;
    let best = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i].elapsedSeconds - seconds) < Math.abs(data[best].elapsedSeconds - seconds)) best = i;
    }
    return best;
  };

  const onMove = (e) => show(nearest(e.clientX));
  const onKey = (e) => {
    if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'Escape') hide();
    else return;
    e.preventDefault();
  };

  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(index));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', onKey);

  return {
    destroy() {
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('keydown', onKey);
      mount.replaceChildren();
    },
  };
}
