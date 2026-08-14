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

## 4. Lớp chặn 2 — cap theo từng tier trong app

Free tier của Google **tính riêng cho từng loại giọng**, nên app dùng hết tier cao rồi tự tụt xuống tier thấp, cộng lại được nhiều hơn nhiều:

| Tier | Google cho miễn phí/tháng | Cap app (80%) |
|---|---|---|
| Chirp3-HD | 1M | 800.000 |
| Neural2 | 1M | 800.000 |
| WaveNet | 1M | 800.000 |
| Standard | 4M | 3.200.000 |
| **Tổng** | **7M** | **5.600.000** |

5,6 triệu ký tự ≈ **93.000 câu/tháng** (~3.000 câu/ngày).

Server đếm riêng từng tier, ghi ra `tts-usage.json`, và **từ chối trước khi gọi Google** khi mọi tier đã hết. Nếu Google trả 429 cho một tier (quota bên họ hết trước cap của mình), app đánh dấu tier đó và chuyển xuống tier dưới ngay trong cùng request.

```bash
# /opt/duolang/.env
GOOGLE_TTS_API_KEY=<key vua tao>
TTS_BUDGET_FRACTION=0.8
TTS_TIER_ORDER=Chirp3-HD,Neural2,Wavenet,Standard
```

Kiểm tra mức đã dùng bất cứ lúc nào:

```bash
curl -s https://duolang.longiq.xyz/api/tts/usage | python3 -m json.tool
```

```json
{
  "provider": "google-cloud-tts",
  "period": "2026-08",
  "totalUsed": 77,
  "totalBudget": 5600000,
  "totalRemaining": 5599923,
  "tiers": [
    { "tier": "Chirp3-HD", "used": 77, "budget": 800000, "remaining": 799923, "quotaExhausted": false },
    { "tier": "Neural2",   "used": 0,  "budget": 800000, "remaining": 800000, "quotaExhausted": false }
  ]
}
```

Response của `/api/tts` có header `X-TTS-Tier` cho biết tier nào đã đọc câu đó.

Bộ đếm ghi ra đĩa nên restart server không reset, và tự về 0 khi sang tháng mới. Hết toàn bộ thì app lùi về giọng máy kèm thông báo, không im lặng.

Cache cũng giúp tiết kiệm: nghe lại câu đã đọc **không tốn ký tự nào và không gọi lên Google**.

Muốn chặn tổng thể bất kể tier, đặt thêm `TTS_MONTHLY_CHAR_LIMIT` (mặc định tắt).

## 5. Lớp chặn 3 — budget alert để biết sớm

Vẫn nên đặt, không phải để chặn mà để được cảnh báo nếu có gì bất thường:

**Billing → Budgets & alerts → Create budget**, đặt ngưỡng $1, bật email ở 50%/90%/100%.

Nếu muốn chặn cứng bằng cách tự tắt billing thì cần Budget → Pub/Sub → Cloud Function gọi API tắt billing. Cách này **tắt toàn bộ mọi service trong project** kể cả free tier, và vẫn có độ trễ — với app này thì lớp 1 + 2 đã đủ.

## 6. Đổi giọng nếu muốn

Giọng của từng tier khai báo trong `TIER_VOICES` (`server/index.js`), không phải qua biến môi trường —
tự sửa file nếu muốn đổi tên giọng:

```js
const TIER_VOICES = {
  'Chirp3-HD': { vi: 'vi-VN-Chirp3-HD-Achernar', en: 'en-US-Chirp3-HD-Achernar', ja: 'ja-JP-Chirp3-HD-Achernar' },
  Neural2: { vi: 'vi-VN-Neural2-A', en: 'en-US-Neural2-F', ja: 'ja-JP-Neural2-B' },
  Wavenet: { vi: 'vi-VN-Wavenet-A', en: 'en-US-Wavenet-F', ja: 'ja-JP-Wavenet-B' },
  Standard: { vi: 'vi-VN-Standard-A', en: 'en-US-Standard-C', ja: 'ja-JP-Standard-A' },
};
```

Muốn đổi thứ tự thử hoặc bỏ bớt tier thì sửa `TTS_TIER_ORDER` trong `.env`
(mục 4 ở trên), ví dụ chỉ dùng Wavenet và Standard: `TTS_TIER_ORDER=Wavenet,Standard`.

Xem danh sách giọng có sẵn cho một ngôn ngữ:

```bash
curl -s "https://texttospeech.googleapis.com/v1/voices?languageCode=vi-VN&key=$GOOGLE_TTS_API_KEY" \
  | grep -oE '"name": "[^"]*"'
```

Giọng **Standard** có free tier rộng hơn (4 triệu/tháng) nhưng nghe máy hơn. **Neural2** chất lượng cao hơn WaveNet, free tier cũng 1 triệu.

## Nếu không muốn gắn thẻ

Bỏ `GOOGLE_TTS_API_KEY` khỏi `.env` là app tự quay về Gemini TTS (10 request/ngày mỗi model, 2 model), hoặc giọng máy khi hết. Không cần sửa code.
