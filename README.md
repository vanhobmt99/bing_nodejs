# Microsoft Rewards Automation Tool (v5.0)

Account monitoring: [Grafana setup](docs/monitoring.md).

Công cụ tự động cày điểm Microsoft Rewards phiên bản 5.0, hỗ trợ đa tài khoản, chạy mượt mà trên nền tảng Chromium chống phát hiện bot.

---

## 🚀 Cách Cài Đặt & Sử Dụng (Dành Cho Người Mới)

### Bước 1: Yêu cầu cài đặt trước

- Cài đặt **Node.js** (phiên bản 24 trở lên): [Tải Node.js tại đây](https://nodejs.org/)
- Cài đặt **Git**: [Tải Git tại đây](https://git-scm.com/)

---

### Bước 2: Tải code về máy

Mở Terminal hoặc Command Prompt (CMD) và chạy lệnh:

```bash
git clone https://github.com/vanhobmt99/bing_nodejs.git
cd bing_nodejs
```

---

### Bước 3: Cấu hình tài khoản (.env)

1. Tạo một file tên là `.env` ở ngay thư mục gốc của dự án (ngang hàng với file `package.json`).
2. Điền thông tin các tài khoản cần chạy theo mẫu sau:

```env
# Tài khoản 1
ACCOUNT_1_EMAIL="email_1@outlook.com"
ACCOUNT_1_PASSWORD="mat_khau_1"

# Tài khoản 2
ACCOUNT_2_EMAIL="email_2@outlook.com"
ACCOUNT_2_PASSWORD="mat_khau_2"

# Bạn có thể thêm tiếp ACCOUNT_3, ACCOUNT_4,... tuỳ ý
```

> **Lưu ý:** File `.env` chứa mật khẩu cá nhân của bạn, đã được hệ thống ẩn hoàn toàn trên Git, tuyệt đối an toàn và không bị lộ lên mạng.

---

### Bước 4: Chạy Tool (Chỉ 1 Click)

👉 **Cách 1 (Dễ nhất - Khuyên dùng):**

- Nhấp đúp chuột trực tiếp vào file **`run.bat`**.
- File sẽ tự động kiểm tra, tự cài đặt thư viện, tự tải trình duyệt Chromium và tự chạy từ A đến Z!

👉 **Cách 2 (Chạy thủ công bằng lệnh):**

```bash
npm install
npm run install:browser
npm run build
npm start
```

---

## 📖 Giải Thích Chi Tiết Cấu Hình (config.json)

File `config.json` điều khiển toàn bộ hành vi của bot. Dưới đây là ý nghĩa chi tiết từng thông số:

### 1. Cấu hình chung

| Thông số                      | Giá trị khuyên dùng      | Giải thích                                                                                                                 |
| :---------------------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `"headless"`                  | `true`                   | `true`: Chạy ngầm không hiện cửa sổ trình duyệt (tiết kiệm RAM/CPU). Đổi thành `false` nếu muốn hiện màn hình để theo dõi. |
| `"clusters"`                  | `6`                      | Số lượng tài khoản được phép chạy luân phiên / phân cụm xử lý.                                                             |
| `"rewardsMode"`               | `"browser"`              | Chế độ chạy: `"browser"` (mở trình duyệt thật thao tác - an toàn nhất, chống bot) hoặc `"api"` (gửi request trực tiếp).    |
| `"ensureStreakProtection"`    | `true`                   | Tự động kích hoạt ngày bảo vệ chuỗi điểm danh (Streak Protection) nếu có.                                                  |
| `"autoClaimPunchcardRewards"` | `true`                   | Tự động bấm nhận thưởng khi hoàn thành xong các nhiệm vụ thẻ bài/tuần (Punchcard).                                         |
| `"continueOnBotWarning"`      | `true`                   | Vẫn tiếp tục chạy các tác vụ an toàn ngay cả khi tài khoản bị gắn cảnh báo tạm thời từ Microsoft.                          |
| `"accountDelay"`              | `min: 30sec, max: 1min`  | Thời gian nghỉ ngẫu nhiên giữa 2 tài khoản (tránh đổi nick quá nhanh gây nghi ngờ).                                        |
| `"taskDelay"`                 | `min: 12sec, max: 20sec` | Thời gian nghỉ giữa các nhiệm vụ thẻ bài (click nhiệm vụ xong nghỉ một chút trước khi làm nhiệm vụ tiếp).                  |

---

### 2. Bật/Tắt các nhiệm vụ ("workers")

Bạn có thể bật (`true`) hoặc tắt (`false`) từng tác vụ cụ thể:

- `"doDailySet"`: Làm bộ nhiệm vụ hàng ngày (Daily Set 3 thẻ đầu trang).
- `"doMorePromotions"`: Làm các nhiệm vụ phụ ở mục "Keep earning / More activities".
- `"doPunchCards"`: Làm nhiệm vụ tuần và thẻ bài đặc biệt (như quest tuần 100-500 điểm).
- `"doDesktopSearch"`: Tìm kiếm trên máy tính (PC Search).
- `"doMobileSearch"`: Tìm kiếm trên điện thoại (Mobile Search).
- `"doBonusSearches"`: Tìm kiếm thưởng thêm nếu có chương trình ưu đãi.
- `"doDailyCheckIn"`: Điểm danh hàng ngày trên App Bing di động.
- `"doReadToEarn"`: Đọc báo kiếm điểm trên App Bing (Read to Earn).
- `"doClaimBonusPoints"`: Tự động gom sạch các điểm thưởng còn treo vào cuối ngày.

---

### 3. Cài đặt tìm kiếm ("searchSettings") — Tối ưu Star Bonus 2,100 điểm

| Thông số                  | Giá trị khuyên dùng                        | Giải thích                                                                                                                  |
| :------------------------ | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `"scrollRandomResults"`   | `true`                                     | Tự động cuộn trang lên xuống như người thật đọc kết quả tìm kiếm (rất quan trọng để tích điểm Star Bonus).                  |
| `"clickRandomResults"`    | `true`                                     | Tự động click vào 1 trong các link kết quả tìm kiếm để tạo tương tác thật.                                                  |
| `"searchResultVisitTime"` | `"12sec"`                                  | Thời gian dừng lại đọc trang web sau khi click (dừng trên 10s giúp Microsoft tính điểm tìm kiếm chất lượng).                |
| `"searchDelay"`           | `min: 12sec, max: 30sec`                   | Thời gian nghỉ giữa 2 lần tìm kiếm liên tiếp (khoảng cách an toàn tuyệt đối, chống dính cooldown).                          |
| `"runOnZeroPoints"`       | `false`                                    | `false`: Khi tài khoản đã đạt tối đa điểm tìm kiếm trong ngày (90/90 hoặc 60/60) thì dừng ngay, không tìm kiếm thêm vô ích. |
| `"queryEngines"`          | `google, local, wikipedia, rss.googleNews` | Nguồn lấy từ khóa tìm kiếm phong phú từ tin tức thời sự và Google Trends.                                                   |

---

## 🛡️ Điểm Mạnh Của Bản v5 Này

- **Lưu phiên đăng nhập riêng:** Mobile và Desktop khôi phục cookie của từng phiên riêng biệt. Lần đăng nhập Mobile đầu tiên có thể cần xác minh OTP; cookie Desktop không ghi đè phiên Mobile đã xác thực.
- **Tự nhận diện giao diện tiếng Việt & khu vực VN:** Tự động đọc đúng 100% hạn ngạch tìm kiếm và trạng thái chuỗi ngày của tài khoản Việt Nam (`0 unknown`).
- **Tối đa hóa Star Bonus:** Đạt đầy đủ các tiêu chuẩn "Genuine Search" để nhận trọn 2,100 điểm thưởng hàng tháng.
