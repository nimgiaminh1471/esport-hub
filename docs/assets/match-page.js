/** Trang chi tiết một trận: chỉ số realtime, biểu đồ chênh lệch vàng, bảng người chơi. */
import * as lol from './lol-core.js';
import { loadAssets } from './ddragon.js';
import { renderGoldDiffChart } from './chart.js';
import {
  el, clear, img, setStatus, stateBadge, dateTimeVN, relativeVN,
  compactGold, percent, ROLE_VN, DRAGON_VN,
} from './ui.js';

const GAME_POLL_MS = 10_000;
const MATCH_POLL_MS = 30_000;

const dom = {
  status: document.getElementById('status'),
  head: document.getElementById('head'),
  games: document.getElementById('games'),
  chart: document.getElementById('chart'),
  compare: document.getElementById('compare'),
  players: document.getElementById('players'),
  updated: document.getElementById('updated'),
};

const state = {
  matchId: null,
  gameId: null,
  match: null,
  snapshot: null,
  timeline: [],
  assets: null,
  chart: null,
  timers: [],
};

boot().catch((err) => setStatus(dom.status, `Không tải được trận: ${err.message}`, true));

async function boot() {
  const params = new URLSearchParams(location.search);
  state.matchId = params.get('match');
  state.gameId = params.get('game');

  if (!state.matchId && !state.gameId) {
    setStatus(dom.status, 'Thiếu ID trận. Quay lại trang chủ để chọn trận hoặc dán ID vào ô tìm kiếm.');
    return;
  }

  // Chỉ có gameId thì lấy ngược matchId ra từ feed.
  if (!state.matchId) {
    const window = await lol.getWindow(state.gameId);
    if (!window) throw new Error('Không tìm thấy dữ liệu cho ID ván này.');
    state.matchId = String(window.esportsMatchId);
  }

  state.assets = await loadAssets();

  await refreshMatch();
  // Không ẩn #status ở đây: refreshGame() dùng chính chỗ này để báo
  // "ván chưa bắt đầu", và render() sẽ tự ẩn khi có số liệu.
  await refreshGame();

  state.timers.push(
    setInterval(() => refreshGame().catch(reportSoftError), GAME_POLL_MS),
    setInterval(() => refreshMatch().catch(reportSoftError), MATCH_POLL_MS),
  );

  // Tab ẩn thì ngừng poll cho đỡ tốn pin và request.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshGame().catch(reportSoftError);
  });
}

/* ------------------------------------------------------------------ nạp dữ liệu */

async function refreshMatch() {
  const match = await lol.getMatch(state.matchId);
  if (!match) throw new Error('Không tìm thấy trận với ID này.');
  state.match = match;

  document.title = `${match.teams.map((t) => t.code).join(' vs ')} — Esports Hub`;

  if (!state.gameId || !match.games.some((g) => g.id === state.gameId)) {
    state.gameId = pickGame(match)?.id ?? null;
  }

  renderHead(match);
  renderGameTabs(match);
}

/** Ưu tiên ván đang đá; chưa có thì ván cuối đã xong; chưa có nữa thì ván 1. */
function pickGame(match) {
  return (
    match.games.find((g) => g.state === 'inProgress') ??
    match.games.findLast((g) => g.state === 'completed') ??
    match.games[0]
  );
}

async function refreshGame() {
  if (!state.gameId) {
    renderNoGame('Trận chưa bắt đầu — chưa có ván nào để hiển thị chỉ số.');
    return;
  }

  if (document.hidden) return;

  const snapshot = await lol.getGameSnapshot(state.gameId);
  if (!snapshot) {
    renderNoGame('Ván này chưa bắt đầu. Số liệu sẽ xuất hiện sau khi vào game.');
    return;
  }

  const isNewGame = state.snapshot?.gameId !== snapshot.gameId;
  state.snapshot = snapshot;

  if (isNewGame) {
    state.timeline = [];
    // Mọi điểm phải cùng gốc thời gian là lúc ván bắt đầu, nếu không thì các
    // điểm tích luỹ khi mở trang sẽ lệch hẳn so với phần lịch sử nạp về.
    state.gameStartMs = Date.parse((await lol.getGameStart(snapshot.gameId)) ?? snapshot.timestamp);
    appendTimelinePoint(snapshot);
    loadTimeline(snapshot.gameId).catch(() => {});
  } else {
    appendTimelinePoint(snapshot);
  }

  render();
}

/** Lấy lịch sử để biểu đồ có hình ngay từ lần mở đầu tiên. */
async function loadTimeline(gameId) {
  const startTime = new Date(state.gameStartMs).toISOString();
  const history = await lol.getTimeline(gameId, { startTime, maxSamples: 40 });
  if (state.gameId !== gameId || !history.length) return;

  // Gộp theo bin 30 giây; điểm tích luỹ tại chỗ (mới hơn) thắng điểm lịch sử.
  const merged = new Map(history.map((p) => [Math.round(p.elapsedSeconds / 30), p]));
  for (const p of state.timeline) merged.set(Math.round(p.elapsedSeconds / 30), p);
  state.timeline = [...merged.values()].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
  render();
}

function appendTimelinePoint(snapshot) {
  const point = {
    timestamp: snapshot.timestamp,
    elapsedSeconds: Math.max(0, Math.round((Date.parse(snapshot.timestamp) - state.gameStartMs) / 1000)),
    blueGold: snapshot.blue.totalGold,
    redGold: snapshot.red.totalGold,
    blueKills: snapshot.blue.kills,
    redKills: snapshot.red.kills,
  };
  const last = state.timeline.at(-1);
  if (!last || point.elapsedSeconds > last.elapsedSeconds) state.timeline.push(point);
}

function reportSoftError(err) {
  // Mất mạng tạm thời: giữ nguyên số liệu cũ, chỉ báo ở dòng "cập nhật lúc".
  if (dom.updated) {
    dom.updated.textContent = `Mất kết nối, đang thử lại… (${err.message})`;
    dom.updated.style.color = 'var(--critical)';
  }
}

/* -------------------------------------------------------------------- render */

function render() {
  dom.status.hidden = true;
  renderCompare();
  renderChart();
  renderPlayers();
  renderUpdated();
}

function renderUpdated() {
  if (!dom.updated || !state.snapshot) return;
  const delay = (lol.FEED_DELAY_SECONDS / 60).toFixed(1).replace('.', ',');
  const patch = String(state.snapshot.patch ?? '').split('.').slice(0, 2).join('.') || '—';
  dom.updated.style.color = '';
  dom.updated.textContent =
    `Số liệu tính đến ${new Date(state.snapshot.timestamp).toLocaleTimeString('vi-VN')} · ` +
    `phiên bản ${patch} · trễ ~${delay} phút so với sóng trực tiếp (giới hạn của Riot)`;
}

function renderHead(match) {
  const [a, b] = match.teams;
  const team = (t, side) =>
    el('div', { class: `team team--${side}` }, [
      t.image ? img(t.image, { alt: '' }) : null,
      el('div', { class: 'who' }, [
        el('div', { class: 'name', text: t.name }),
        t.record ? el('div', { class: 'record', text: `${t.record.wins}–${t.record.losses}` }) : null,
      ]),
    ]);

  clear(dom.head).append(
    el('div', {
      class: 'league',
      text: [match.league.name, match.blockName, `Bo${match.strategy.count}`].filter(Boolean).join(' · '),
    }),
    el('div', { class: 'scoreline' }, [
      team(a, 'blue'),
      el('div', { class: 'score' }, [
        el('span', { class: a.wins >= b.wins ? 'win' : 'lose', text: a.wins }),
        el('span', { class: 'sep', text: '–' }),
        el('span', { class: b.wins >= a.wins ? 'win' : 'lose', text: b.wins }),
      ]),
      team(b, 'red'),
    ]),
    el('div', { class: 'meta' }, [
      stateBadge(match.state),
      match.startTime
        ? el('span', { text: `${dateTimeVN(match.startTime)} (${relativeVN(match.startTime)})` })
        : null,
      el('span', { id: 'updated' }),
    ]),
  );

  dom.updated = document.getElementById('updated');
  dom.head.hidden = false;
  renderUpdated(); // header vừa dựng lại thì bù ngay dòng "cập nhật lúc"
}

function renderGameTabs(match) {
  if (match.games.length <= 1) {
    dom.games.hidden = true;
    return;
  }

  clear(dom.games).append(
    ...match.games.map((game) =>
      el('button', {
        type: 'button',
        role: 'tab',
        'data-state': game.state,
        'aria-selected': String(game.id === state.gameId),
        text: `Ván ${game.number}`,
        disabled: game.state === 'unstarted',
        onclick: () => {
          state.gameId = game.id;
          state.timeline = [];
          state.timelineStartMs = null;
          state.snapshot = null;
          renderGameTabs(match);
          refreshGame().catch(reportSoftError);
        },
      }),
    ),
  );
  dom.games.hidden = false;
}

function renderNoGame(message) {
  for (const node of [dom.chart, dom.compare, dom.players]) node.hidden = true;
  setStatus(dom.status, message);
}

/** Đội xanh/đỏ đổi theo từng ván, nên phải khớp lại bằng id đội mỗi lần render. */
function sides() {
  const find = (id) => state.match?.teams.find((t) => t.id === id);
  return {
    blue: { ...state.snapshot.blue, team: find(state.snapshot.blue.esportsTeamId) ?? state.match?.teams[0] },
    red: { ...state.snapshot.red, team: find(state.snapshot.red.esportsTeamId) ?? state.match?.teams[1] },
  };
}

function renderCompare() {
  const { blue, red } = sides();
  const rows = [
    ['Vàng', blue.totalGold, red.totalGold, compactGold],
    ['Hạ gục', blue.kills, red.kills],
    ['Trụ', blue.towers, red.towers],
    ['Nhà lính', blue.inhibitors, red.inhibitors],
    ['Baron', blue.barons, red.barons],
  ];

  const body = rows.map(([label, bv, rv, format = String]) => {
    const total = bv + rv;
    return el('div', { class: 'compare-row' }, [
      el('div', { class: 'v v--blue', text: format(bv) }),
      el('div', { class: 'mid' }, [
        el('div', { class: 'label', text: label }),
        el('div', { class: 'split' }, [
          el('i', { class: 'b', style: `width:${total ? (bv / total) * 100 : 0}%` }),
          el('i', { class: 'r', style: `width:${total ? (rv / total) * 100 : 0}%` }),
        ]),
      ]),
      el('div', { class: 'v v--red', text: format(rv) }),
    ]);
  });

  // Rồng là danh sách loại, không phải một con số — hiển thị dạng chip.
  // Chip của mỗi phe dạt về phía cột số của phe đó, nếu không thì khi cả hai
  // đội cùng có rồng sẽ không biết chip nào của ai.
  const dragonChips = (list, side) =>
    el('div', { class: `chips chips--${side}` }, list.map((d) => el('span', { class: 'chip', text: DRAGON_VN[d] ?? d })));

  body.push(
    el('div', { class: 'compare-row' }, [
      el('div', { class: 'v v--blue', text: blue.dragons.length }),
      el('div', { class: 'mid' }, [
        el('div', { class: 'label', text: 'Rồng' }),
        el('div', { class: 'dragons' }, [dragonChips(blue.dragons, 'b'), dragonChips(red.dragons, 'r')]),
      ]),
      el('div', { class: 'v v--red', text: red.dragons.length }),
    ]),
  );

  clear(dom.compare).append(
    el('header', {}, [el('h2', { text: 'Chỉ số đội' })]),
    ...body,
  );
  dom.compare.hidden = false;
}

function renderChart() {
  const { blue, red } = sides();
  const blueName = blue.team?.code ?? 'Xanh';
  const redName = red.team?.code ?? 'Đỏ';

  const wrap = el('div', { class: 'chart-wrap' });
  const table = buildChartTable(blueName, redName);
  table.hidden = true;

  const toggle = el('button', {
    type: 'button',
    text: 'Xem dạng bảng',
    'aria-expanded': 'false',
    onclick: () => {
      const showTable = table.hidden;
      table.hidden = !showTable;
      wrap.hidden = showTable;
      toggle.textContent = showTable ? 'Xem dạng biểu đồ' : 'Xem dạng bảng';
      toggle.setAttribute('aria-expanded', String(showTable));
    },
  });

  clear(dom.chart).append(
    el('header', {}, [
      el('h2', { text: 'Chênh lệch vàng' }),
      el('div', { class: 'legend' }, [
        el('span', {}, [el('i', { style: 'background:var(--blue)' }), `${blueName} dẫn`]),
        el('span', {}, [el('i', { style: 'background:var(--red)' }), `${redName} dẫn`]),
      ]),
      el('span', { class: 'spacer' }),
      toggle,
    ]),
    wrap,
    table,
  );

  state.chart = renderGoldDiffChart({ mount: wrap, points: state.timeline, blueName, redName });
  dom.chart.hidden = false;
}

/** Bản song sinh dạng bảng của biểu đồ — mọi giá trị đều đọc được không cần hover. */
function buildChartTable(blueName, redName) {
  return el('div', { class: 'scroll-x' }, [
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Phút' }),
          el('th', { class: 'num', text: `${blueName} vàng` }),
          el('th', { class: 'num', text: `${redName} vàng` }),
          el('th', { class: 'num', text: 'Chênh lệch' }),
          el('th', { class: 'num', text: 'Hạ gục' }),
        ]),
      ]),
      el('tbody', {}, state.timeline.map((p) => {
        const diff = p.blueGold - p.redGold;
        return el('tr', {}, [
          el('td', { text: Math.round(p.elapsedSeconds / 60) }),
          el('td', { class: 'num', text: p.blueGold.toLocaleString('vi-VN') }),
          el('td', { class: 'num', text: p.redGold.toLocaleString('vi-VN') }),
          el('td', { class: 'num', text: `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('vi-VN')}` }),
          el('td', { class: 'num', text: `${p.blueKills}–${p.redKills}` }),
        ]);
      })),
    ]),
  ]);
}

function renderPlayers() {
  const { blue, red } = sides();
  clear(dom.players).append(
    el('header', {}, [el('h2', { text: 'Người chơi' })]),
    ...[
      ['b', blue, 'var(--blue)'],
      ['r', red, 'var(--red)'],
    ].flatMap(([cls, side, color]) => [
      el('div', { class: 'side-head' }, [
        el('i', { class: cls }),
        side.team?.name ?? (cls === 'b' ? 'Đội xanh' : 'Đội đỏ'),
      ]),
      playerTable(side, color),
    ]),
  );
  dom.players.hidden = false;
}

function playerTable(side, color) {
  const { assets } = state;
  const maxDamageShare = Math.max(0.01, ...side.participants.map((p) => p.championDamageShare ?? 0));

  return el('div', { class: 'scroll-x' }, [
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Tướng' }),
          el('th', { class: 'num', text: 'Lv' }),
          el('th', { class: 'num', text: 'K/D/A' }),
          el('th', { class: 'num', text: 'Lính' }),
          el('th', { class: 'num', text: 'Vàng' }),
          el('th', { text: 'Máu' }),
          el('th', { text: 'Trang bị' }),
          el('th', { class: 'num', text: 'Sát thương' }),
          el('th', { class: 'num', text: 'Mắt' }),
        ]),
      ]),
      el('tbody', {}, side.participants.map((p) => {
        const keystone = assets.keystone(p.perks);
        const hpPercent = p.maxHealth ? (p.currentHealth / p.maxHealth) * 100 : 0;
        return el('tr', {}, [
          el('td', {}, [
            el('div', { class: 'champ' }, [
              img(assets.champion(p.championId), { alt: p.championId, title: p.championId }),
              el('div', { class: 'who' }, [
                el('div', { class: 'player', text: p.summonerName }),
                el('div', { class: 'role', text: `${ROLE_VN[p.role] ?? p.role} · ${p.championId}` }),
              ]),
              keystone ? img(keystone.icon, { alt: keystone.name, title: keystone.name, width: 20, height: 20 }) : null,
            ]),
          ]),
          el('td', { class: 'num', text: p.level }),
          el('td', { class: 'num', text: `${p.kills}/${p.deaths}/${p.assists}` }),
          el('td', { class: 'num', text: p.creepScore }),
          el('td', { class: 'num', text: compactGold(p.totalGold) }),
          el('td', {}, [
            el('div', { class: 'hp', title: `${p.currentHealth}/${p.maxHealth}` }, [
              el('i', { style: `width:${hpPercent}%` }),
            ]),
          ]),
          el('td', {}, [
            // 6 ô trang bị + 1 ô mắt/trinket, luôn cố định để các hàng thẳng cột.
            el('div', { class: 'items' }, Array.from({ length: 7 }, (_, i) => {
              const url = assets.item(p.items[i]);
              return el('i', { style: url ? `background-image:url(${url})` : null });
            })),
          ]),
          el('td', { class: 'num' }, [
            el('div', { class: 'dmg' }, [
              el('span', { text: percent(p.championDamageShare) }),
              el('div', { class: 'bar' }, [
                el('i', {
                  style: `width:${((p.championDamageShare ?? 0) / maxDamageShare) * 100}%;background:${color}`,
                }),
              ]),
            ]),
          ]),
          el('td', { class: 'num', text: p.wardsPlaced ?? '—' }),
        ]);
      })),
    ]),
  ]);
}
