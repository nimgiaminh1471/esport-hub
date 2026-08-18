/**
 * Kiểm chứng phần "Dự đoán" của Binance bằng Node, không cần dựng Worker.
 *
 *   npm run pnl                  # hôm qua (giờ VN)
 *   npm run pnl -- 2026-08-18    # một ngày cụ thể
 *   npm run pnl -- --today       # ngày đang chạy, tạm tính
 *
 * Vì sao có file này: cron chạy lúc 00:05 và chỉ để lại log — nếu chưa làm xong
 * Prediction SAS authorization thì phải chờ tới sáng mới biết. Chạy tay ở đây thì
 * lỗi hiện ngay, kèm nguyên `code`/`msg` của Binance.
 *
 * Chạy được là nhờ `worker/src/binance.js` và `day-core.js` cố ý chỉ dùng global
 * có ở cả Worker lẫn Node 22 (`fetch`, `crypto.subtle`) — xem đầu hai file đó.
 *
 * SO SÁNH VỚI APP BINANCE trước khi tin con số này.
 */
import { getPortfolio, getSettledPositions, getWalletAddress } from '../worker/src/binance.js';
import { dayBounds, dayLines, fmt, shareFrom, shiftDay, splitDay, today } from '../worker/src/day-core.js';

// `env` của Worker chính là `process.env` ở đây; không có KV nên không cache ví.
const env = process.env;

const args = process.argv.slice(2);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  ?? (args.includes('--today') ? today() : shiftDay(today(), -1));

const run = async () => {
  const address = await getWalletAddress(env);
  console.log(`Ví Prediction : ${address}`);

  const portfolio = await getPortfolio(env, address).catch((err) => {
    console.warn(`Không đọc được portfolio (không ảnh hưởng phần chốt ngày): ${err.message}`);
    return null;
  });
  if (portfolio) {
    console.log(`Lãi cộng dồn  : ${portfolio.totalRealizedPnl ?? '—'} (đã chốt)`);
    console.log(`Đang mở       : ${portfolio.totalUnrealizedPnl ?? '—'} · ${portfolio.activePositionsCount ?? 0} vị thế`);
  }

  const { startMs, endMs } = dayBounds(day);
  console.log(`\nNgày ${day} (giờ VN): ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);

  const positions = await getSettledPositions(env, address, { startMs, endMs });
  for (const p of positions) {
    const at = new Date(Number(p.settledDate)).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    console.log(`  ${at}  ${fmt(Math.round(Number(p.realizedPnl ?? p.pnl ?? 0) * 100)).padStart(10)}  ${p.marketTitle ?? ''} · ${p.outcomeName ?? ''}`);
  }
  if (!positions.length) console.log('  (không có vị thế nào tất toán trong ngày)');

  const row = { day, ...splitDay(positions, shareFrom(env)) };
  console.log(`\n${dayLines(row).join('\n')}`);
};

run().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
