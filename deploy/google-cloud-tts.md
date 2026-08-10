# Bật Google Cloud TTS và chặn khả năng bị tính tiền

Cloud TTS có free tier **vĩnh viễn, reset hàng tháng** (không phải trial): 4 triệu ký tự/tháng cho giọng Standard, 1 triệu cho WaveNet/Neural2. Một câu khoảng 60 ký tự → 1 triệu ký tự ≈ **16.000 câu/tháng**. So với Gemini TTS free tier chỉ 10 request/ngày.

Đổi lại: **phải gắn thẻ vào billing account** mới bật được API, dù free tier vẫn $0. Phần dưới dựng 3 lớp chặn để việc bị tính tiền thực tế không xảy ra.

## 1. Tạo project và bật API

1. Vào [Google Cloud Console](https://console.cloud.google.com/), tạo project mới (ví dụ `duolang-tts`).
2. Gắn billing account (cần thẻ). Nếu là tài khoản mới sẽ có $300 credit.
3. Vào **APIs & Services → Library**, tìm **Cloud Text-to-Speech API**, bấm **Enable**.

## 2. Tạo API key và giới hạn phạm vi

1. **APIs & Services → Credentials → Create credentials → API key**.
2. Bấm **Edit API key** ngay sau khi tạo:
   - **API restrictions** → chọn **Restrict key** → tick **chỉ** `Cloud Text-to-Speech API`.
   - Đây là bước quan trọng: key không bị hạn chế mà lộ ra ngoài thì dùng được mọi API đã enable trong project.
3. Copy key.

## 3. Lớp chặn 1 — quota trên chính API (chặn cứng, đáng tin nhất)

⚠️ **Budget alert KHÔNG chặn tiền** — nó chỉ gửi email, dịch vụ vẫn chạy và vẫn tính tiền. Đừng dựa vào nó.

Cơ chế chặn thật là quota:

1. Vào **IAM & Admin → Quotas & System Limits**.
2. Filter theo service **Cloud Text-to-Speech API**.
3. Tìm quota ký tự (ví dụ *Wavenet characters per minute* / *per day*), bấm **Edit Quotas**.
4. Đặt giá trị thấp hơn free tier — ví dụ **30.000 ký tự/ngày** (≈ 900.000/tháng, vẫn dưới 1 triệu).

Vượt ngưỡng thì API trả **429**, không tạo thêm usage, nên không phát sinh tiền. Không phụ thuộc độ trễ báo cáo chi phí.

## 4. Lớp chặn 2 — cap trong chính app

Server tự đếm ký tự đã dùng trong tháng, ghi ra `tts-usage.json`, và **từ chối trước khi gọi Google** khi vượt ngưỡng. Mặc định **200.000 ký tự/tháng = 20% free tier**.

```bash
# /opt/duolang/.env
GOOGLE_TTS_API_KEY=<key vua tao>
TTS_MONTHLY_CHAR_LIMIT=200000
```

Kiểm tra mức đã dùng bất cứ lúc nào:

```bash
curl -s https://duolang.longiq.xyz/api/tts/usage
# {"provider":"google-cloud-tts","period":"2026-08","charsUsed":1234,"charLimit":200000,"remaining":198766}
```

Bộ đếm ghi ra đĩa nên restart server không reset. Vượt ngưỡng thì app tự lùi về giọng máy kèm thông báo, không phải im lặng.

Cache cũng giúp tiết kiệm: nghe lại câu đã đọc **không tốn ký tự nào**.

## 5. Lớp chặn 3 — budget alert để biết sớm

Vẫn nên đặt, không phải để chặn mà để được cảnh báo nếu có gì bất thường:

**Billing → Budgets & alerts → Create budget**, đặt ngưỡng $1, bật email ở 50%/90%/100%.

Nếu muốn chặn cứng bằng cách tự tắt billing thì cần Budget → Pub/Sub → Cloud Function gọi API tắt billing. Cách này **tắt toàn bộ mọi service trong project** kể cả free tier, và vẫn có độ trễ — với app này thì lớp 1 + 2 đã đủ.

## 6. Đổi giọng nếu muốn

Mặc định dùng WaveNet (1 triệu ký tự/tháng miễn phí):

```bash
CLOUD_VOICE_VI=vi-VN-Wavenet-A
CLOUD_VOICE_EN=en-US-Wavenet-F
CLOUD_VOICE_JA=ja-JP-Wavenet-B
```

Xem danh sách giọng có sẵn cho một ngôn ngữ:

```bash
curl -s "https://texttospeech.googleapis.com/v1/voices?languageCode=vi-VN&key=$GOOGLE_TTS_API_KEY" \
  | grep -oE '"name": "[^"]*"'
```

Giọng **Standard** có free tier rộng hơn (4 triệu/tháng) nhưng nghe máy hơn. **Neural2** chất lượng cao hơn WaveNet, free tier cũng 1 triệu.

## Nếu không muốn gắn thẻ

Bỏ `GOOGLE_TTS_API_KEY` khỏi `.env` là app tự quay về Gemini TTS (10 request/ngày mỗi model, 2 model), hoặc giọng máy khi hết. Không cần sửa code.
