/**
 * Dựng Block Kit cho Slack. Dùng chung cho cron (src/notify.js) và slash command
 * (worker/src/index.js), nên không được import gì thuộc riêng Node.
 */
import { providers } from '../../docs/assets/games.js';

/** LoL gọi là "Ván", Valorant gọi là "Map" — lấy từ registry cho khỏi lệch. */
const unitOf = (event) => providers[event?.game]?.terms?.unit ?? 'Ván';

/**
 * `<!date^unix^format|fallback>` để Slack hiển thị theo múi giờ của từng người
 * đọc, thay vì đóng cứng giờ Việt Nam cho cả kênh.
 */
export function slackDate(iso, format = '{date_short_pretty} lúc {time}') {
  const unix = Math.floor(Date.parse(iso) / 1000);
  const fallback = new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return `<!date^${unix}^${format}|${fallback}>`;
}

export const teamLine = (event) =>
  event.teams
    .map((t) => `*${t.name}*${t.record ? ` _(${t.record.wins}–${t.record.losses})_` : ''}`)
    .join('  vs  ');

export const contextLine = (event) =>
  [event.league.name, event.blockName, `Bo${event.strategy.count}`].filter(Boolean).join(' · ');

const linkButton = (url, text = 'Xem chỉ số realtime') =>
  url
    ? {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text, emoji: true }, url, style: 'primary' }],
      }
    : null;

const compact = (blocks) => blocks.filter(Boolean);

/** Tin chính khi một trận sắp bắt đầu. */
export function upcomingMessage(event, url) {
  return {
    text: `Sắp diễn ra: ${event.teams.map((t) => t.code).join(' vs ')} — ${contextLine(event)}`,
    blocks: compact([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:hourglass_flowing_sand: *Sắp diễn ra* · ${contextLine(event)}\n${teamLine(event)}` },
        ...(event.league.image ? { accessory: { type: 'image', image_url: event.league.image, alt_text: event.league.name } } : {}),
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Bắt đầu ${slackDate(event.startTime)} · \`${event.id}\`` }],
      },
      linkButton(url),
    ]),
  };
}

/** Trả lời trong thread khi trận vào trận. */
export function startedMessage(event, url) {
  return {
    text: `Đã bắt đầu: ${event.teams.map((t) => t.code).join(' vs ')}`,
    blocks: compact([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:red_circle: *Trận đã bắt đầu* — ${teamLine(event)}` },
      },
      linkButton(url, 'Theo dõi realtime'),
    ]),
  };
}

/** Trả lời trong thread khi trận kết thúc. */
export function finishedMessage(event, url) {
  const [a, b] = event.teams;
  const winner = a.wins === b.wins ? null : a.wins > b.wins ? a : b;
  const score = `${a.code} ${a.wins} – ${b.wins} ${b.code}`;

  return {
    text: `Kết thúc: ${score}`,
    blocks: compact([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: winner
            ? `:checkered_flag: *${winner.name}* thắng \`${score}\``
            : `:checkered_flag: Trận kết thúc \`${score}\``,
        },
      },
      linkButton(url, 'Xem lại chỉ số'),
    ]),
  };
}

/* ------------------------------------------- dùng cho slash command của Worker */

/** Danh sách trận dạng gọn, mỗi trận một dòng. */
export function scheduleMessage(events, { title, empty, url }) {
  if (!events.length) return { text: empty, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: empty } }] };

  const lines = events.map((event) => {
    const teams = event.teams.map((t) => t.code).join(' vs ');
    const link = url?.(event.id);
    const label = link ? `<${link}|${teams}>` : teams;
    return `${slackDate(event.startTime, '{date_short_pretty} {time}')} · *${label}* · ${contextLine(event)}`;
  });

  return {
    text: title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      ...chunkLines(lines).map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } })),
    ],
  };
}

/** Một section chỉ chứa được 3000 ký tự, nên phải cắt danh sách dài thành nhiều block. */
function chunkLines(lines, limit = 2800) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Ảnh chụp một trận: tỉ số series + chỉ số ván đang đá (nếu có). */
export function matchMessage(match, snapshot, url) {
  const [a, b] = match.teams;
  const header = `*${a.name}* ${a.wins} – ${b.wins} *${b.name}*`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `${header}\n${contextLine(match)}` } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            match.startTime ? slackDate(match.startTime) : null,
            STATE_TEXT[match.state] ?? match.state,
            `\`${match.id}\``,
          ]
            .filter(Boolean)
            .join(' · '),
        },
      ],
    },
  ];

  if (match.games.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: match.games
            .map((g) => `${unitOf(match)} ${g.number}: ${STATE_TEXT[g.state] ?? g.state}`)
            .join('  ·  '),
        },
      ],
    });
  }

  if (snapshot) {
    const side = (s, label) =>
      `*${label}* ${Math.round(s.totalGold / 100) / 10}k vàng · ${s.kills} hạ gục · ${s.towers} trụ · ${s.barons} baron · ${s.dragons.length} rồng`;
    const blueTeam = match.teams.find((t) => t.id === snapshot.blue.esportsTeamId)?.code ?? 'Xanh';
    const redTeam = match.teams.find((t) => t.id === snapshot.red.esportsTeamId)?.code ?? 'Đỏ';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${side(snapshot.blue, blueTeam)}\n${side(snapshot.red, redTeam)}` },
    });
  }

  const button = linkButton(url);
  if (button) blocks.push(button);

  return { text: `${a.code} ${a.wins}–${b.wins} ${b.code}`, blocks };
}

const STATE_TEXT = {
  unstarted: 'chưa bắt đầu',
  inProgress: 'đang diễn ra',
  completed: 'đã kết thúc',
  // Map thừa của Bo3/Bo5 đã ngã ngũ — Valorant dùng, LoL không thấy trả về.
  unneeded: 'không cần đá',
};
