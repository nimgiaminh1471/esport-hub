/** Trang chủ: trận đang đá + lịch sắp tới, và ô tra cứu theo ID. */
import { providers, getProvider, gameFromSearch, matchHref, DEFAULT_GAME } from './games.js';
import { el, clear, img, setStatus, stateBadge, timeVN, dateVN, relativeVN } from './ui.js';

const REFRESH_MS = 60_000;

const sport = gameFromSearch(location.search);
const provider = getProvider(sport);

const dom = {
  status: document.getElementById('status'),
  live: document.getElementById('live'),
  liveList: document.getElementById('live-list'),
  upcoming: document.getElementById('upcoming'),
  upcomingList: document.getElementById('upcoming-list'),
  hours: document.getElementById('hours'),
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
  const [live, upcoming] = await Promise.all([
    provider.getLive(),
    provider.getUpcoming({ withinMinutes: hours * 60, limit: 60 }),
  ]);

  dom.status.hidden = true;

  renderList(dom.liveList, live, 'Hiện không có trận nào đang diễn ra.');
  dom.live.hidden = false;

  renderList(dom.upcomingList, upcoming, `Không có trận nào trong ${hours} giờ tới.`);
  dom.upcoming.hidden = false;
}

function renderList(mount, events, emptyMessage) {
  clear(mount);
  if (!events.length) {
    mount.append(el('p', { class: 'empty', text: emptyMessage }));
    return;
  }
  mount.append(...events.map(matchRow));
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
