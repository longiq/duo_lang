require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// Bind to loopback by default: in the documented deployment nginx proxies to us,
// so the app itself never needs to be exposed. Set HOST=0.0.0.0 for containers.
const HOST = process.env.HOST || '127.0.0.1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Pinned rather than gemini-flash-latest so the model can't change underneath
// us. Check https://ai.google.dev/gemini-api/docs/models when bumping: retired
// models don't 404, they report a free-tier quota of 0.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Each TTS model carries its own free-tier allowance of only 10 requests per
// day, so exhausting one falls through to the next rather than failing.
const GEMINI_TTS_MODELS = (process.env.GEMINI_TTS_MODELS ||
  'gemini-2.5-flash-preview-tts,gemini-3.1-flash-tts-preview')
  .split(',').map((m) => m.trim()).filter(Boolean);
// One voice per language so the panes are audibly distinct. These are Gemini's
// prebuilt voices; the model infers the language from the text itself.
const TTS_VOICES = { vi: 'Puck', en: 'Kore', ja: 'Aoede' };
const TTS_MAX_CHARS = 600;

// Google Cloud Text-to-Speech, used in preference to Gemini when a key is
// configured: its free tier is 1M characters a month rather than 10 requests a
// day, and being a dedicated TTS service it never mistakes text for a prompt.
const CLOUD_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
// Overridable so tests can point at a local stand-in instead of spending quota.
const CLOUD_TTS_ENDPOINT = process.env.CLOUD_TTS_ENDPOINT ||
  'https://texttospeech.googleapis.com/v1/text:synthesize';
const CLOUD_TTS_VOICES = {
  vi: { languageCode: 'vi-VN', name: process.env.CLOUD_VOICE_VI || 'vi-VN-Wavenet-A' },
  en: { languageCode: 'en-US', name: process.env.CLOUD_VOICE_EN || 'en-US-Wavenet-F' },
  ja: { languageCode: 'ja-JP', name: process.env.CLOUD_VOICE_JA || 'ja-JP-Wavenet-B' },
};

// A cap the app enforces itself, well under the 1M/month free tier, so no
// configuration mistake on the Google side can turn into a bill. Google's own
// budget alerts only notify -- they do not stop spending.
const TTS_MONTHLY_CHAR_LIMIT = Number(process.env.TTS_MONTHLY_CHAR_LIMIT || 200000);
const TTS_USAGE_FILE = process.env.TTS_USAGE_FILE || path.join(__dirname, '..', 'tts-usage.json');

const LANG_NAMES = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' };
const SUPPORTED_LANGS = Object.keys(LANG_NAMES);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/translate', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" field.' });
  }

  // Defaults keep older cached clients, which only ever sent text, working.
  const source = (req.body && req.body.source || 'vi').toLowerCase();
  const targets = Array.isArray(req.body && req.body.targets) && req.body.targets.length
    ? req.body.targets.map((t) => String(t).toLowerCase())
    : SUPPORTED_LANGS.filter((l) => l !== source);

  if (!LANG_NAMES[source]) {
    return res.status(400).json({ error: `Unsupported source "${source}".` });
  }
  const badTarget = targets.find((t) => !LANG_NAMES[t]);
  if (badTarget) {
    return res.status(400).json({ error: `Unsupported target "${badTarget}".` });
  }
  if (targets.includes(source)) {
    return res.status(400).json({ error: 'Source language cannot also be a target.' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
  }

  const targetList = targets.map((t) => LANG_NAMES[t]).join(' and ');
  const shape = `{${targets.map((t) => `"${t}": "..."`).join(', ')}}`;
  const prompt = `You are a professional translator.
Translate the following ${LANG_NAMES[source]} sentence into natural, fluent ${targetList}.
Keep the original meaning, tone and level of politeness. Do not add explanations.
Respond ONLY with valid JSON in this exact shape: ${shape}

${LANG_NAMES[source]} sentence: "${text}"`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      })
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errBody);
      return res.status(502).json({ error: 'Translation service error.' });
    }

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      return res.status(502).json({ error: 'Empty response from translation service.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'Could not parse translation result.' });
    }

    const translations = {};
    for (const target of targets) {
      if (typeof parsed[target] !== 'string' || !parsed[target].trim()) {
        return res.status(502).json({ error: 'Malformed translation result.' });
      }
      translations[target] = parsed[target].trim();
    }

    // Spread as well as nest so a client cached before this change, which read
    // data.en / data.ja directly, keeps working.
    res.json({ source, translations, ...translations });
  } catch (err) {
    console.error('Translate request failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Gemini returns headerless 16-bit PCM, which decodeAudioData cannot read, so
// it gets a RIFF/WAVE header here rather than being reassembled in the browser.
function pcmToWav(pcm, sampleRate, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// "audio/L16;codec=pcm;rate=24000" and "audio/l16; rate=24000; channels=1" are
// both shapes the API has returned, so read the rate rather than assume it.
function parseAudioMime(mimeType) {
  const rate = /rate=(\d+)/i.exec(mimeType || '');
  const channels = /channels=(\d+)/i.exec(mimeType || '');
  return {
    sampleRate: rate ? Number(rate[1]) : 24000,
    channels: channels ? Number(channels[1]) : 1,
  };
}

// Synthesis is the expensive call, so keep recent clips to spend no quota when
// the same sentence is replayed after a reload.
const ttsCache = new Map();
const TTS_CACHE_MAX = 40;

function cacheGet(key) {
  if (!ttsCache.has(key)) return null;
  const value = ttsCache.get(key);
  ttsCache.delete(key);
  ttsCache.set(key, value); // reinsert to keep it recent
  return value;
}

function cacheSet(key, value) {
  ttsCache.set(key, value);
  while (ttsCache.size > TTS_CACHE_MAX) {
    ttsCache.delete(ttsCache.keys().next().value);
  }
}

// --- monthly character budget ----------------------------------------------
// Persisted so a restart cannot silently reset the allowance.

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readUsage() {
  const period = currentPeriod();
  try {
    const saved = JSON.parse(fs.readFileSync(TTS_USAGE_FILE, 'utf8'));
    if (saved && saved.period === period && Number.isFinite(saved.chars)) {
      return { period, chars: saved.chars };
    }
  } catch (err) {
    // Missing or unreadable: start the period at zero.
  }
  return { period, chars: 0 };
}

function recordUsage(chars) {
  const usage = readUsage();
  usage.chars += chars;
  try {
    fs.writeFileSync(TTS_USAGE_FILE, JSON.stringify(usage));
  } catch (err) {
    console.error('Could not persist TTS usage:', err.message);
  }
  return usage;
}

function budgetRemaining() {
  return Math.max(0, TTS_MONTHLY_CHAR_LIMIT - readUsage().chars);
}

// --- synthesis providers ----------------------------------------------------

async function synthesiseWithCloudTts(text, lang) {
  const voice = CLOUD_TTS_VOICES[lang];
  const url = `${CLOUD_TTS_ENDPOINT}?key=${CLOUD_TTS_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.languageCode, name: voice.name },
      // LINEAR16 comes back as a complete WAV, header included, so it needs no
      // repackaging before decodeAudioData.
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`Cloud TTS ${response.status}`);
    err.status = response.status;
    err.body = body.slice(0, 400);
    throw err;
  }

  const data = await response.json();
  if (!data.audioContent) {
    throw new Error('Cloud TTS returned no audio');
  }
  return Buffer.from(data.audioContent, 'base64');
}

async function synthesiseWithGemini(text, lang) {
  // Without an explicit instruction the model treats a greeting or a question
  // as something to answer and returns text, failing with "Model tried to
  // generate text". Phrasing it as a spoken instruction is the documented way
  // to drive these models, and the prefix itself is not read aloud.
  const prompt = `Read this text aloud exactly as written, in a natural voice: ${text}`;
  const voice = TTS_VOICES[lang];
  let lastErr = null;

  // Each model has its own daily allowance, so a 429 moves to the next one.
  for (const model of GEMINI_TTS_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const inline = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline || !inline.data) throw new Error('Gemini TTS returned no audio');
      const { sampleRate, channels } = parseAudioMime(inline.mimeType);
      return pcmToWav(Buffer.from(inline.data, 'base64'), sampleRate, channels);
    }

    const body = await response.text();
    lastErr = new Error(`Gemini TTS ${response.status}`);
    lastErr.status = response.status;
    lastErr.body = body.slice(0, 400);
    console.error(`Gemini TTS error (${model}):`, response.status, lastErr.body);
    if (response.status !== 429) break; // only quota is worth retrying elsewhere
  }

  throw lastErr || new Error('Gemini TTS failed');
}

app.post('/api/tts', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  const lang = (req.body && req.body.lang || '').trim().toLowerCase();

  if (!text) {
    return res.status(400).json({ error: 'Missing "text" field.' });
  }
  if (text.length > TTS_MAX_CHARS) {
    return res.status(413).json({ error: `Text longer than ${TTS_MAX_CHARS} characters.` });
  }
  if (!TTS_VOICES[lang]) {
    return res.status(400).json({ error: `Unsupported lang "${lang}". Use one of: ${Object.keys(TTS_VOICES).join(', ')}.` });
  }

  const useCloud = Boolean(CLOUD_TTS_API_KEY);
  if (!useCloud && !GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server has no speech credentials configured.' });
  }

  const cacheKey = `${lang}|${text}`;
  const sendWav = (wav, hit) => {
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': hit ? 'hit' : 'miss',
    });
    res.send(wav);
  };

  // Served from cache costs nothing, so it is checked before the budget.
  const cached = cacheGet(cacheKey);
  if (cached) return sendWav(cached, true);

  // Cloud TTS bills per character, so the app refuses before spending rather
  // than relying on Google-side configuration.
  if (useCloud) {
    const remaining = budgetRemaining();
    if (text.length > remaining) {
      console.warn(`TTS monthly budget reached: ${readUsage().chars}/${TTS_MONTHLY_CHAR_LIMIT} chars`);
      return res.status(429).json({
        error: 'Đã dùng hết hạn mức giọng đọc tháng này.',
        remaining,
      });
    }
  }

  try {
    const wav = useCloud
      ? await synthesiseWithCloudTts(text, lang)
      : await synthesiseWithGemini(text, lang);

    if (useCloud) recordUsage(text.length);
    cacheSet(cacheKey, wav);
    sendWav(wav, false);
  } catch (err) {
    console.error('TTS request failed:', err.message, err.body || '');
    // 429 is worth distinguishing: the client says why it sounds different and
    // falls back to the device voice instead of reporting a generic failure.
    if (err.status === 429) {
      return res.status(429).json({ error: 'Hết hạn mức giọng đọc, tạm dùng giọng máy.' });
    }
    res.status(502).json({ error: 'Speech service error.' });
  }
});

// Lets the deploy check how much of the monthly allowance is gone without
// digging through logs.
app.get('/api/tts/usage', (req, res) => {
  const usage = readUsage();
  res.json({
    provider: CLOUD_TTS_API_KEY ? 'google-cloud-tts' : 'gemini',
    period: usage.period,
    charsUsed: usage.chars,
    charLimit: TTS_MONTHLY_CHAR_LIMIT,
    remaining: budgetRemaining(),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`duo_lang server running on http://${HOST}:${PORT}`);
});
