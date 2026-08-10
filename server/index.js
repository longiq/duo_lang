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
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
// One voice per language so the two panes are audibly distinct. These are
// Gemini's prebuilt voices; the model infers the language from the text itself.
const TTS_VOICES = { en: 'Kore', ja: 'Aoede' };
const TTS_MAX_CHARS = 600;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/translate', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing "text" field.' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
  }

  const prompt = `You are a professional Vietnamese-English-Japanese translator.
Translate the following Vietnamese sentence into natural, fluent English and natural, fluent Japanese.
Keep the original meaning and tone. Do not add explanations.
Respond ONLY with valid JSON in this exact shape: {"en": "...", "ja": "..."}

Vietnamese sentence: "${text}"`;

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

    if (typeof parsed.en !== 'string' || typeof parsed.ja !== 'string') {
      return res.status(502).json({ error: 'Malformed translation result.' });
    }

    res.json({ en: parsed.en, ja: parsed.ja });
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini TTS error:', geminiRes.status, errBody);
      return res.status(502).json({ error: 'Speech service error.' });
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
