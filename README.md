# DuoLang

Nói một câu tiếng Việt → nhận diện giọng nói (STT) → dịch cùng lúc sang **tiếng Anh** và **tiếng Nhật** bằng AI (Gemini) → bấm nút loa để nghe lại (TTS) từng bản dịch.

Chạy dưới dạng PWA (Progressive Web App): mở bằng Chrome trên điện thoại rồi "Thêm vào Màn hình chính" để dùng như app thật, không cần lên App Store/Play Store.

## Vì sao không dùng thẳng Google Dịch?

Google Dịch chỉ dịch theo từng cặp ngôn ngữ (Việt↔Anh hoặc Việt↔Nhật) và dùng máy dịch thông thường. DuoLang gọi thẳng **Gemini API** (LLM) để dịch, cho câu văn tự nhiên hơn, và hiển thị cả hai bản dịch Anh + Nhật cùng lúc từ một lần nói.

## Kiến trúc

- **Frontend** (`public/`): HTML/CSS/JS thuần, không cần build. Dùng `SpeechRecognition` (Web Speech API) của trình duyệt để STT tiếng Việt, và `speechSynthesis` để TTS đọc tiếng Anh/Nhật.
- **Backend** (`server/`): server Express nhỏ, nhận câu tiếng Việt, gọi Gemini API để dịch song song sang Anh + Nhật, trả JSON. API key được giữ ở server, **không lộ ra trình duyệt**.
- **PWA**: `manifest.json` + `sw.js` (service worker) để cài được lên điện thoại và cache tài nguyên tĩnh.

## Cài đặt & chạy

### 1. Lấy Gemini API key (miễn phí)

Vào [Google AI Studio](https://aistudio.google.com/apikey), đăng nhập bằng tài khoản Google, tạo API key miễn phí (free tier).

### 2. Cấu hình

```bash
cp .env.example .env
# Mở .env, dán API key vào GEMINI_API_KEY=...
```

### 3. Cài dependencies & chạy

```bash
npm install
npm start
```

Mở trình duyệt tại `http://localhost:3000`.

### 4. Cài lên điện thoại (PWA)

Để dùng trên điện thoại, cần deploy server lên một địa chỉ HTTPS công khai (Web Speech API và service worker yêu cầu HTTPS, trừ localhost). Có thể deploy miễn phí lên Render, Railway, Fly.io, hoặc VPS riêng — nhớ đặt biến môi trường `GEMINI_API_KEY` trên nền tảng deploy.

Sau khi có URL HTTPS, mở bằng Chrome (Android) hoặc Safari (iOS) trên điện thoại → menu trình duyệt → **"Thêm vào Màn hình chính" / "Add to Home Screen"**.

## Cách dùng

1. Bấm nút micro.
2. Nói một câu tiếng Việt.
3. Bản ghi âm hiện ra, đồng thời bản dịch tiếng Anh và tiếng Nhật hiện ra bên dưới.
4. Bấm nút loa 🔊 cạnh mỗi bản dịch để nghe đọc bằng giọng máy.

## Ghi chú

- Nhận diện giọng nói và đọc TTS hoạt động tốt nhất trên **Chrome** (desktop & Android). Safari/iOS hỗ trợ hạn chế hơn cho `SpeechRecognition`.
- Chất lượng giọng đọc TTS phụ thuộc vào giọng có sẵn trên thiết bị/trình duyệt của bạn.
- Muốn đổi sang dùng Claude API thay vì Gemini: chỉnh phần gọi API trong `server/index.js` (hàm xử lý `/api/translate`).
