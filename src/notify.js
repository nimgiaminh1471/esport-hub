/**
 * Điểm vào cho GitHub Actions cron: quét lịch, báo Slack, ghi lại trạng thái.
 *
 * Ba loại tin:
 *   1. Trận sắp bắt đầu trong `LEAD_MINUTES` phút  -> tin mới trong kênh
 *   2. Trận đã báo chuyển sang đang diễn ra        -> reply trong thread
 *   3. Trận đã báo kết thúc                         -> reply trong thread kèm tỉ số
 *
 * Chỉ những trận đã từng được báo (loại 1) mới sinh ra reply, nên bot không
 * bình luận vào những trận mà kênh chưa từng thấy.
 *
 * Chạy MỌI game đã đăng ký trong registry, tuần tự trong cùng một tiến trình.
 * Không dùng matrix của Actions: `concurrency` chỉ tuần tự hoá các lần chạy
 * workflow chứ không tuần tự hoá các nhánh matrix trong cùng một lần chạy, nên
 * hai nhánh sẽ cùng `git add state/` rồi đua nhau push — vòng rebase-retry gặp
 * conflict chứ không merge được. Chạy tuần tự thì chỉ có một commit, không đua.
 */
import { providers, getProvider } from './providers/index.js';
import { config, matchUrl, makeLeagueFilter, assertSlackConfigured } from './lib/config.js';
import { loadState, saveState, getEntry, setEntry } from './lib/state.js';
import { postMessage } from './slack.js';
import { upcomingMessage, startedMessage, finishedMessage } from './lib/blocks.js';

// Khai báo dạng function để hoisted lên trước lời gọi main() ngay bên dưới.
function label(event) {
  return `[${event.league.name}] ${event.teams.map((t) => t.code).join(' vs ')}`;
}

await main();

async function main() {
  assertSlackConfigured();

  const games = config.games.length ? config.games : Object.keys(providers);
  const failed = [];

  for (const game of games) {
    // Mỗi game một try/catch: Riot lỗi ở game này không được làm mất phần state
    // đã xử lý xong của game kia.
    try {
      await runGame(game);
    } catch (err) {
      failed.push(game);
      console.error(`✗ ${game}: ${err.message}`);
    }
  }

  // Báo hỏng SAU khi đã ghi xong state của các game chạy được.
  if (failed.length) process.exitCode = 1;
}

async function runGame(game) {
  const provider = getProvider(game);
  const keepLeague = await makeLeagueFilter(game);
  const state = await loadState(game);
  const now = Date.now();

  // Một lần getSchedule đã bao cả trận sắp tới lẫn trận vừa xong, cộng getLive
  // cho những trận đang đá — đủ để phát hiện mọi chuyển trạng thái mà chỉ tốn
  // hai request, thay vì hỏi từng trận đang theo dõi.
  //
  // Với game không có endpoint getLive (Valorant), provider tự lọc từ lịch — hai
  // request này khi đó là y hệt nhau. Thừa một request, hoàn toàn vô hại; đừng
  // "tối ưu" bằng cách đụng vào vòng lặp bên dưới.
  const [{ events: scheduled }, live] = await Promise.all([provider.getSchedule(), provider.getLive()]);

  const events = new Map();
  for (const event of [...scheduled, ...live]) events.set(event.id, event);

  const summary = { upcoming: 0, started: 0, finished: 0, skipped: 0 };

  for (const event of [...events.values()].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))) {
    if (!keepLeague(event)) {
      summary.skipped++;
      continue;
    }

    const previous = getEntry(state, event.id);
    const url = matchUrl(event.id, game);

    if (!previous) {
      const startsIn = (Date.parse(event.startTime) - now) / 60000;
      const isDue = event.state === 'unstarted' && startsIn >= 0 && startsIn <= config.leadMinutes;
      if (!isDue) continue;

      const posted = await postMessage(upcomingMessage(event, url));
      setEntry(state, event.id, { state: event.state, slackTs: posted?.ts ?? null, announcedAt: new Date().toISOString() });
      summary.upcoming++;
      console.log(`↗ báo trận: ${label(event)} (sau ${Math.round(startsIn)} phút)`);
      continue;
    }

    if (previous.state === event.state) continue;

    if (event.state === 'inProgress') {
      await postMessage({ ...startedMessage(event, url), threadTs: previous.slackTs });
      summary.started++;
      console.log(`▶ bắt đầu: ${label(event)}`);
    } else if (event.state === 'completed') {
      await postMessage({ ...finishedMessage(event, url), threadTs: previous.slackTs });
      summary.finished++;
      console.log(`✓ kết thúc: ${label(event)} — ${event.teams.map((t) => `${t.code} ${t.wins}`).join(' - ')}`);
    }

    setEntry(state, event.id, { state: event.state });
  }

  const changed = await saveState(game, state);
  console.log(
    `\n[${provider.name}] Đã quét ${events.size} trận (bỏ qua ${summary.skipped} theo bộ lọc giải) · ` +
      `báo mới ${summary.upcoming} · bắt đầu ${summary.started} · kết thúc ${summary.finished} · ` +
      `state ${changed ? 'đã cập nhật' : 'không đổi'}`,
  );
}
