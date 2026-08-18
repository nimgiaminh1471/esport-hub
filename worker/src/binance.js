/**
 * binance.js — đọc lãi/lỗ mục "Dự đoán" (Prediction Markets) của Binance.
 *
 * Ràng buộc giống hệt `docs/assets/*-core.js`: chỉ dùng global có ở CẢ Worker và
 * Node 22 (`fetch`, `crypto.subtle`, `AbortSignal.timeout`). Không `node:*`,
 * không phụ thuộc — nhờ vậy `src/pnl.js` chạy được file này bằng Node trần để
 * kiểm chứng trước khi deploy.
 *
 * TRƯỚC KHI CHẠY ĐƯỢC phải làm xong 4 việc ở phía Binance, thiếu cái nào cũng bị
 * từ chối sạch:
 *   1. đã KYC
 *   2. đã tạo Prediction Account trong app Binance
 *   3. đã làm Prediction SAS authorization trong app Binance
 *   4. API key bật quyền "Prediction Trading" ở Binance Developer Platform
 * Vì vậy `signedGet` ném lỗi kèm NGUYÊN `code`/`msg` của Binance: log cron là thứ
 * duy nhất người sửa nhìn thấy, mà "mảng rỗng" thì không phân biệt được giữa
 * "hôm nay không có kèo nào" và "chưa bật quyền".
 */

const BASE = 'https://api.binance.com';
const PREFIX = '/sapi/v1/w3w/wallet/prediction';

/** Binance từ chối request có `timestamp` lệch quá xa; 10s dư cho lệch đồng hồ. */
const RECV_WINDOW = 10_000;

/** Một trang của `settled-history`. Binance chặn trên ở 100. */
const PAGE_SIZE = 100;

/** Chặn trên số trang, để một ngày bất thường không làm cron chạy vô tận. */
const MAX_PAGES = 50;

/* ------------------------------------------------------------------ chữ ký */

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * HMAC-SHA256 chuỗi query bằng secret key — đúng cách ký của mọi endpoint
 * `/sapi/`. Cùng kỹ thuật `crypto.subtle` đã dùng ở `verifySlackSignature`
 * (`worker/src/index.js`), không kéo thêm thư viện nào.
 */
async function sign(query, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(query)));
}

/**
 * GET có ký tới một endpoint Prediction.
 *
 * Chữ ký phải tính trên ĐÚNG chuỗi sẽ gửi đi, nên phải dựng chuỗi một lần rồi
 * dùng lại — để `URLSearchParams` tự serialize lần hai là mở đường cho sai khác
 * về thứ tự hoặc cách escape, mà lỗi kiểu đó chỉ hiện ra dưới dạng "Signature
 * for this request is not valid" chứ không chỉ được chỗ sai.
 */
export async function signedGet(env, path, params = {}) {
  const apiKey = env?.BINANCE_API_KEY;
  const secret = env?.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error(
      'Thiếu BINANCE_API_KEY / BINANCE_API_SECRET. Nạp bằng `npx wrangler secret put`, ' +
        'hoặc đặt trong worker/.dev.vars khi chạy local.',
    );
  }

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) search.set(k, String(v));
  }
  search.set('recvWindow', String(RECV_WINDOW));
  search.set('timestamp', String(Date.now()));

  const query = search.toString();
  const signature = await sign(query, secret);

  const res = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Không parse được thì giữ nguyên phần đầu để còn đoán được chuyện gì xảy ra.
  }

  if (!res.ok) {
    const detail = data?.msg ? `${data.msg}${data.code ? ` (code ${data.code})` : ''}` : text.slice(0, 200);
    throw new Error(`Binance ${path} trả HTTP ${res.status}: ${detail}`);
  }

  // HTTP 200 mà vẫn kèm `code` âm là lỗi nghiệp vụ — im lặng bỏ qua thì sổ sẽ ghi
  // một ngày trống rỗng như thể hôm đó không đánh gì.
  if (data && typeof data.code === 'number' && data.code < 0) {
    throw new Error(`Binance ${path} từ chối: ${data.msg ?? 'không rõ'} (code ${data.code})`);
  }

  return data;
}

/* -------------------------------------------------------------- lời gọi cụ thể */

/**
 * Địa chỉ ví Prediction. Mọi endpoint số liệu đều bắt buộc có `walletAddress`.
 *
 * Địa chỉ không đổi nên cache vào KV: mỗi lần chốt bớt được một request, và lúc
 * Binance trục trặc thì vẫn còn địa chỉ để thử tiếp. Không có KV (chạy CLI) thì
 * chỉ đơn giản là gọi thẳng.
 */
export async function getWalletAddress(env) {
  const cached = await env?.NOTE?.get('cfg:walletAddress');
  if (cached) return cached;

  const data = await signedGet(env, `${PREFIX}/wallet/list`);
  const address = data?.wallets?.[0]?.walletAddress ?? data?.wallets?.[0]?.address ?? null;
  if (!address) {
    throw new Error(
      'Không tìm thấy ví Prediction nào. Kiểm tra đã tạo Prediction Account và làm ' +
        'Prediction SAS authorization trong app Binance chưa.',
    );
  }

  await env?.NOTE?.put('cfg:walletAddress', address);
  return address;
}

/**
 * Các vị thế đã TẤT TOÁN trong khoảng `[startMs, endMs]`.
 *
 * Vì sao dùng `settled-history` chứ không dùng `pnl/portfolio`: portfolio gộp cả
 * `unrealizedPnl` của vị thế chưa ngã ngũ, mà con số đó nhảy theo giá thị trường
 * từng phút — chốt sổ bằng nó thì hai lần xem cùng một ngày ra hai kết quả.
 *
 * Vì sao vẫn LỌC LẠI theo `settledDate` dù đã truyền `startDate`/`endDate`: tài
 * liệu không nói hai tham số kia hiểu theo múi giờ nào, còn `settledDate` là epoch
 * ms nên không có chỗ hiểu nhầm. Hai tham số kia chỉ để bớt dữ liệu tải về; ranh
 * giới ngày do mình quyết định. Cùng lý do với việc lọc giải ở phía client trong
 * `leagues.js`: cái gì ảnh hưởng con số cuối thì phải nhìn thấy được.
 */
export async function getSettledPositions(env, walletAddress, { startMs, endMs }) {
  const out = [];
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await signedGet(env, `${PREFIX}/position/settled-history`, {
      walletAddress,
      // Nới mỗi đầu một ngày: nếu Binance hiểu hai mốc này theo UTC thì khoảng
      // hẹp sẽ cắt mất phần đầu/cuối ngày giờ VN. Lọc chính xác làm ở dưới.
      startDate: isoDay(startMs - 86_400_000),
      endDate: isoDay(endMs + 86_400_000),
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    const rows = data?.positions ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;

    // Trang trả về theo thứ tự mới nhất trước; đã lùi quá mốc đầu khoảng thì
    // những trang sau chỉ còn cũ hơn nữa.
    const oldest = Math.min(...rows.map((r) => Number(r.settledDate) || Infinity));
    if (Number.isFinite(oldest) && oldest < startMs) break;
  }

  return out.filter((p) => {
    const at = Number(p.settledDate);
    return Number.isFinite(at) && at >= startMs && at <= endMs;
  });
}

/**
 * Ảnh chụp tổng: `totalRealizedPnl` cộng dồn từ đầu + phần chưa ngã ngũ.
 * Không dùng để chốt sổ, chỉ để đối chiếu bằng mắt trong `npm run pnl`.
 */
export function getPortfolio(env, walletAddress) {
  return signedGet(env, `${PREFIX}/pnl/portfolio`, { walletAddress });
}
