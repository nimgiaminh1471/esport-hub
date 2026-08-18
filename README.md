# Esports Hub

Bot Slack thông báo lịch thi đấu esports + trang web xem chỉ số trong trận theo thời gian thực.
Hiện hỗ trợ **League of Legends** và **VALORANT**; thêm game mới chỉ tốn một file core.

Lưu ý ngay từ đầu: **Valorant không có chỉ số trong trận** — Riot không phát hành feed
livestats cho game này (xem phần Nguồn dữ liệu). Valorant có lịch, kết quả, danh sách map;
phần biểu đồ và bảng người chơi chỉ LoL mới có.

Ba phần rời nhau, không phần nào cần máy chủ thường trú:

| Phần | Chạy ở đâu | Việc |
|---|---|---|
| `src/notify.js` | GitHub Actions cron (5 phút/lần) | Báo trận sắp diễn ra, trận vào trận, trận kết thúc |
| `worker/` | Cloudflare Workers | Slash command `/lol` và `/val`: `schedule`, `live`, `match <id>` |
| `docs/` | GitHub Pages | Lịch + trang chỉ số trong trận (LoL), cập nhật 10 giây/lần |

---

## Nguồn dữ liệu

API esports công khai của Riot. Điểm mấu chốt khiến kiến trúc này khả thi: nó trả
`Access-Control-Allow-Origin: *`, nên **trang tĩnh gọi thẳng từ trình duyệt được** —
không cần backend, không cần proxy, không có khoá bí mật nào phía client.

Hai game dùng **chung một gateway, chung một khoá, chung một shape dữ liệu** — khác nhau đúng
một query param `sport=val`.

| Endpoint | Việc | Cần key |
|---|---|---|
| `esports-api.lolesports.com/persisted/gw/*` | LoL: lịch, giải, chi tiết trận | `x-api-key` (khoá công khai mà chính web lolesports dùng) |
| `esports-api.service.valorantesports.com/persisted/val/*?sport=val` | Valorant: lịch, giải, chi tiết trận | cùng khoá đó |
| `feed.lolesports.com/livestats/v1/window/<gameId>` | vàng, hạ gục, trụ, rồng, KDA/CS từng người | không |
| `feed.lolesports.com/livestats/v1/details/<gameId>` | trang bị, ngọc, tỉ lệ sát thương, mắt | không |
| `ddragon.leagueoflegends.com` | ảnh tướng / trang bị / ngọc | không |

### Ba giới hạn cần biết trước

0. **Valorant không hề có feed chỉ số trong trận.** `feed.valorantesports.com` không phân giải
   được DNS, và feed của LoL trả 204 cho mọi gameId Valorant. `getLive` cũng trả 400 nên phải
   suy ra từ lịch. Đây là giới hạn vĩnh viễn — đã thử, không có endpoint thay thế. Ngoài ra
   `getEventDetails` của Valorant không trả tên map (Bind/Haven…), chỉ có số thứ tự map.
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
docs/assets/riot-core.js  ← transport + factory gateway, không biết game nào
    ├── lol-core.js           LoL: gateway + feed livestats
    └── val-core.js           Valorant: gateway, không có feed
docs/assets/games.js      ← registry, cả ba nơi cùng import
    ├── src/providers/*.js        (Node import lại, thêm CLI)
    ├── docs/assets/*-page.js     (trình duyệt import trực tiếp)
    └── worker/src/index.js       (wrangler bundle vào)
```

Một nguồn sự thật duy nhất cho cả ba nơi — không có bản sao logic nào phải giữ đồng bộ.

### Thêm game mới

**Định nghĩa interface đầy đủ nằm ở comment đầu `docs/assets/games.js`** — đọc ở đó, đừng đọc
ở đây, vì trước kia ba chỗ chép lại nhau rồi lệch nhau lúc nào không hay.

Tóm tắt: viết `docs/assets/<game>-core.js` (thường chỉ là một lời gọi `createRiotGateway`),
thêm một dòng vào `docs/assets/games.js`. `src/notify.js`, `src/lib/*`, `worker/`, workflow và
các trang web không phải sửa gì — lần này là thật, Valorant là bằng chứng.

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
2. Tạo thêm lệnh `/val` **trỏ vào đúng URL Worker đó** (Worker đọc `command` Slack gửi kèm để
   biết game nào — một Worker phục vụ mọi game, không phải deploy thêm).
   - Short description: `Lịch thi đấu VALORANT esports`
3. **Reinstall to Workspace** để lệnh có hiệu lực.

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

/val schedule                 y hệt, nhưng cho Valorant
/val match <id>               chi tiết series + danh sách map (không có chỉ số)
```

**Trang web**

- `docs/index.html` — trận đang đá + lịch sắp tới, có ô dán ID trận
- `docs/index.html?sport=val` — y hệt, cho Valorant
- `docs/match.html?match=<id>` — bảng chỉ số, biểu đồ chênh lệch vàng, bảng 10 người chơi
- `docs/match.html?match=<id>&sport=val` — series Valorant: tỉ số, danh sách map, VOD
- `docs/match.html?game=<gameId>` — vào thẳng một ván LoL cụ thể

> Chọn game bằng `?sport=`, **không phải** `?game=` — `?game=` đã mang nghĩa "id ván" từ trước.

---

## Lọc giải

`config/leagues.json` — cấu hình gốc áp cho LoL, game khác nằm trong `games.<id>`:

```json
{ "mode": "all", "exclude": [],
  "games": { "val": { "mode": "all", "exclude": [] } } }
```

- `mode: "all"` — báo tất cả giải, trừ những slug trong `exclude`
- `mode: "include"` — chỉ báo những slug trong `include`
- game không có mục riêng trong `games` thì dùng cấu hình gốc

Slug lấy từ `getLeagues` của từng game — LoL: `lck`, `lpl`, `lec`, `worlds`, `msi`…;
Valorant: `champions`, `vct_masters`, `vct_emea`, `challengers_sea_vn`… (54 slug).

Cả hai đang bật **tất cả các giải**. Nghe thì nhiều nhưng đo thực tế Valorant chỉ khoảng
5 trận/24h, vì phần lớn giải khu vực không chạy cùng lúc. Đếm trước khi lo:
`GAME=val npm run notify:dry` rồi xem dòng tổng kết. Muốn bớt thì thêm slug vào `exclude`.

---

## Chạy và kiểm thử local

```bash
cp .env.example .env          # điền token nếu muốn bắn thật vào Slack

npm run smoke                 # kiểm tra provider LoL bằng dữ liệu thật
npm run smoke:val             # kiểm tra provider Valorant
npm run notify:dry            # in Block Kit ra stdout, không gửi Slack (cả hai game)
GAME=val npm run notify:dry   # chỉ một game
npm run notify                # gửi thật (cần .env)
npm run serve                 # phục vụ docs/ tại cổng 8080

node src/providers/lol.js --stats <gameId>       # chỉ số một ván
node src/providers/lol.js --match <matchId>      # JSON đầy đủ một trận
node src/providers/valorant.js --match <matchId> # series + danh sách map

cd worker && npx wrangler dev                 # thử slash command local
```

Kiểm tra chống gửi trùng: chạy `npm run notify:dry` hai lần liên tiếp — lần thứ hai
phải không in tin nào. Xoá `state/announced*.json` thì tin quay lại.

---

## Ghi chú vận hành

- **Chống gửi trùng** dựa vào `state/announced*.json` được Actions commit ngược về
  repo, chứ không dựa vào cron chạy đúng giờ. Mỗi game một file riêng
  (`announced.json` cho LoL, `announced-val.json` cho Valorant) nên không xoá nhầm nhau.
- **Một tiến trình chạy hết mọi game**, tuần tự. Cố ý không dùng matrix của Actions:
  `concurrency` chỉ tuần tự hoá các lần chạy workflow chứ không tuần tự hoá các nhánh
  matrix, nên hai nhánh sẽ đua nhau commit `state/` và vòng rebase gặp conflict.
- Chỉ những trận đã được báo "sắp diễn ra" mới sinh reply "đã bắt đầu" / "kết thúc",
  nên bot không bình luận vào trận mà kênh chưa từng thấy.
- Nếu cron trễ đến mức bỏ qua hẳn trạng thái `inProgress`, bot sẽ nhảy thẳng sang
  tin kết thúc thay vì gửi cả hai — mất một tin, không sai dữ liệu.
- Trang web ngừng gọi API khi tab bị ẩn, gọi lại ngay khi quay lại tab.
