/**
 * Provider LoL cho phía Node.
 *
 * Toàn bộ logic nằm ở `docs/assets/lol-core.js` để trang GitHub Pages và bot
 * dùng chung một implementation. File này chỉ re-export + thêm CLI smoke test.
 */
import provider, { isStatsDisabled } from '../../docs/assets/lol-core.js';

export * from '../../docs/assets/lol-core.js';
export default provider;

/* --------------------------------------------------------------- smoke test */

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const [, , cmd, arg] = process.argv;

  const fmt = (ev) =>
    `${new Date(ev.startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}  ` +
    `[${ev.league.name}] ${ev.teams.map((t) => t.code).join(' vs ')}  ` +
    `Bo${ev.strategy.count}  id=${ev.id}`;

  try {
    if (cmd === '--smoke' || !cmd) {
      const live = await provider.getLive();
      console.log(`\n=== ĐANG DIỄN RA (${live.length}) ===`);
      live.forEach((e) => console.log(' ', fmt(e)));

      const upcoming = await provider.getUpcoming({ withinMinutes: 24 * 60, limit: 10 });
      console.log(`\n=== SẮP DIỄN RA 24H TỚI (hiển thị ${upcoming.length}) ===`);
      upcoming.forEach((e) => console.log(' ', fmt(e)));

      const sample = live[0] ?? upcoming[0];
      if (sample) {
        const match = await provider.getMatch(sample.id);
        console.log(`\n=== CHI TIẾT ${match.teams.map((t) => t.code).join(' vs ')} ===`);
        console.log('  series:', match.teams.map((t) => `${t.code} ${t.wins}`).join(' - '));
        match.games.forEach((g) => console.log(`  game ${g.number}: ${g.state} (id=${g.id})`));

        const playable =
          match.games.find((g) => g.state === 'inProgress') ??
          match.games.findLast((g) => g.state === 'completed');
        if (playable) {
          const snap = await provider.getGameSnapshot(playable.id);
          if (snap) printSnapshot(snap);
          else console.log(`  (${isStatsDisabled(playable.id) ? 'Riot tắt livestats cho ván này' : 'ván chưa có dữ liệu livestats'})`);

          const timeline = await provider.getTimeline(playable.id, { maxSamples: 8 });
          console.log(
            `\n  Timeline (${timeline.length} mẫu): ` +
              timeline
                .map((p) => `${Math.floor(p.elapsedSeconds / 60)}'→${p.blueGold - p.redGold >= 0 ? '+' : ''}${p.blueGold - p.redGold}`)
                .join('  '),
          );
        }
      }
      console.log('\n✓ smoke test OK');
    } else if (cmd === '--stats') {
      if (!arg) throw new Error('cần gameId: node src/providers/lol.js --stats <gameId>');
      const snap = await provider.getGameSnapshot(arg);
      if (!snap) {
        console.log(
          isStatsDisabled(arg)
            ? 'Riot tắt livestats cho ván này (404 "Stats are disabled").'
            : 'Ván chưa bắt đầu hoặc không có dữ liệu (HTTP 204).',
        );
      }
      else printSnapshot(snap);
    } else if (cmd === '--match') {
      console.log(JSON.stringify(await provider.getMatch(arg), null, 2));
    } else {
      console.log('Cách dùng: node src/providers/lol.js [--smoke | --stats <gameId> | --match <matchId>]');
    }
  } catch (err) {
    console.error('✗ Lỗi:', err.message);
    process.exit(1);
  }
}

function printSnapshot(snap) {
  const g = (n) => `${(n / 1000).toFixed(1)}k`;
  console.log(`\n  --- Game ${snap.gameId} | patch ${snap.patch} | ${snap.gameState} | ${snap.timestamp} ---`);
  for (const [side, t] of [['BLUE', snap.blue], ['RED ', snap.red]]) {
    console.log(
      `  ${side}  gold ${g(t.totalGold)}  K ${t.kills}  T ${t.towers}  I ${t.inhibitors}  B ${t.barons}  D ${t.dragons.length}`,
    );
    for (const p of t.participants) {
      console.log(
        `        ${p.role.padEnd(6)} ${p.summonerName.padEnd(18)} ${String(p.championId).padEnd(14)}` +
          ` lv${String(p.level).padStart(2)} ${p.kills}/${p.deaths}/${p.assists}  cs ${String(p.creepScore).padStart(3)}  ${g(p.totalGold)}`,
      );
    }
  }
  console.log(`  Gold diff (blue - red): ${snap.blue.totalGold - snap.red.totalGold}`);
}
