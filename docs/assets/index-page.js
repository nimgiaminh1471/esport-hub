/** Trang chủ: trận đang đá + lịch sắp tới, và ô tra cứu theo ID. */
import { providers, getProvider, gameFromSearch, matchHref, DEFAULT_GAME } from './games.js';
import { makeLeagueFilter, filterByLeague, hasLeagueFilter } from './leagues.js';
import { el, clear, img, setStatus, stateBadge, timeVN, dateVN, relativeVN } from './ui.js';

const REFRESH_MS = 60_000;

const sport = gameFromSearch(location.search);
const provider = getProvider(sport);

// `?leagues=all` để bỏ bộ lọc. Đặt trên URL chứ không phải localStorage để link
// gửi cho người khác vẫn ra đúng thứ mình đang xem, giống cách `?sport=` làm.
const showAll = new URLSearchParams(location.search).get('leagues') === 'all';
const keepLeague = makeLeagueFilter(sport, { all: showAll });

const dom = {
  status: document.getElementById('status'),
  live: document.getElementById('live'),
  liveList: document.getElementById('live-list'),
  upcoming: document.getElementById('upcoming'),
  upcomingList: document.getElementById('upcoming-list'),
  hours: document.getElementById('hours'),
  leagues: document.getElementById('league-switch'),
  brand: document.getElementById('brand-game'),
  switch: document.getElementById('game-switch'),
  notice: document.getElementById('delay-notice'),
};

renderChrome();
dom.hours.addEventListener('change', () => refresh().catch(reportError));

/** Tiêu đề, nút chuyển game và ghi chú độ trễ — đều phụ thuộc game đang xem. */
function renderChrome() {
  document.title = `Esports Hub — lịch thi đấu ${provider.name}`;
  if (dom.brand) dom.brand.textContent = `· ${sport === DEFAULT_GAME ? 'LoL' : provider.name}`;

  // Ghi chú "trễ ~3,5 phút" chỉ đúng với game có feed livestats.
  if (dom.notice) dom.notice.hidden = !provider.capabilities.liveStats;

  // Nút lọc chỉ có nghĩa khi game đó thật sự lọc gì đó — Valorant đang bật hết
  // nên nút bấm vào chẳng đổi gì, thà ẩn đi.
  if (dom.leagues) {
    dom.leagues.hidden = !hasLeagueFilter(sport);
    const href = (all) => {
      const q = new URLSearchParams(location.search);
      if (all) q.set('leagues', 'all');
      else q.delete('leagues');
      const s = q.toString();
      return s ? `./?${s}` : './';
    };
    clear(dom.leagues).append(
      el('a', { class: 'game-tab', href: href(false), 'aria-current': showAll ? null : 'page', text: 'Giải lớn' }),
      el('a', { class: 'game-tab', href: href(true), 'aria-current': showAll ? 'page' : null, text: 'Tất cả' }),
    );
  }

  if (dom.switch) {
    clear(dom.switch).append(
      ...Object.values(providers).map((p) =>
        el('a', {
          class: 'game-tab',
          href: p.id === DEFAULT_GAME ? './' : `./?sport=${encodeURIComponent(p.id)}`,
          'aria-current': p.id === sport ? 'page' : null,
          text: p.name,
        }),
      ),
    );
  }
}

refresh()
  .then(() => setInterval(() => refresh().catch(reportError), REFRESH_MS))
  .catch(reportError);

function reportError(err) {
  setStatus(dom.status, `Không tải được lịch thi đấu: ${err.message}`, true);
}

async function refresh() {
  const hours = Number(dom.hours.value);
  // `limit: Infinity` để lấy trọn cửa sổ rồi mới lọc — xin sẵn 60 thì getUpcoming
  // cắt 60 trận sớm nhất của MỌI giải trước, lọc sau sẽ mất trận. Xem chú thích
  // dài hơn ở worker/src/index.js.
  const [liveAll, upcomingAll] = await Promise.all([
    provider.getLive(),
    provider.getUpcoming({ withinMinutes: hours * 60, limit: Infinity }),
  ]);

  const live = filterByLeague(liveAll, keepLeague);
  const upcoming = filterByLeague(upcomingAll, keepLeague);
  const scope = hasLeagueFilter(sport) && !showAll ? ' giải lớn' : '';

  dom.status.hidden = true;

  renderList(dom.liveList, live.events, `Hiện không có trận${scope} nào đang diễn ra.`, live.skipped);
  dom.live.hidden = false;

  renderList(dom.upcomingList, upcoming.events.slice(0, 60), `Không có trận${scope} nào trong ${hours} giờ tới.`, upcoming.skipped);
  dom.upcoming.hidden = false;
}

function renderList(mount, events, emptyMessage, skipped = 0) {
  clear(mount);

  // Luôn nói rõ đã bỏ qua bao nhiêu trận, kể cả khi danh sách không rỗng — không
  // thì lúc rỗng rất dễ tưởng trang hỏng.
  const note = skipped
    ? el('p', { class: 'empty' }, [
        `Đã bỏ qua ${skipped} trận ở các giải khác — `,
        el('a', { href: linkAll(), text: 'xem tất cả giải' }),
      ])
    : null;

  if (!events.length) {
    mount.append(el('p', { class: 'empty', text: emptyMessage }), note);
    return;
  }
  mount.append(...events.map(matchRow), note);
}

function linkAll() {
  const q = new URLSearchParams(location.search);
  q.set('leagues', 'all');
  return `./?${q}`;
}

function matchRow(event) {
  const [a, b] = event.teams;
  const teamCell = (t) =>
    el('span', { class: 'versus-team' }, [img(t?.image, { alt: '' }), el('span', { class: 't', text: t?.code ?? 'TBD' })]);

  return el('a', { class: 'match-item', href: matchHref(event.id, event.game) }, [
    el('div', { class: 'when' }, [
      timeVN(event.startTime),
      el('small', { text: `${dateVN(event.startTime)} · ${relativeVN(event.startTime)}` }),
    ]),
    el('div', { class: 'versus' }, [
      teamCell(a),
      el('span', { class: 'vs', text: 'vs' }),
      teamCell(b),
      el('span', { class: 'league-tag', text: [event.league.name, event.blockName, `Bo${event.strategy.count}`].filter(Boolean).join(' · ') }),
    ]),
    stateBadge(event.state),
  ]);
}
