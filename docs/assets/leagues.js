/**
 * leagues.js — chọn giải nào được hiện, giải nào bỏ qua.
 *
 * Vì sao nằm trong `docs/assets/` chứ không phải `config/`: đây là thư mục duy
 * nhất mà CẢ BA mặt với tới được — Node (bot Slack) và Worker import theo đường
 * dẫn tương đối, còn trình duyệt thì chỉ tải được file nằm trong `docs/` vì
 * GitHub Pages chỉ phục vụ đúng thư mục đó. Để ở `config/` thì trang web không
 * bao giờ đọc được.
 *
 * Vì sao là `.js` chứ không phải `.json`: file này phải `import` được từ Worker,
 * mà repo chưa từng import JSON, `wrangler.toml` không khai báo loader nào và
 * cũng không bật `nodejs_compat`. Dùng ESM thuần thì khỏi phải trông chờ vào
 * chuyện đó — đổi lại còn viết được comment thật thay vì nhét vào key `_comment`.
 *
 * ESM thuần, không `node:*`, không DOM, không phụ thuộc gì.
 */

/**
 * Slug lấy từ `getLeagues()` của từng game. Sai một chữ là giải đó **biến mất
 * không kèn không trống** — nên `unknownSlugs()` bên dưới có nhiệm vụ bắt lỗi
 * đó, và smoke test gọi nó mỗi lần chạy.
 */
export const LEAGUE_POLICY = {
  lol: {
    mode: 'include',
    include: [
      // Quốc tế
      'worlds',
      'msi',
      'first_stand',
      'ewc_lol',
      // Bốn khu vực lớn
      'lck',
      'lpl',
      'lec',
      'lcp',
      // Châu Mỹ — từ 2025 LTA thay cho LCS và CBLOL, nên KHÔNG dùng slug `lcs`
      // hay `cblol-brazil` nữa (chúng vẫn tồn tại nhưng là giải cũ).
      'lta_n',
      'lta_s',
      // Việt Nam
      'vcs',
      // Hàn Quốc — hai giải này chạy cả lúc trái mùa, nhờ vậy danh sách không
      // rỗng trong giai đoạn LCK/LPL nghỉ giữa hai split.
      'lck_challengers_league',
      'kespa_cup',
    ],
    exclude: [],
  },

  // Valorant vẫn bật hết: đo thực tế chỉ ~5 trận/24h vì phần lớn giải khu vực
  // không chạy cùng lúc. Thấy nhiều tin quá thì thêm slug vào `exclude`.
  val: {
    mode: 'all',
    exclude: [],
    include: [],
  },
};

const policyOf = (game) => LEAGUE_POLICY[game] ?? { mode: 'all', exclude: [], include: [] };

/**
 * Trả về predicate đồng bộ, thuần — nhận event đã chuẩn hoá, trả true nếu giữ.
 *
 * `mode: "include"` = chỉ nhận slug trong `include`;
 * `mode: "all"`     = nhận tất cả trừ slug trong `exclude`.
 *
 * `all: true` bỏ qua bộ lọc hoàn toàn — dùng cho `/lol schedule all` và nút
 * "Tất cả" trên web.
 */
export function makeLeagueFilter(game, { all = false } = {}) {
  if (all) return () => true;

  const cfg = policyOf(game);
  const include = new Set(cfg.include ?? []);
  const exclude = new Set(cfg.exclude ?? []);

  return (event) => {
    const slug = event.league?.slug;
    if (cfg.mode === 'include') return include.has(slug);
    return !exclude.has(slug);
  };
}

/**
 * Game này có thật sự lọc gì không.
 *
 * Web dùng để quyết định có hiện nút "Giải lớn / Tất cả" hay không — Valorant
 * đang `mode: all` với `exclude` rỗng nên nút đó bấm vào chẳng đổi gì, thà ẩn đi.
 */
export function hasLeagueFilter(game) {
  const cfg = policyOf(game);
  return cfg.mode === 'include' ? (cfg.include?.length ?? 0) > 0 : (cfg.exclude?.length ?? 0) > 0;
}

/**
 * Lọc kèm đếm số bị bỏ — luôn đi cùng nhau nên gom lại một chỗ cho khỏi lệch.
 *
 * Cố ý lọc phía mình chứ KHÔNG nhờ API lọc, dù `getSchedule` có nhận `leagueId`
 * và truyền nhiều id ngăn bằng dấu phẩy cũng chạy: nhờ API lọc thì không tài nào
 * đếm được số trận đã bị bỏ, mà con số đó chính là thứ cho người đọc biết bộ lọc
 * đang bật chứ bot không hỏng.
 */
export function filterByLeague(events, keep) {
  const kept = events.filter(keep);
  return { events: kept, skipped: events.length - kept.length };
}

/**
 * Slug khai trong policy nhưng không có thật ở `getLeagues()`.
 *
 * Đây là lỗi câm nguy hiểm nhất của cả cơ chế này: gõ sai `lck_challenger` thay
 * vì `lck_challengers_league`, hoặc Riot đổi tên giải, thì giải đó lặng lẽ không
 * bao giờ được báo và không có dấu hiệu gì. Soi cả `include` lẫn `exclude` vì sai
 * chính tả trong danh sách đang không dùng tới cũng là quả mìn hẹn giờ.
 */
export function unknownSlugs(game, leagues) {
  const cfg = policyOf(game);
  const known = new Set((leagues ?? []).map((l) => l.slug));
  const used = new Set([...(cfg.include ?? []), ...(cfg.exclude ?? [])]);
  return [...used].filter((slug) => !known.has(slug));
}
