require('dotenv').config();
const express = require('express');
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

app.post('/api/tts', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  const lang = (req.body && req.body.lang || '').trim().toLowerCase();

  if (!text) {
    return res.status(400).json({ error: 'Missing "text" field.' });
  }
  if (text.length > TTS_MAX_CHARS) {
    return res.status(413).json({ error: `Text longer than ${TTS_MAX_CHARS} characters.` });
  }
  const voice = TTS_VOICES[lang];
  if (!voice) {
    return res.status(400).json({ error: `Unsupported lang "${lang}". Use one of: ${Object.keys(TTS_VOICES).join(', ')}.` });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
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

  const cached = cacheGet(cacheKey);
  if (cached) return sendWav(cached, true);

  try {
    // Without an explicit instruction the model treats a greeting or a question
    // as something to answer and returns text, failing with "Model tried to
    // generate text". Phrasing it as a spoken instruction is the documented way
    // to drive these models, and the prefix itself is not read aloud.
    const prompt = `Read this text aloud exactly as written, in a natural voice: ${text}`;

    let geminiRes = null;
    let lastStatus = 0;
    let lastBody = '';

    // Each model has its own daily allowance, so a 429 moves to the next one.
    for (const model of GEMINI_TTS_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const attempt = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        }),
      });

      if (attempt.ok) {
        geminiRes = attempt;
        break;
      }

      lastStatus = attempt.status;
      lastBody = await attempt.text();
      console.error(`Gemini TTS error (${model}):`, lastStatus, lastBody.slice(0, 400));
      if (lastStatus !== 429) break; // only quota is worth retrying elsewhere
    }

    if (!geminiRes) {
      // 429 is worth distinguishing: the client can say "quota exhausted"
      // rather than a generic failure, and fall back to the device voice.
      const status = lastStatus === 429 ? 429 : 502;
      return res.status(status).json({
        error: lastStatus === 429
          ? 'Daily speech quota exhausted.'
          : 'Speech service error.',
      });
    }

    const data = await geminiRes.json();
    const inline = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!inline || !inline.data) {
      return res.status(502).json({ error: 'No audio returned.' });
    }

    const { sampleRate, channels } = parseAudioMime(inline.mimeType);
    const wav = pcmToWav(Buffer.from(inline.data, 'base64'), sampleRate, channels);

    cacheSet(cacheKey, wav);
    sendWav(wav, false);
  } catch (err) {
    console.error('TTS request failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`duo_lang server running on http://${HOST}:${PORT}`);
});
