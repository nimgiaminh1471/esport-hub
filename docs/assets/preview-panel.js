/**
 * preview-panel.js — khay "nhận định trước trận", trượt ra từ cạnh phải.
 *
 * Chỉ tải dữ liệu khi mở lần đầu. Lý do: phần đối đầu phải lật 5 trang lịch
 * (~2 giây), quá chậm để chặn lúc vào trang — mà phần lớn lượt xem chỉ cần chỉ số
 * trong trận. Mở khay mới tải, và nhớ kết quả để lần mở sau là tức thì.
 *
 * Gắn một lần vào `document.body`, KHÔNG nằm trong các mount mà `render()` xoá
 * mỗi 10 giây — nếu không thì cứ đến nhịp poll là khay tự đóng lại.
 */
import { el, clear, img, dateVN } from './ui.js';
import { summariseMatchup } from './riot-core.js';

/** Số trang lịch lật về quá khứ. 5 trang ~ hai năm, ~2 giây. */
const HISTORY_PAGES = 5;
const FORM_SIZE = 5;

/**
 * @param {object} provider  provider của game đang xem
 * @param {object} match     kết quả getMatch (cần league.id, tournamentId, teams)
 */
export function mountPreviewPanel(provider, match) {
  const [a, b] = match.teams ?? [];
  if (!a || !b || !match.league?.id) return null;

  let loaded = null; // nhớ lại để mở lần hai không tải lại
  let loading = false;

  const body = el('div', { class: 'peek-body' }, [
    el('p', { class: 'empty', text: 'Bấm để tải nhận định…' }),
  ]);

  const panel = el('aside', { class: 'peek', 'aria-label': 'Nhận định trước trận' }, [
    el('header', {}, [
      el('h2', { text: 'Nhận định' }),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'peek-x', text: '×', 'aria-label': 'Đóng', onclick: () => setOpen(false) }),
    ]),
    body,
  ]);

  const toggle = el('button', {
    type: 'button',
    class: 'peek-toggle',
    'aria-expanded': 'false',
    text: 'Nhận định',
    onclick: () => setOpen(!document.body.classList.contains('peek-open')),
  });

  document.body.append(toggle, panel);

  function setOpen(open) {
    document.body.classList.toggle('peek-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !loaded && !loading) load();
  }

  async function load() {
    loading = true;
    const progress = el('p', { class: 'empty', text: 'Đang quét lịch sử giải…' });
    clear(body).append(progress);

    try {
      // Hai lời gọi độc lập nhau, chạy song song. Xếp hạng có thể thất bại riêng
      // (giải không có bảng) mà không được làm mất phần đối đầu.
      const [history, standings] = await Promise.all([
        provider.getLeagueHistory({
          leagueId: match.league.id,
          pages: HISTORY_PAGES,
          onPage: ({ page, of, events }) => {
            progress.textContent = `Đang quét lịch sử giải… trang ${page}/${of} · ${events} trận`;
          },
        }),
        provider.getStandings({ tournamentId: match.tournamentId }).catch(() => []),
      ]);

      loaded = {
        matchup: summariseMatchup(history, a.code, b.code, { formSize: FORM_SIZE }),
        standings,
      };
      render();
    } catch (err) {
      clear(body).append(
        el('p', { class: 'status status--error', text: `Không tải được: ${err.message}` }),
        el('button', { type: 'button', text: 'Thử lại', onclick: () => { loading = false; load(); } }),
      );
    } finally {
      loading = false;
    }
  }

  function render() {
    const { matchup, standings } = loaded;
    clear(body).append(
      section('Đối đầu', h2hBlock(matchup, a, b)),
      section(`Phong độ ${FORM_SIZE} trận gần nhất`, formBlock(matchup, a, b)),
      section('Xếp hạng', standingsBlock(standings, a, b)),
      el('p', {
        class: 'empty',
        text: `Đã quét ${matchup.scanned} trận đã xong của ${match.league.name}.`,
      }),
    );
  }

  return { setOpen };
}

/* ------------------------------------------------------------------ khối nội dung */

const section = (title, ...children) =>
  el('section', { class: 'peek-sec' }, [el('h3', { text: title }), ...children]);

function teamChip(team) {
  return el('span', { class: 'peek-team' }, [
    team.image ? img(team.image, { alt: '' }) : null,
    el('b', { text: team.code }),
  ]);
}

function h2hBlock(matchup, a, b) {
  const { meetings, score } = matchup;
  if (!meetings.length) {
    return el('p', { class: 'empty', text: 'Chưa từng gặp nhau trong khoảng lịch sử đã quét.' });
  }

  const head = el('div', { class: 'peek-h2h' }, [
    teamChip(a),
    el('span', { class: 'peek-score' }, [
      el('b', { class: score[a.code] >= score[b.code] ? 'lead' : '', text: score[a.code] }),
      el('span', { text: '–' }),
      el('b', { class: score[b.code] >= score[a.code] ? 'lead' : '', text: score[b.code] }),
    ]),
    teamChip(b),
  ]);

  const rows = meetings.map((e) => {
    const [x, y] = e.teams;
    // Người thắng suy từ số ván thắng, không đọc `outcome` (dữ liệu cũ không có).
    const win = x.wins === y.wins ? null : x.wins > y.wins ? x.code : y.code;
    return el('div', { class: 'peek-row' }, [
      el('span', { class: 'when', text: dateVN(e.startTime) }),
      el('span', { class: 'what' }, [
        el('b', { class: win === x.code ? 'lead' : '', text: x.code }),
        el('span', { text: ` ${x.wins}–${y.wins} ` }),
        el('b', { class: win === y.code ? 'lead' : '', text: y.code }),
      ]),
      el('span', { class: 'bo', text: `Bo${e.strategy?.count ?? 1}` }),
    ]);
  });

  return el('div', {}, [head, ...rows]);
}

function formBlock(matchup, a, b) {
  const line = (team) => {
    const form = matchup.form[team.code] ?? [];
    if (!form.length) return el('div', { class: 'peek-row' }, [teamChip(team), el('span', { class: 'empty', text: 'chưa có trận nào' })]);

    return el('div', { class: 'peek-row' }, [
      teamChip(team),
      el('span', { class: 'peek-form' }, form.map((f) =>
        el('i', {
          class: f.win ? 'w' : 'l',
          title: `${f.win ? 'Thắng' : 'Thua'} ${f.opponent} ${f.score} · ${dateVN(f.at)}`,
          text: f.win ? 'T' : 'B',
        }),
      )),
    ]);
  };

  // Mới nhất ở bên trái — cùng chiều đọc với danh sách đối đầu bên trên.
  return el('div', {}, [line(a), line(b), el('p', { class: 'empty', text: 'Mới nhất ở bên trái.' })]);
}

function standingsBlock(standings, a, b) {
  const found = [];

  for (const group of standings) {
    for (const rank of group.rankings) {
      for (const team of rank.teams) {
        if (team.code !== a.code && team.code !== b.code) continue;
        found.push({
          team,
          ordinal: rank.ordinal,
          size: group.rankings.length,
          where: [group.stage, group.section].filter(Boolean).join(' · '),
        });
      }
    }
  }

  if (!found.length) {
    // Vòng loại trực tiếp thì `rankings` rỗng — nói rõ chứ đừng để trống trơn như
    // thể mất dữ liệu.
    const hasGroups = standings.some((g) => g.rankings.length);
    return el('p', {
      class: 'empty',
      text: hasGroups
        ? 'Hai đội không nằm trong bảng nào của giai đoạn này.'
        : 'Giai đoạn này là vòng loại trực tiếp, không có bảng xếp hạng.',
    });
  }

  return el('div', {}, found.map((f) =>
    el('div', { class: 'peek-row' }, [
      teamChip(f.team),
      el('span', { class: 'what', text: `#${f.ordinal}/${f.size}` }),
      el('span', { class: 'bo', text: f.team.record ? `${f.team.record.wins}–${f.team.record.losses}` : '—' }),
      el('span', { class: 'when', text: f.where }),
    ]),
  ));
}
