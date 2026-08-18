# Esports Hub

Bot Slack thông báo lịch thi đấu esports + trang web xem chỉ số trong trận theo thời gian thực.
Hiện hỗ trợ **League of Legends**, kiến trúc cho phép cắm thêm game khác.

Ba phần rời nhau, không phần nào cần máy chủ thường trú:

| Phần | Chạy ở đâu | Việc |
|---|---|---|
| `src/notify.js` | GitHub Actions cron (5 phút/lần) | Báo trận sắp diễn ra, trận vào trận, trận kết thúc |
| `worker/` | Cloudflare Workers | Slash command `/lol schedule`, `/lol live`, `/lol match <id>` |
| `docs/` | GitHub Pages | Trang xem chỉ số trong trận, cập nhật 10 giây/lần |

---

## Nguồn dữ liệu

API esports công khai của Riot. Điểm mấu chốt khiến kiến trúc này khả thi: nó trả
`Access-Control-Allow-Origin: *`, nên **trang tĩnh gọi thẳng từ trình duyệt được** —
không cần backend, không cần proxy, không có khoá bí mật nào phía client.

| Endpoint | Việc | Cần key |
|---|---|---|
| `esports-api.lolesports.com/persisted/gw/*` | lịch, giải, chi tiết trận | `x-api-key` (khoá công khai mà chính web lolesports dùng) |
| `feed.lolesports.com/livestats/v1/window/<gameId>` | vàng, hạ gục, trụ, rồng, KDA/CS từng người | không |
| `feed.lolesports.com/livestats/v1/details/<gameId>` | trang bị, ngọc, tỉ lệ sát thương, mắt | không |
| `ddragon.leagueoflegends.com` | ảnh tướng / trang bị / ngọc | không |

### Hai giới hạn cần biết trước

1. **Số liệu trong trận trễ khoảng 3,5 phút.** Riot chặn không cho đọc cửa sổ kết
   thúc muộn hơn `now - 190s`; xin mốc mới hơn sẽ nhận `400 BAD_QUERY_PARAMETER`.
   Đây là biện pháp chống ăn gian của Riot, không sửa được. Trang web ghi rõ điều
   này để người xem không tưởng là lỗi.
2. **Đây là API nội bộ, Riot không cam kết giữ nguyên.** Mọi chỗ chạm vào nó gom
   hết vào `docs/assets/lol-core.js`, nên nếu Riot đổi schema thì chỉ phải sửa một file.

Ngoài ra `window` gọi mà không kèm `startingTime` sẽ trả frame **đầu ván** (toàn số 0)
chứ không phải trạng thái mới nhất — `lol-core.js` đã xử lý sẵn, nhưng đáng nhớ nếu
bạn tự gọi tay.

---

## Cấu trúc

```
docs/assets/lol-core.js   ← toàn bộ logic gọi API, ESM thuần
    ├── src/providers/lol.js      (Node import lại, thêm CLI)
    ├── docs/assets/*-page.js     (trình duyệt import trực tiếp)
    └── worker/src/index.js       (wrangler bundle vào)
```

Một nguồn sự thật duy nhất cho cả ba nơi — không có bản sao logic nào phải giữ đồng bộ.

### Thêm game mới

1. Viết `docs/assets/<game>-core.js` export đúng bộ hàm như `lol-core.js`:
   `getSchedule`, `getUpcoming`, `getLive`, `getMatch`, `getGameSnapshot`.
2. Tạo `src/providers/<game>.js` re-export core đó.
3. Thêm một dòng vào `src/providers/index.js`.

Phần Slack, workflow và trang web không phải sửa gì.

---

## Cài đặt

### 0. Chạy thử ngay, chưa cần cấu hình gì

```bash
npm run smoke     # in lịch thi đấu và chỉ số một trận thật ra terminal
npm run serve     # mở http://localhost:8080
```

### 1. Repo và GitHub Pages

1. Tạo repo trên GitHub, push code này lên.
2. **Settings → Pages → Source: Deploy from a branch**, chọn nhánh `main`, thư mục `/docs`.
3. Ghi lại URL Pages, ví dụ `https://<user>.github.io/esports-hub`.

### 2. Slack App

1. Vào <https://api.slack.com/apps> → **Create New App** → *From scratch*.
2. **OAuth & Permissions** → Bot Token Scopes → thêm `chat:write`.
3. **Install to Workspace** → copy **Bot User OAuth Token** (`xoxb-…`).
4. Mời bot vào kênh: gõ `/invite @<tên bot>` trong kênh đó.
5. Lấy Channel ID: bấm tên kênh → cuối cửa sổ có ID dạng `C0123ABCD`.

> Thêm scope sau khi đã cài app thì **phải cài lại** (*OAuth & Permissions →
> Reinstall to Workspace*); token cũ giữ nguyên bộ scope cũ và trả
> `missing_scope`. Cài lại có thể đổi token → cập nhật lại secret `SLACK_BOT_TOKEN`.

### 3. Bật thông báo tự động

Trong repo: **Settings → Secrets and variables → Actions**

| Loại | Tên | Giá trị |
|---|---|---|
| Secret | `SLACK_BOT_TOKEN` | `xoxb-…` |
| Secret | `SLACK_CHANNEL_ID` | `C0123ABCD` |
| Variable | `PAGES_BASE_URL` | `https://<user>.github.io/esports-hub` |
| Variable | `LEAD_MINUTES` | `30` (không bắt buộc) |

Chạy thử tay: tab **Actions → Thông báo lịch thi đấu → Run workflow**.

> GitHub tự tắt scheduled workflow nếu repo không có hoạt động nào trong 60 ngày.
> Workflow này tự commit `state/announced.json` mỗi khi có tin mới nên thường
> không dính, nhưng nếu bot im lâu thì kiểm tra chỗ này đầu tiên.

### 4. Bật slash command

```bash
cd worker
cp .dev.vars.example .dev.vars     # điền Signing Secret để chạy local
# sửa PAGES_BASE_URL trong wrangler.toml
npx wrangler login
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler deploy
```

Sau đó trong Slack App:

1. **Slash Commands → Create New Command**
   - Command: `/lol`
   - Request URL: URL Worker vừa deploy
   - Short description: `Lịch thi đấu và chỉ số LoL esports`
2. **Reinstall to Workspace** để lệnh có hiệu lực.

---

## Cách dùng

**Slash command**

```
/lol                          hướng dẫn
/lol schedule                 lịch 24 giờ tới
/lol schedule 6               lịch 6 giờ tới
/lol live                     các trận đang diễn ra
/lol match 116878159559860047 chi tiết một trận
/lol live --share             đăng cho cả kênh thấy (mặc định chỉ mình bạn thấy)
```

**Trang web**

- `docs/index.html` — trận đang đá + lịch sắp tới, có ô dán ID trận
- `docs/match.html?match=<id>` — bảng chỉ số, biểu đồ chênh lệch vàng, bảng 10 người chơi
- `docs/match.html?game=<gameId>` — vào thẳng một ván cụ thể

---

## Lọc giải

`config/leagues.json`:

```json
{ "mode": "all", "exclude": [] }
```

- `mode: "all"` — báo tất cả giải, trừ những slug trong `exclude`
- `mode: "include"` — chỉ báo những slug trong `include`

Slug lấy từ `getLeagues` (`lck`, `lpl`, `lec`, `lcs`, `vcs`, `worlds`, `msi`, …).
Mặc định đang bật **tất cả các giải** nên khá nhiều tin; muốn bớt thì thêm slug
vào `exclude` rồi commit.

---

## Chạy và kiểm thử local

```bash
cp .env.example .env          # điền token nếu muốn bắn thật vào Slack

npm run smoke                 # kiểm tra provider bằng dữ liệu thật
npm run notify:dry            # in Block Kit ra stdout, không gửi Slack
npm run notify                # gửi thật (cần .env)
npm run serve                 # phục vụ docs/ tại cổng 8080

node src/providers/lol.js --stats <gameId>    # chỉ số một ván
node src/providers/lol.js --match <matchId>   # JSON đầy đủ một trận

cd worker && npx wrangler dev                 # thử slash command local
```

Kiểm tra chống gửi trùng: chạy `npm run notify:dry` hai lần liên tiếp — lần thứ hai
phải không in tin nào. Xoá `state/announced.json` thì tin quay lại.

---

## Ghi chú vận hành

- **Chống gửi trùng** dựa vào `state/announced.json` được Actions commit ngược về
  repo, chứ không dựa vào cron chạy đúng giờ.
- Chỉ những trận đã được báo "sắp diễn ra" mới sinh reply "đã bắt đầu" / "kết thúc",
  nên bot không bình luận vào trận mà kênh chưa từng thấy.
- Nếu cron trễ đến mức bỏ qua hẳn trạng thái `inProgress`, bot sẽ nhảy thẳng sang
  tin kết thúc thay vì gửi cả hai — mất một tin, không sai dữ liệu.
- Trang web ngừng gọi API khi tab bị ẩn, gọi lại ngay khi quay lại tab.
