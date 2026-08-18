/**
 * Provider VALORANT cho phía Node.
 *
 * Toàn bộ logic nằm ở `docs/assets/val-core.js` để trang GitHub Pages và bot dùng
 * chung một implementation. File này chỉ re-export + thêm CLI smoke test.
 *
 * Smoke test cố ý KHÔNG in chỉ số trong trận: Riot không có feed livestats cho
 * Valorant (xem `val-core.js`). Thay vào đó nó in danh sách map và trạng thái —
 * đúng những gì API thật sự trả về.
 */
import provider from '../../docs/assets/val-core.js';

export * from '../../docs/assets/val-core.js';
export default provider;

/* --------------------------------------------------------------- smoke test */

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const [, , cmd, arg] = process.argv;

  const fmt = (ev) =>
    `${new Date(ev.startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}  ` +
    `[${ev.league.name}] ${ev.teams.map((t) => t.code).join(' vs ')}  ` +
    `Bo${ev.strategy.count}  id=${ev.id}`;

  const printMatch = (match) => {
    console.log(`\n=== CHI TIẾT ${match.teams.map((t) => t.code).join(' vs ')} ===`);
    console.log('  giải:', match.league.name, '·', match.blockName ?? '—');
    console.log('  trạng thái:', match.state);
    console.log('  series:', match.teams.map((t) => `${t.code} ${t.wins}`).join(' - '));
    for (const g of match.games) {
      // Riot không trả tên map (Bind/Haven/...) nên chỉ hiện được số thứ tự.
      const sides = g.teams.map((t) => `${t.side}=${t.id}`).join(' ');
      console.log(`  map ${g.number}: ${g.state.padEnd(10)} (id=${g.id})${sides ? '  ' + sides : ''}`);
    }
    if (match.streams?.length) {
      console.log('  stream:', match.streams.map((s) => `${s.provider}/${s.parameter}`).join(', '));
    }
  };

  try {
    if (cmd === '--smoke' || !cmd) {
      const leagues = await provider.getLeagues();
      console.log(`=== GIẢI (${leagues.length}) ===`);
      console.log(' ', leagues.map((l) => l.slug).join(' '));

      const live = await provider.getLive();
      console.log(`\n=== ĐANG DIỄN RA (${live.length}) ===`);
      live.forEach((e) => console.log(' ', fmt(e)));

      const upcoming = await provider.getUpcoming({ withinMinutes: 24 * 60, limit: 10 });
      console.log(`\n=== SẮP DIỄN RA 24H TỚI (hiển thị ${upcoming.length}) ===`);
      upcoming.forEach((e) => console.log(' ', fmt(e)));

      // Ưu tiên một trận ĐÃ XONG để kiểm tra chỗ dễ sai nhất: Bo3 thắng 2–0 có
      // map thừa mang state `unneeded`, phải suy ra được là `completed`.
      const { events } = await provider.getSchedule();
      const finished = events.filter((e) => e.state === 'completed').at(-1);
      const sample = finished ?? live[0] ?? upcoming[0];
      if (sample) printMatch(await provider.getMatch(sample.id));

      console.log('\n(Riot không có feed chỉ số trong trận cho Valorant — không có gì để in thêm.)');
      console.log('\n✓ smoke test OK');
    } else if (cmd === '--match') {
      if (!arg) throw new Error('cần matchId: node src/providers/valorant.js --match <matchId>');
      printMatch(await provider.getMatch(arg));
    } else if (cmd === '--raw') {
      console.log(JSON.stringify(await provider.getMatch(arg), null, 2));
    } else {
      console.log('Cách dùng: node src/providers/valorant.js [--smoke | --match <matchId> | --raw <matchId>]');
    }
  } catch (err) {
    console.error('✗ Lỗi:', err.message);
    process.exit(1);
  }
}
