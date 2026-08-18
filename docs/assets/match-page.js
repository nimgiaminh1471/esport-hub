/** Trang chi tiết một trận: chỉ số realtime, biểu đồ chênh lệch vàng, bảng người chơi. */
import { getProvider, gameFromSearch } from './games.js';
import { loadAssets } from './ddragon.js';
import { renderGoldDiffChart } from './chart.js';
import { mountPreviewPanel } from './preview-panel.js';
import {
  el, clear, img, setStatus, stateBadge, dateTimeVN, relativeVN,
  compactGold, percent, ROLE_VN, DRAGON_VN, LANE_ORDER,
} from './ui.js';

const GAME_POLL_MS = 10_000;
const MATCH_POLL_MS = 30_000;

// Tên `sport` chứ không phải `game`: trong file này `game` đã mang nghĩa "một ván".
const sport = gameFromSearch(location.search);
const provider = getProvider(sport);
const unit = provider.terms?.unit ?? 'Ván';

/** Riot tắt livestats cả giải, poll lại cũng không có gì — xem `isStatsDisabled`. */
const NO_LIVESTATS_MSG =
  'Riot không mở livestats cho ván này (thường gặp ở các giải khu vực), nên không có chỉ số trực tiếp. Lịch, tỉ số và kết quả vẫn cập nhật bình thường.';

/**
 * Game không hề có feed chỉ số (Valorant). Nói rõ đây là giới hạn VĨNH VIỄN chứ
 * không phải "sắp có" — Riot không phát hành feed livestats cho Valorant, không
 * có endpoint nào khác để tìm.
 */
const NO_FEED_MSG =
  `Riot không cung cấp feed chỉ số trong trận cho ${provider.name}, nên trang này chỉ có ` +
  'lịch, tỉ số series và danh sách map. Đây là giới hạn của Riot, không phải lỗi.';

const dom = {
  status: document.getElementById('status'),
  brand: document.getElementById('brand-game'),
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
  // Kiểu xem do người dùng chọn, phải nằm ở state vì render() dựng lại DOM mỗi
  // 10 giây — giữ trong DOM thì cứ đến nhịp poll là bị bật về mặc định.
  chartView: 'chart',
  playersView: 'lane',
  peek: null,
};

if (dom.brand) dom.brand.textContent = `· ${sport === 'lol' ? 'LoL' : provider.name}`;

boot().catch((err) => setStatus(dom.status, `Không tải được trận: ${err.message}`, true));

async function boot() {
  const params = new URLSearchParams(location.search);
  state.matchId = params.get('match');
  state.gameId = params.get('game');

  if (!state.matchId && !state.gameId) {
    setStatus(dom.status, 'Thiếu ID trận. Quay lại trang chủ để chọn trận hoặc dán ID vào ô tìm kiếm.');
    return;
  }

  // Chỉ có gameId thì lấy ngược matchId ra từ feed. Hỏi frame đầu ván vì ván bị
  // tắt livestats vẫn trả về frame đó — vẫn đủ để biết ván thuộc trận nào.
  // Không có feed thì không tra ngược được, phải yêu cầu ID trận.
  if (!state.matchId) {
    if (!provider.capabilities.liveStats) {
      setStatus(dom.status, `Trang ${provider.name} cần ID trận (\`?match=\`) — không tra ngược được từ ID map.`);
      return;
    }
    const window = await provider.getWindow(state.gameId, { fromStart: true });
    if (!window) throw new Error('Không tìm thấy dữ liệu cho ID ván này.');
    state.matchId = String(window.esportsMatchId);
  }

  // Ảnh tướng/trang bị là chuyện riêng của LoL — game khác nạp về cũng vô ích.
  if (provider.capabilities.liveStats) state.assets = await loadAssets();

  await refreshMatch();
  // Không ẩn #status ở đây: refreshGame() dùng chính chỗ này để báo
  // "ván chưa bắt đầu", và render() sẽ tự ẩn khi có số liệu.
  await refreshGame();

  state.timers.push(setInterval(() => refreshMatch().catch(reportSoftError), MATCH_POLL_MS));

  // Không có chỉ số thì không có gì để poll mỗi 10 giây.
  if (!provider.capabilities.liveStats) return;

  state.timers.push(setInterval(() => refreshGame().catch(reportSoftError), GAME_POLL_MS));

  // Tab ẩn thì ngừng poll cho đỡ tốn pin và request.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshGame().catch(reportSoftError);
  });
}

/* ------------------------------------------------------------------ nạp dữ liệu */

async function refreshMatch() {
  const match = await provider.getMatch(state.matchId);
  if (!match) throw new Error('Không tìm thấy trận với ID này.');
  state.match = match;

  document.title = `${match.teams.map((t) => t.code).join(' vs ')} — Esports Hub`;

  if (!state.gameId || !match.games.some((g) => g.id === state.gameId)) {
    state.gameId = pickGame(match)?.id ?? null;
  }

  renderHead(match);
  renderGameTabs(match);

  // Gắn MỘT lần. refreshMatch chạy lại mỗi 30 giây, gắn lại mỗi lượt sẽ đẻ ra
  // hàng chồng khay và làm mất trạng thái đang mở.
  if (!state.peek) state.peek = mountPreviewPanel(provider, match);
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
  // Game không có feed thì không bao giờ có chỉ số — nói thẳng thay vì để người
  // đọc tưởng "ván chưa bắt đầu" trên một series đã xong từ lâu.
  if (!provider.capabilities.liveStats) {
    renderNoGame(NO_FEED_MSG);
    return;
  }

  if (!state.gameId) {
    renderNoGame(`Trận chưa bắt đầu — chưa có ${unit.toLowerCase()} nào để hiển thị chỉ số.`);
    return;
  }

  if (document.hidden) return;

  if (provider.isStatsDisabled(state.gameId)) {
    renderNoGame(NO_LIVESTATS_MSG);
    return;
  }

  const snapshot = await provider.getGameSnapshot(state.gameId);
  if (!snapshot) {
    renderNoGame(
      provider.isStatsDisabled(state.gameId)
        ? NO_LIVESTATS_MSG
        : 'Ván này chưa bắt đầu. Số liệu sẽ xuất hiện sau khi vào game.',
    );
    return;
  }

  const isNewGame = state.snapshot?.gameId !== snapshot.gameId;
  state.snapshot = snapshot;

  if (isNewGame) {
    state.timeline = [];
    // Mọi điểm phải cùng gốc thời gian là lúc ván bắt đầu, nếu không thì các
    // điểm tích luỹ khi mở trang sẽ lệch hẳn so với phần lịch sử nạp về.
    state.gameStartMs = Date.parse((await provider.getGameStart(snapshot.gameId)) ?? snapshot.timestamp);
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
  const history = await provider.getTimeline(gameId, { startTime, maxSamples: 40 });
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
  const delay = (provider.capabilities.feedDelaySeconds / 60).toFixed(1).replace('.', ',');
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
  // Tab chỉ để chọn ván xem chỉ số. Game không có chỉ số thì bấm vào cũng ra
  // đúng một thông báo — bảng "Các map" bên dưới đã nói đủ rồi.
  if (match.games.length <= 1 || !provider.capabilities.liveStats) {
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
        text: `${unit} ${game.number}`,
        // `unneeded` (map thừa của Bo3 đã ngã ngũ) cũng không bấm được — nếu chỉ
        // chặn 'unstarted' thì nó hiện ra như nút bấm được nhưng dẫn tới hư không.
        disabled: !['completed', 'inProgress'].includes(game.state),
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

  // Không có chỉ số không có nghĩa là không có gì để xem: danh sách map, phe
  // xanh/đỏ từng map và link VOD đều có sẵn trong getEventDetails.
  if (!provider.capabilities.liveStats && state.match) renderMapList(state.match);
}

/**
 * Bảng map cho game không có feed chỉ số.
 *
 * Riot KHÔNG trả tên map (Bind/Haven/...) lẫn tỉ số từng map — chỉ có số thứ tự,
 * trạng thái, phe xanh/đỏ và VOD. Nên ở đây chỉ hiện đúng chừng đó, không bịa.
 */
function renderMapList(match) {
  const teamName = (id) => match.teams.find((t) => t.id === id)?.code ?? '—';

  const rows = match.games.map((game) => {
    const blue = game.teams.find((t) => t.side === 'blue');
    const red = game.teams.find((t) => t.side === 'red');
    const vod = game.vods?.[0];

    return el('div', { class: 'compare-row' }, [
      el('div', { class: 'v v--blue', text: blue ? teamName(blue.id) : '' }),
      el('div', { class: 'mid' }, [
        el('div', { class: 'label', text: `${unit} ${game.number}` }),
        el('div', {}, [stateBadge(game.state)]),
      ]),
      el('div', { class: 'v v--red' }, [
        el('span', { text: red ? teamName(red.id) : '' }),
        vod?.parameter
          ? el('a', {
              class: 'chip',
              style: 'margin-left:8px',
              href: `https://youtu.be/${encodeURIComponent(vod.parameter)}`,
              target: '_blank',
              rel: 'noopener',
              text: 'VOD',
            })
          : null,
      ]),
    ]);
  });

  clear(dom.compare).append(
    el('header', {}, [
      el('h2', { text: `Các ${unit.toLowerCase()}` }),
      el('span', { class: 'eyebrow', text: 'phe xanh · đỏ' }),
    ]),
    ...rows,
  );
  dom.compare.hidden = false;
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
  const showTable = state.chartView === 'table';

  const wrap = el('div', { class: 'chart-wrap' });
  wrap.hidden = showTable;
  const table = buildChartTable(blueName, redName);
  table.hidden = !showTable;

  const toggle = el('button', {
    type: 'button',
    text: showTable ? 'Xem dạng biểu đồ' : 'Xem dạng bảng',
    'aria-expanded': String(showTable),
    onclick: () => {
      state.chartView = showTable ? 'chart' : 'table';
      renderChart();
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
  const showTable = state.playersView === 'table';

  const toggle = el('button', {
    type: 'button',
    text: showTable ? 'Xem dạng đối đầu' : 'Xem dạng bảng',
    'aria-expanded': String(showTable),
    onclick: () => {
      state.playersView = showTable ? 'lane' : 'table';
      renderPlayers();
    },
  });

  clear(dom.players).append(
    el('header', {}, [
      el('h2', { text: 'Người chơi' }),
      el('span', { class: 'spacer' }),
      toggle,
    ]),
    showTable ? playerTables(blue, red) : laneMatchups(blue, red),
  );
  dom.players.hidden = false;
}

const sideName = (side, cls) => side.team?.name ?? (cls === 'b' ? 'Đội xanh' : 'Đội đỏ');

/* ------------------------------------------------- đối đầu từng đường */

/**
 * Ghép người chơi hai phe theo đường, xếp đối xứng quanh một cột giữa để so
 * sánh trực tiếp: mọi chỉ số của phe đỏ nằm cùng khoảng cách tới trục giữa như
 * chỉ số cùng loại của phe xanh, nên đọc ngang là ra ai hơn ai.
 */
function laneMatchups(blue, red) {
  const pairs = lanePairs(blue, red);

  // Một thang chung cho cả 5 đường để so được "đường nào chênh nhiều nhất".
  // Chặn dưới 800 vàng để mấy phút đầu, khi chênh lệch mới vài chục vàng, thanh
  // không bị kéo dài hết cỡ làm tưởng là đang thắng đậm.
  const scale = Math.max(800, ...pairs.map((p) => Math.abs(goldDiff(p))));
  const maxDamage = Math.max(
    0.01,
    ...[...blue.participants, ...red.participants].map((p) => p.championDamageShare ?? 0),
  );

  return el('div', { class: 'lanes' }, [
    el('div', { class: 'lane-row lane-row--head' }, [
      laneTeamHead(blue, 'b'),
      el('div', { class: 'lane-mid lane-label', text: 'Chênh lệch' }),
      laneTeamHead(red, 'r'),
    ]),
    ...pairs.map((pair) =>
      el('div', { class: 'lane-row' }, [
        lanePlayer(pair.blue, 'b', { maxDamage }),
        laneMid(pair, scale),
        lanePlayer(pair.red, 'r', { maxDamage }),
      ]),
    ),
  ]);
}

const goldDiff = (pair) => (pair.blue?.totalGold ?? 0) - (pair.red?.totalGold ?? 0);

/**
 * Feed trả `role` cho từng người, nhưng đây là API nội bộ nên không chắc lúc nào
 * cũng đủ 5 vai khác nhau mỗi phe. Thiếu hoặc lạ thì ghép theo thứ tự để không
 * người chơi nào bị rơi khỏi bảng.
 */
function lanePairs(blue, red) {
  const byRole = (side) => {
    const map = new Map();
    for (const p of side.participants) if (!map.has(p.role)) map.set(p.role, p);
    return map;
  };
  const b = byRole(blue);
  const r = byRole(red);

  if (LANE_ORDER.every((role) => b.has(role) && r.has(role))) {
    return LANE_ORDER.map((role) => ({ role, blue: b.get(role), red: r.get(role) }));
  }

  const rows = Math.max(blue.participants.length, red.participants.length);
  return Array.from({ length: rows }, (_, i) => ({
    role: blue.participants[i]?.role ?? red.participants[i]?.role ?? '—',
    blue: blue.participants[i] ?? null,
    red: red.participants[i] ?? null,
  }));
}

function laneTeamHead(side, cls) {
  return el('div', { class: `lane-side lane-side--${cls}` }, [
    el('div', { class: 'lane-team' }, [
      el('i', { class: cls }),
      el('span', { class: 'nm', text: sideName(side, cls) }),
      // Nhãn đơn vị cho hai cột số trần bên trong, đặt ở đây một lần thay vì
      // gắn chữ "lính" vào từng hàng như bảng cũ.
      el('span', { class: 'lane-unit', text: 'Lính' }),
    ]),
    el('div', { class: 'lane-gold lane-gold--head', text: 'Vàng' }),
  ]);
}

/** Cột giữa: tên đường + chênh lệch vàng của cặp, thanh mọc về phía đang dẫn. */
function laneMid(pair, scale) {
  const diff = goldDiff(pair);
  const leader = diff === 0 ? null : diff > 0 ? 'b' : 'r';
  const name = leader === 'b' ? pair.blue?.summonerName : pair.red?.summonerName;

  // Nửa track = 50%, nên |diff|/scale được ánh xạ vào đúng một nửa.
  const width = Math.min(50, (Math.abs(diff) / scale) * 50);

  return el('div', { class: 'lane-mid' }, [
    el('div', { class: 'lane-label', text: ROLE_VN[pair.role] ?? pair.role }),
    el('div', {
      class: `lane-diff${leader ? ` lane-diff--${leader}` : ''}`,
      text: leader ? compactGold(Math.abs(diff)) : '0',
      title: leader
        ? `${name} hơn ${Math.abs(diff).toLocaleString('vi-VN')} vàng`
        : 'Hai bên đang bằng vàng',
    }),
    el('div', { class: 'lane-track' }, [
      leader
        ? el('i', {
            class: leader,
            // Mọc từ vạch giữa: phe xanh sang trái, phe đỏ sang phải.
            style: leader === 'b' ? `right:50%;width:${width}%` : `left:50%;width:${width}%`,
          })
        : null,
    ]),
  ]);
}

function lanePlayer(p, cls, { maxDamage }) {
  if (!p) return el('div', { class: `lane-side lane-side--${cls} lane-side--empty`, text: '—' });

  const { assets } = state;
  const keystone = assets.keystone(p.perks);
  const hpPercent = p.maxHealth ? (p.currentHealth / p.maxHealth) * 100 : 0;
  const share = p.championDamageShare ?? 0;

  return el('div', { class: `lane-side lane-side--${cls}` }, [
    el('div', { class: 'lane-portrait' }, [
      img(assets.champion(p.championId), { alt: p.championId, title: p.championId }),
      el('span', { class: 'lv', text: p.level, title: `Cấp ${p.level}` }),
      el('div', { class: 'hp', title: `Máu ${p.currentHealth}/${p.maxHealth}` }, [
        el('i', { style: `width:${hpPercent}%` }),
      ]),
    ]),
    el('div', { class: 'lane-info' }, [
      // Ba số chính (lính, K/D/A, vàng) làm nổi như bảng điểm trên sóng: số trần,
      // không đơn vị, đậm hơn hẳn hai chỉ số phụ ở dưới.
      el('div', { class: 'lane-name' }, [
        keystone ? img(keystone.icon, { alt: '', title: keystone.name, width: 17, height: 17 }) : null,
        el('span', { class: 'player', text: p.summonerName }),
        el('span', { class: 'champ-name', text: p.championId }),
        el('span', { class: 'cs', text: p.creepScore, title: `${p.creepScore} lính hạ được` }),
      ]),
      // K/D/A nằm ngay dưới số lính, sát trục giữa như bảng điểm trên sóng; hai
      // chỉ số phụ lùi ra phía ngoài.
      el('div', { class: 'lane-stats' }, [
        el('span', { class: 'lane-dmg', title: 'Tỉ lệ sát thương lên tướng trong đội' }, [
          el('span', { text: percent(p.championDamageShare) }),
          el('span', { class: 'bar' }, [
            el('i', { style: `width:${(share / maxDamage) * 100}%;background:var(--${cls === 'b' ? 'blue' : 'red'})` }),
          ]),
        ]),
        el('span', { class: 'wards', text: `${p.wardsPlaced ?? '—'} mắt`, title: 'Mắt đã đặt' }),
        el('span', {
          class: 'kda',
          text: `${p.kills}/${p.deaths}/${p.assists}`,
          title: 'Hạ gục / tử vong / hỗ trợ',
        }),
      ]),
      itemRow(p),
    ]),
    el('div', {
      class: 'lane-gold',
      text: compactGold(p.totalGold),
      title: `${p.totalGold.toLocaleString('vi-VN')} vàng`,
    }),
  ]);
}

/** 6 ô trang bị + 1 ô mắt/trinket, luôn cố định để các hàng thẳng cột. */
function itemRow(p) {
  return el('div', { class: 'items' }, Array.from({ length: 7 }, (_, i) => {
    const url = state.assets.item(p.items[i]);
    return el('i', { style: url ? `background-image:url(${url})` : null });
  }));
}

/* ------------------------------------------------------- dạng bảng đầy đủ */

/** Bản song sinh dạng bảng: mỗi phe một bảng, đọc được bằng trình đọc màn hình. */
function playerTables(blue, red) {
  return el('div', {}, [
    ['b', blue, 'var(--blue)'],
    ['r', red, 'var(--red)'],
  ].flatMap(([cls, side, color]) => [
    el('div', { class: 'side-head' }, [el('i', { class: cls }), sideName(side, cls)]),
    playerTable(side, color),
  ]));
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
          el('td', {}, [itemRow(p)]),
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
