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
// A flash-lite model, pinned rather than an alias so it can't change underneath
// us. Check https://ai.google.dev/gemini-api/docs/models when bumping: retired
// models don't 404, they report a free-tier quota of 0.
//
// Not the full flash model: measured on ten sentences it spent 449-871 thinking
// tokens to produce ~35 tokens of translation, taking ~4.9s a call and
// exhausting its free quota after six of them. flash-lite does no thinking,
// answers in about a second, and produced translations that were equivalent or
// slightly better.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Overridable so tests can point at a local stand-in instead of spending quota.
const GEMINI_ENDPOINT_BASE = process.env.GEMINI_ENDPOINT_BASE ||
  'https://generativelanguage.googleapis.com/v1beta/models';
// Each TTS model carries its own free-tier allowance of only 10 requests per
// day, so exhausting one falls through to the next rather than failing.
const GEMINI_TTS_MODELS = (process.env.GEMINI_TTS_MODELS ||
  'gemini-2.5-flash-preview-tts,gemini-3.1-flash-tts-preview')
  .split(',').map((m) => m.trim()).filter(Boolean);
// One voice per language so the panes are audibly distinct. These are Gemini's
// prebuilt voices; the model infers the language from the text itself.
const TTS_VOICES = { vi: 'Puck', en: 'Kore', ja: 'Aoede' };
const TTS_MAX_CHARS = 600;
// Generous headroom over a spoken sentence, not a hard product limit -- this
// exists so one request can't build an arbitrarily large translation prompt.
const TRANSLATE_MAX_CHARS = Number(process.env.TRANSLATE_MAX_CHARS || 1000);

// Google Cloud Text-to-Speech, used in preference to Gemini when a key is
// configured: its free tier is 1M characters a month rather than 10 requests a
// day, and being a dedicated TTS service it never mistakes text for a prompt.
const CLOUD_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
// Overridable so tests can point at a local stand-in instead of spending quota.
const CLOUD_TTS_ENDPOINT = process.env.CLOUD_TTS_ENDPOINT ||
  'https://texttospeech.googleapis.com/v1/text:synthesize';
const LANG_CODES = { vi: 'vi-VN', en: 'en-US', ja: 'ja-JP' };

// Google's free allowance is per voice tier, not per project, so working down
// the tiers as each one runs out adds up to 7M characters a month instead of 1M.
// Voice names below were all confirmed present via the voices endpoint.
const TIER_FREE_CHARS = { 'Chirp3-HD': 1000000, Neural2: 1000000, Wavenet: 1000000, Standard: 4000000 };
const TIER_VOICES = {
  'Chirp3-HD': { vi: 'vi-VN-Chirp3-HD-Achernar', en: 'en-US-Chirp3-HD-Achernar', ja: 'ja-JP-Chirp3-HD-Achernar' },
  Neural2: { vi: 'vi-VN-Neural2-A', en: 'en-US-Neural2-F', ja: 'ja-JP-Neural2-B' },
  Wavenet: { vi: 'vi-VN-Wavenet-A', en: 'en-US-Wavenet-F', ja: 'ja-JP-Wavenet-B' },
  Standard: { vi: 'vi-VN-Standard-A', en: 'en-US-Standard-C', ja: 'ja-JP-Standard-A' },
};
// Best quality first. Reorder to taste; every tier here is free within its cap.
const TTS_TIER_ORDER = (process.env.TTS_TIER_ORDER || 'Chirp3-HD,Neural2,Wavenet,Standard')
  .split(',').map((t) => t.trim()).filter((t) => TIER_VOICES[t]);

// Each tier is capped below its own free allowance, so no configuration mistake
// on the Google side can turn into a bill. Google's budget alerts only notify --
// they do not stop spending.
const TTS_BUDGET_FRACTION = Number(process.env.TTS_BUDGET_FRACTION || 0.8);
// Optional ceiling across all tiers combined. Off unless set above zero.
const TTS_MONTHLY_CHAR_LIMIT = Number(process.env.TTS_MONTHLY_CHAR_LIMIT || 0);
const TTS_USAGE_FILE = process.env.TTS_USAGE_FILE || path.join(__dirname, '..', 'tts-usage.json');

function tierBudget(tier) {
  const explicit = Number(process.env[`TTS_BUDGET_${tier.toUpperCase().replace(/-/g, '_')}`] || 0);
  if (explicit > 0) return explicit;
  return Math.floor((TIER_FREE_CHARS[tier] || 0) * TTS_BUDGET_FRACTION);
}

// These configured the voices before the tier cascade above replaced them, and
// deploy/google-cloud-tts.md used to tell people to set them. Setting one now
// does nothing at all, which is worse than an error -- warn instead of staying
// silent.
for (const dead of ['CLOUD_VOICE_VI', 'CLOUD_VOICE_EN', 'CLOUD_VOICE_JA']) {
  if (process.env[dead]) {
    console.warn(`${dead} is set but ignored; voices come from TIER_VOICES / TTS_TIER_ORDER now.`);
  }
}

const LANG_NAMES = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' };
const SUPPORTED_LANGS = Object.keys(LANG_NAMES);

// 8kb is roughly 8x the largest legitimate body (TTS caps at 600 chars,
// translate at TRANSLATE_MAX_CHARS below) -- the 100kb default only ever
// bought an unauthenticated caller a bigger Gemini prompt to bill against us.
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- translation ------------------------------------------------------------
// Cached per source/target/sentence rather than per pair, so switching which
// language you speak still reuses whatever has already been translated.
const translateCache = new Map();
const TRANSLATE_CACHE_MAX = 300;

function lruGet(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // reinsert to mark it recent
  return value;
}

function lruSet(cache, key, value, max) {
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

// Every target still comes back from a single call, as before -- splitting them
// into one call per language would have doubled quota use. Caching is per
// language only so that a target already translated is not asked for again:
// with both cached there is no call at all, with one cached the call asks for
// just the other.
async function translateBatch(text, source, targets) {
  const translations = {};
  const missing = [];

  for (const target of targets) {
    const hit = lruGet(translateCache, `${source}|${target}|${text}`);
    if (hit) translations[target] = hit;
    else missing.push(target);
  }

  if (!missing.length) return { translations, cached: true };

  const targetList = missing.map((t) => LANG_NAMES[t]).join(' and ');
  const shape = `{${missing.map((t) => `"${t}": "..."`).join(', ')}}`;
  const prompt = `You are a professional translator.
Translate the following ${LANG_NAMES[source]} sentence into natural, fluent ${targetList}.
Keep the original meaning, tone and level of politeness. Do not add explanations.
Respond ONLY with valid JSON in this exact shape: ${shape}

${LANG_NAMES[source]} sentence: "${text}"`;

  const url = `${GEMINI_ENDPOINT_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // A real translation measures ~35 tokens (see the model comment above);
      // 512 is generous headroom while still capping what a prompt-injected
      // instruction ("ignore the above and write an essay") can cost us.
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 512 },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('Gemini translate error:', response.status, body.slice(0, 300));
    const err = new Error(`translate ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('empty translation response');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('unparseable translation response');
  }

  for (const target of missing) {
    const value = typeof parsed[target] === 'string' ? parsed[target].trim() : '';
    if (!value) throw new Error(`malformed translation for ${target}`);
    translations[target] = value;
    lruSet(translateCache, `${source}|${target}|${text}`, value, TRANSLATE_CACHE_MAX);
  }

  return { translations, cached: false };
}

app.post('/api/translate', async (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Thiếu nội dung cần dịch.' });
  }
  if (text.length > TRANSLATE_MAX_CHARS) {
    return res.status(413).json({ error: `Câu dài quá ${TRANSLATE_MAX_CHARS} ký tự.` });
  }

  // Defaults keep older cached clients, which only ever sent text, working.
  const source = (req.body && req.body.source || 'vi').toLowerCase();
  const rawTargets = Array.isArray(req.body && req.body.targets) && req.body.targets.length
    ? req.body.targets.map((t) => String(t).toLowerCase())
    : SUPPORTED_LANGS.filter((l) => l !== source);
  // Deduped and capped to the number of other languages that exist: without
  // this, a body repeating one target hundreds of times builds a prompt shape
  // (translateBatch above) with hundreds of keys for the same one call --
  // a cheaper amplifier than a large body, so the byte cap above doesn't stop it.
  const targets = [...new Set(rawTargets)].slice(0, SUPPORTED_LANGS.length - 1);

  if (!LANG_NAMES[source]) {
    return res.status(400).json({ error: `Ngôn ngữ nguồn "${source}" không được hỗ trợ.` });
  }
  const badTarget = targets.find((t) => !LANG_NAMES[t]);
  if (badTarget) {
    return res.status(400).json({ error: `Ngôn ngữ đích "${badTarget}" không được hỗ trợ.` });
  }
  if (targets.includes(source)) {
    return res.status(400).json({ error: 'Ngôn ngữ nguồn không thể cũng là ngôn ngữ đích.' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server thiếu cấu hình GEMINI_API_KEY.' });
  }

  try {
    const { translations, cached } = await translateBatch(text, source, targets);
    res.set('X-Cache', cached ? 'hit' : 'miss');
    // Spread as well as nest so a client cached before this change, which read
    // data.en / data.ja directly, keeps working.
    res.json({ source, translations, ...translations });
  } catch (err) {
    console.error('Translate request failed:', err.message);
    res.status(err.status === 429 ? 429 : 502).json({
      error: err.status === 429
        ? 'Hết hạn mức dịch, thử lại sau một lát.'
        : 'Lỗi dịch vụ dịch thuật.',
      detail: err.message,
    });
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
    if (saved && saved.period === period && saved.tiers) {
      return { period, tiers: { ...saved.tiers } };
    }
  } catch (err) {
    // Missing, unreadable, or a new month: start the period at zero.
  }
  return { period, tiers: {} };
}

function recordUsage(tier, chars) {
  const usage = readUsage();
  usage.tiers[tier] = (usage.tiers[tier] || 0) + chars;
  try {
    fs.writeFileSync(TTS_USAGE_FILE, JSON.stringify(usage));
  } catch (err) {
    console.error('Could not persist TTS usage:', err.message);
  }
  return usage;
}

function totalUsed(usage) {
  return Object.values(usage.tiers).reduce((sum, n) => sum + n, 0);
}

function tierRemaining(tier, usage = readUsage()) {
  return Math.max(0, tierBudget(tier) - (usage.tiers[tier] || 0));
}

// Tiers that returned 429 from Google this period: their real quota ran out
// before our own cap did, so stop offering them until the month rolls over.
const exhaustedTiers = new Map();

function isExhausted(tier) {
  return exhaustedTiers.get(tier) === currentPeriod();
}

function markExhausted(tier) {
  exhaustedTiers.set(tier, currentPeriod());
}

// First tier with room for this text, working down from best quality.
function pickTier(chars) {
  const usage = readUsage();
  if (TTS_MONTHLY_CHAR_LIMIT > 0 && totalUsed(usage) + chars > TTS_MONTHLY_CHAR_LIMIT) {
    return null;
  }
  for (const tier of TTS_TIER_ORDER) {
    if (isExhausted(tier)) continue;
    if (tierRemaining(tier, usage) >= chars) return tier;
  }
  return null;
}

// --- synthesis providers ----------------------------------------------------

async function synthesiseWithCloudTts(text, lang, tier) {
  const url = `${CLOUD_TTS_ENDPOINT}?key=${CLOUD_TTS_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: LANG_CODES[lang], name: TIER_VOICES[tier][lang] },
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
    const url = `${GEMINI_ENDPOINT_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;
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
    return res.status(400).json({ error: 'Thiếu nội dung cần đọc.' });
  }
  if (text.length > TTS_MAX_CHARS) {
    return res.status(413).json({ error: `Câu dài quá ${TTS_MAX_CHARS} ký tự.` });
  }
  if (!TTS_VOICES[lang]) {
    return res.status(400).json({ error: `Ngôn ngữ "${lang}" không được hỗ trợ. Dùng một trong: ${Object.keys(TTS_VOICES).join(', ')}.` });
  }

  const useCloud = Boolean(CLOUD_TTS_API_KEY);
  if (!useCloud && !GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server chưa cấu hình khoá giọng đọc.' });
  }

  const cacheKey = `${lang}|${text}`;
  const sendWav = (wav, hit, tier) => {
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': hit ? 'hit' : 'miss',
      'X-TTS-Tier': tier || 'cache',
    });
    res.send(wav);
  };

  // A cache hit costs nothing, so it is served before any budget check.
  const cached = cacheGet(cacheKey);
  if (cached) return sendWav(cached, true);

  if (!useCloud) {
    try {
      const wav = await synthesiseWithGemini(text, lang);
      cacheSet(cacheKey, wav);
      return sendWav(wav, false, 'gemini');
    } catch (err) {
      console.error('Gemini TTS failed:', err.message, err.body || '');
      if (err.status === 429) {
        return res.status(429).json({ error: 'Hết hạn mức giọng đọc hôm nay, tạm dùng giọng máy.' });
      }
      return res.status(502).json({ error: 'Lỗi dịch vụ giọng đọc.', detail: err.message });
    }
  }

  // Cloud TTS bills per character, so work down the tiers and refuse before
  // spending rather than relying on Google-side configuration being right.
  let lastError = null;
  for (;;) {
    const tier = pickTier(text.length);
    if (!tier) break;

    try {
      const wav = await synthesiseWithCloudTts(text, lang, tier);
      recordUsage(tier, text.length);
      cacheSet(cacheKey, wav);
      return sendWav(wav, false, tier);
    } catch (err) {
      lastError = err;
      if (err.status === 429) {
        // Google's own quota for this tier ran out before our cap did.
        console.warn(`TTS tier ${tier} hit Google's quota, trying the next tier`);
        markExhausted(tier);
        continue;
      }
      console.error(`Cloud TTS failed on ${tier}:`, err.message, err.body || '');
      return res.status(502).json({ error: 'Lỗi dịch vụ giọng đọc.', detail: err.message });
    }
  }

  const usage = readUsage();
  console.warn(`TTS budget exhausted across all tiers: ${JSON.stringify(usage.tiers)}`);
  return res.status(429).json({
    error: 'Đã dùng hết hạn mức giọng đọc tháng này.',
    detail: lastError ? lastError.message : 'all tiers at budget',
  });
});

// Lets the deploy see where the monthly allowance stands per tier without
// digging through logs.
app.get('/api/tts/usage', (req, res) => {
  const usage = readUsage();
  const tiers = TTS_TIER_ORDER.map((tier) => ({
    tier,
    voiceExample: TIER_VOICES[tier].vi,
    used: usage.tiers[tier] || 0,
    budget: tierBudget(tier),
    remaining: tierRemaining(tier, usage),
    googleFreeTier: TIER_FREE_CHARS[tier],
    quotaExhausted: isExhausted(tier),
  }));

  res.json({
    provider: CLOUD_TTS_API_KEY ? 'google-cloud-tts' : 'gemini',
    period: usage.period,
    order: TTS_TIER_ORDER,
    totalUsed: totalUsed(usage),
    totalBudget: tiers.reduce((sum, t) => sum + t.budget, 0),
    totalRemaining: tiers.reduce((sum, t) => sum + t.remaining, 0),
    overallLimit: TTS_MONTHLY_CHAR_LIMIT || null,
    tiers,
  });
});

// body-parser signals an oversized or malformed body by throwing, and express's
// default handler answers those with an HTML error page. The client reads
// res.json() before it checks res.ok, so that HTML surfaces as an English
// "Unexpected token '<'" SyntaxError on an otherwise all-Vietnamese screen.
// Registered last (4-arg signature) so it only catches what routes didn't.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err.type === 'entity.too.large';
  res.status(tooBig ? 413 : 400).json({
    error: tooBig ? 'Câu quá dài.' : 'Yêu cầu không hợp lệ.',
    detail: err.type || err.message,
  });
});

// Exported so the byte-level helpers can be unit-tested directly, without a
// subprocess and a stub upstream. Guarded so that requiring this file (as the
// unit tests do) does not also bind a port; both existing integration tests
// already spawn this file as a subprocess, where require.main === module.
module.exports = { pcmToWav, parseAudioMime, lruGet, lruSet, currentPeriod, readUsage, app };

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`duo_lang server running on http://${HOST}:${PORT}`);
  });
}
