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

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices = [];

function loadVoices() {
  voices = (synth && typeof synth.getVoices === 'function' && synth.getVoices()) || [];
}
loadVoices();
// iOS returns an empty list until the voices finish loading.
if (synth && typeof synth.addEventListener === 'function') {
  synth.addEventListener('voiceschanged', loadVoices);
}

// iOS ships character voices (Grandpa, Grandma, Jester, Rocko...) and legacy
// novelty ones (Fred, Ralph, Zarvox...) right alongside the real ones, so
// "first non-compact match" is not a safe pick -- it lands on those.
const NOVELTY_VOICE = /grandpa|grandma|jester|rocko|sandy|shelley|eddy|\bflo\b|reed|rosa|bahh|albert|bad news|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|junior|kathy|organ|princess|ralph|trinoids|whisper|zarvox|wobble|superstar|bruce|agnes/i;

const normLang = (l) => (l || '').toLowerCase().replace('_', '-');

// Higher is better; below zero means never use it.
function voiceScore(v) {
  const uri = v.voiceURI || '';
  const name = v.name || '';
  if (NOVELTY_VOICE.test(name)) return -1;
  if (/com\.apple\.speech\.synthesis\.voice/.test(uri)) return -1;
  if (/eloquence/i.test(uri)) return -1;

  let score;
  if (/premium/i.test(uri)) score = 40;
  else if (/enhanced/i.test(uri)) score = 30;
  else if (/siri/i.test(uri)) score = 25;
  else if (/compact/i.test(uri)) score = 5;
  else score = 10;

  if (v.default) score += 8;
  if (v.localService === false) score += 3;
  return score;
}

function pickVoice(lang) {
  const prefix = lang.split('-')[0].toLowerCase();
  const matches = voices.filter((v) => normLang(v.lang).startsWith(prefix));
  if (!matches.length) return null;

  const exact = matches.filter((v) => normLang(v.lang) === lang.toLowerCase());
  const ranked = (exact.length ? exact : matches)
    .map((v) => ({ voice: v, score: voiceScore(v) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  // If every candidate is a novelty voice, leave the choice to the platform
  // rather than forcing a bad one.
  return ranked.length ? ranked[0].voice : null;
}

function speak(text, lang) {
  if (!text || !synth) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.volume = 1;
  utterance.rate = 0.95;
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
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
  // Best transcript seen this session, final or not. Mobile browsers routinely
  // end recognition without ever marking a result final -- especially when the
  // user taps the button to stop -- so the interim text is all we get.
  let lastTranscript = '';
  let translationStarted = false;
  let sessionFailed = false;

  recognition.addEventListener('start', () => {
    isRecording = true;
    lastTranscript = '';
    translationStarted = false;
    sessionFailed = false;
    micBtn.classList.add('recording');
    micStatus.textContent = 'Đang nghe...';
    clearError();
  });

  recognition.addEventListener('end', () => {
    isRecording = false;
    micBtn.classList.remove('recording');
    if (!translationStarted && lastTranscript) {
      translationStarted = true;
      translate(lastTranscript);
    } else if (!translationStarted && !sessionFailed) {
      micStatus.textContent = 'Bấm micro và nói tiếng Việt';
    }
  });

  recognition.addEventListener('error', (event) => {
    isRecording = false;
    sessionFailed = true;
    micBtn.classList.remove('recording');
    if (event.error === 'no-speech') {
      micStatus.textContent = 'Không nghe thấy gì, thử lại nhé.';
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showError('Cần cấp quyền micro cho trang này.');
    } else if (event.error === 'aborted') {
      micStatus.textContent = 'Bấm micro và nói tiếng Việt';
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

    const text = (finalTranscript || interimTranscript).trim();
    if (!text) return;

    lastTranscript = text;
    setText(vietnameseText, text, false);
    if (finalTranscript) {
      translationStarted = true;
      translate(text);
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
