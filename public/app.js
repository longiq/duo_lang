const micBtn = document.getElementById('micBtn');
const micStatus = document.getElementById('micStatus');
const vietnameseText = document.getElementById('vietnameseText');
const englishText = document.getElementById('englishText');
const japaneseText = document.getElementById('japaneseText');
const speakEnBtn = document.getElementById('speakEnBtn');
const speakJaBtn = document.getElementById('speakJaBtn');
const errorMsg = document.getElementById('errorMsg');

let currentEn = '';
let currentJa = '';

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.hidden = false;
}

function clearError() {
  errorMsg.hidden = true;
}

function setText(el, text, isPlaceholder) {
  el.textContent = text;
  el.classList.toggle('placeholder', Boolean(isPlaceholder));
}

async function translate(text) {
  micStatus.textContent = 'Đang dịch...';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lỗi dịch thuật.');
    }
    currentEn = data.en;
    currentJa = data.ja;
    setText(englishText, data.en, false);
    setText(japaneseText, data.ja, false);
    speakEnBtn.disabled = false;
    speakJaBtn.disabled = false;
    micStatus.textContent = 'Bấm micro và nói tiếng Việt';
  } catch (err) {
    showError(err.message || 'Không thể dịch câu này.');
    micStatus.textContent = 'Bấm micro và nói tiếng Việt';
  }
}

function speak(text, lang) {
  if (!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  window.speechSynthesis.speak(utterance);
}

speakEnBtn.addEventListener('click', () => speak(currentEn, 'en-US'));
speakJaBtn.addEventListener('click', () => speak(currentJa, 'ja-JP'));

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionImpl) {
  micBtn.disabled = true;
  showError('Trình duyệt này không hỗ trợ nhận diện giọng nói. Hãy dùng Chrome trên Android/desktop.');
} else {
  const recognition = new SpeechRecognitionImpl();
  recognition.lang = 'vi-VN';
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let isRecording = false;

  recognition.addEventListener('start', () => {
    isRecording = true;
    micBtn.classList.add('recording');
    micStatus.textContent = 'Đang nghe...';
    clearError();
  });

  recognition.addEventListener('end', () => {
    isRecording = false;
    micBtn.classList.remove('recording');
  });

  recognition.addEventListener('error', (event) => {
    isRecording = false;
    micBtn.classList.remove('recording');
    if (event.error === 'no-speech') {
      micStatus.textContent = 'Không nghe thấy gì, thử lại nhé.';
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showError('Cần cấp quyền micro cho trang này.');
    } else {
      showError('Lỗi nhận diện giọng nói: ' + event.error);
    }
  });

  recognition.addEventListener('result', (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    if (finalTranscript) {
      setText(vietnameseText, finalTranscript.trim(), false);
      translate(finalTranscript.trim());
    } else if (interimTranscript) {
      setText(vietnameseText, interimTranscript.trim(), false);
    }
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    speakEnBtn.disabled = true;
    speakJaBtn.disabled = true;
    setText(englishText, 'Bản dịch tiếng Anh sẽ hiện ở đây...', true);
    setText(japaneseText, '日本語の翻訳がここに表示されます...', true);
    clearError();
    try {
      recognition.start();
    } catch (err) {
      showError('Không thể bắt đầu ghi âm: ' + err.message);
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
