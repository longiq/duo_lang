require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
// 'loopback', not true: with true, Express trusts the leftmost X-Forwarded-For
// entry, which is the one an attacker controls -- sending your own
// "X-Forwarded-For: 1.2.3.4" would let every IP-keyed limit below be bypassed
// with one header. With 'loopback', the socket peer (nginx, on 127.0.0.1) is
// the only address trusted, so Express takes the *last* XFF entry instead --
// the one nginx itself appended via $proxy_add_x_forwarded_for
// (deploy/nginx.conf) -- and a spoofed prefix a client prepends is ignored.
app.set('trust proxy', 'loopback');
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
// Node's fetch has no default timeout: a hung upstream would otherwise pin a
// request (and, now that there's a rate limiter, a bucket slot) forever.
const UPSTREAM_TIMEOUT_MS = 15000;
// Generous headroom over a spoken sentence, not a hard product limit -- this
// exists so one request can't build an arbitrarily large translation prompt.
const TRANSLATE_MAX_CHARS = Number(process.env.TRANSLATE_MAX_CHARS || 1000);
// Cloud TTS is capped below because it costs money. This is capped because
// the Gemini free tier is a fixed number of requests a day, and a public URL
// with no auth means anyone who finds it can spend the day's worth before the
// owner wakes up. Check the model's requests-per-day on the docs page cited
// above before raising it.
const TRANSLATE_DAILY_MAX = Number(process.env.TRANSLATE_DAILY_MAX || 400);
const TRANSLATE_USAGE_FILE = process.env.TRANSLATE_USAGE_FILE || path.join(__dirname, '..', 'translate-usage.json');

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

// --- per-client rate limiting ------------------------------------------------
// A token bucket per client: two numbers, refilled lazily on access rather
// than on a timer, so an idle client costs nothing and no interval runs on a
// box with one CPU. Hand-rolled rather than express-rate-limit: this is less
// code than that package's configuration surface, and it reuses the LRU above.
//
// nginx cannot do this job instead: limit_req_zone is only legal inside an
// http{} block, and deploy/nginx.conf is a server{} block that
// deploy/bootstrap.sh deliberately never overwrites once certbot has edited
// it in place -- so a change there would not even reach the running box.
const buckets = new Map();
const BUCKET_MAX = 2000; // bounded on purpose: ~2000 entries of two numbers each

function take(key, capacity, perSec) {
  const now = Date.now();
  const bucket = lruGet(buckets, key) || { tokens: capacity, last: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / 1000) * perSec);
  bucket.last = now;
  lruSet(buckets, key, bucket, BUCKET_MAX);
  if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / perSec); // seconds to wait
  bucket.tokens -= 1;
  return 0;
}

// One bucket per IPv4 address, but per /64 for IPv6: phones and VPS providers
// hand a device a whole /64, so counting the single address would be free to
// bypass by walking the host part of it.
function clientKey(req) {
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return ip.includes(':') ? `${ip.split(':').slice(0, 4).join(':')}::` : ip;
}

// Known weaknesses, accepted rather than hidden: LRU eviction means a client
// that rotates addresses can push another client's bucket out and reset it to
// full, and per-IP limiting does nothing against a genuinely distributed
// abuser. Neither is a reason to skip this -- it stops the realistic case (one
// script, one address) -- it is the reason the daily translate budget exists
// as the actual backstop (see TRANSLATE_DAILY_MAX below).
//
// `name` rather than req.path keys the bucket: the outer /api limiter and a
// route's own limiter both run for the same request, and if both used
// req.path they would silently share one bucket and fight over its capacity
// (each take() call would re-cap the other's token count to its own, smaller,
// capacity). A name makes each limiter's bucket independent regardless of
// what else is mounted on the same path.
function limit(name, capacity, perSec) {
  return (req, res, next) => {
    const wait = take(`${name}|${clientKey(req)}`, capacity, perSec);
    if (!wait) return next();
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: 'Bạn thao tác hơi nhanh, chờ một chút nhé.' });
  };
}

// The outer limit means a flood of already-rejected requests still costs the
// attacker something; the per-route limits below are the ones that matter day
// to day. Numbers are chosen against real use: one /api/translate call per
// spoken sentence, and the client already suppresses repeats of the same text
// (app.js translationCache), so a fast real conversation sits well under the
// sustained rate with a burst of capacity in hand. Static assets are left
// unlimited -- they cost CPU but no quota, and limiting them risks breaking a
// PWA cold start that fetches several files at once.
app.use('/api', limit('api', 60, 1));

// --- daily translate budget --------------------------------------------------
// Gemini's free-tier daily quota rolls over at midnight Pacific, not UTC --
// keying this on a UTC day would open a window where the app refuses while
// Google's own quota still has room, or the reverse. Falls back to a UTC day
// key if the runtime's ICU data is incomplete (a Node build without full-icu).
function currentDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

let translateUsage = readTranslateUsage();

function readTranslateUsage() {
  const day = currentDay();
  try {
    const saved = JSON.parse(fs.readFileSync(TRANSLATE_USAGE_FILE, 'utf8'));
    if (saved && saved.day === day && typeof saved.count === 'number') {
      return { day, count: saved.count };
    }
  } catch (err) {
    // Missing, unreadable, or a new day: start the count at zero.
  }
  return { day, count: 0 };
}

function persistTranslateUsage() {
  try {
    // Temp file + rename rather than a direct write: a crash mid-write leaves
    // the previous, complete file in place instead of truncated JSON, which
    // readTranslateUsage()'s catch would otherwise treat as "no usage yet" and
    // silently reset the day's count to zero.
    const tmp = `${TRANSLATE_USAGE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(translateUsage));
    fs.renameSync(tmp, TRANSLATE_USAGE_FILE);
  } catch (err) {
    console.error('Could not persist translate usage:', err.message);
  }
}

// Always false today -- there is no access code and none is planned unless
// abuse actually happens. This exists so that turning one on, if the public
// URL ever gets hammered, is filling in this function's body (e.g. checking
// an X-Access-Code header against process.env.ACCESS_CODE) rather than
// restructuring reserveTranslateCall()'s caller under pressure.
function isPrivileged(req) {
  return false;
}

// Checks and charges the daily cap in one synchronous step, same reasoning as
// reserveTtsTier() below: no await sits between the check and the charge, so
// two requests racing each other cannot both see room and both spend it.
function reserveTranslateCall(privileged) {
  const day = currentDay();
  if (translateUsage.day !== day) translateUsage = { day, count: 0 };
  if (privileged) return true;
  if (translateUsage.count >= TRANSLATE_DAILY_MAX) return false;
  translateUsage.count += 1;
  persistTranslateUsage();
  return true;
}

// Every target still comes back from a single call, as before -- splitting them
// into one call per language would have doubled quota use. Caching is per
// language only so that a target already translated is not asked for again:
// with both cached there is no call at all, with one cached the call asks for
// just the other.
async function translateBatch(text, source, targets, { privileged = false } = {}) {
  const translations = {};
  const missing = [];

  for (const target of targets) {
    const hit = lruGet(translateCache, `${source}|${target}|${text}`);
    if (hit) translations[target] = hit;
    else missing.push(target);
  }

  if (!missing.length) return { translations, cached: true };

  // Charged only here, never for a fully-cached request above -- otherwise
  // repeating a sentence (which the client already dedupes, but a hostile
  // caller wouldn't) would burn the daily cap for free work.
  if (!reserveTranslateCall(privileged)) {
    const err = new Error('daily translate budget exhausted');
    err.dailyLimitExceeded = true;
    throw err;
  }

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
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

// ~9/min sustained, burst of 15 in hand -- see the rate-limiting comment above.
app.post('/api/translate', limit('translate', 15, 0.15), async (req, res) => {
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
    const privileged = isPrivileged(req);
    const { translations, cached } = await translateBatch(text, source, targets, { privileged });
    res.set('X-Cache', cached ? 'hit' : 'miss');
    // Spread as well as nest so a client cached before this change, which read
    // data.en / data.ja directly, keeps working.
    res.json({ source, translations, ...translations });
  } catch (err) {
    console.error('Translate request failed:', err.message);
    if (err.dailyLimitExceeded) {
      return res.status(429).json({ error: 'Đã dùng hết lượt dịch miễn phí hôm nay, thử lại vào ngày mai.' });
    }
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
// the same sentence is replayed after a reload. Same lruGet/lruSet as the
// translate cache above -- this used to be its own byte-identical copy.
const ttsCache = new Map();
const TTS_CACHE_MAX = 40;

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

// In-memory mirror of tts-usage.json: the source of truth for the reserve/
// refund pair below. Loaded once at startup and from then on kept in sync
// with the file by a synchronous write inside reserveTtsTier()/refundTtsTier()
// themselves -- never re-read from disk on the /api/tts hot path, which used
// to block the single event loop on every request (readUsage() does a
// readFileSync + JSON.parse). /api/tts/usage still reads this same object, so
// it stays accurate without a disk read of its own.
let liveTtsUsage = readUsage();

function rollTtsUsagePeriod() {
  const period = currentPeriod();
  if (liveTtsUsage.period !== period) liveTtsUsage = { period, tiers: {} };
}

function persistTtsUsage() {
  try {
    // Temp file + rename rather than a direct write: a crash mid-write leaves
    // the previous, complete file in place instead of truncated JSON, which
    // readUsage()'s catch would otherwise treat as "no usage yet" and
    // silently reset the month's spending to zero.
    const tmp = `${TTS_USAGE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(liveTtsUsage));
    fs.renameSync(tmp, TTS_USAGE_FILE);
  } catch (err) {
    console.error('Could not persist TTS usage:', err.message);
  }
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

// Picks the first tier with room, working down from best quality, AND charges
// it in the same synchronous step -- no await sits between the check and the
// charge, so two requests racing each other cannot both see room and both
// spend it (the old pickTier()/recordUsage() pair bracketed the upstream
// fetch, leaving exactly that gap). A failed synthesis call refunds via
// refundTtsTier() below.
function reserveTtsTier(chars) {
  rollTtsUsagePeriod();
  if (TTS_MONTHLY_CHAR_LIMIT > 0 && totalUsed(liveTtsUsage) + chars > TTS_MONTHLY_CHAR_LIMIT) {
    return null;
  }
  for (const tier of TTS_TIER_ORDER) {
    if (isExhausted(tier)) continue;
    if (tierRemaining(tier, liveTtsUsage) >= chars) {
      liveTtsUsage.tiers[tier] = (liveTtsUsage.tiers[tier] || 0) + chars;
      persistTtsUsage();
      return tier;
    }
  }
  return null;
}

function refundTtsTier(tier, chars) {
  liveTtsUsage.tiers[tier] = Math.max(0, (liveTtsUsage.tiers[tier] || 0) - chars);
  persistTtsUsage();
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
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

// Two plays per translation is the common case, and replays are served from
// cache client-side (app.js audioCache), so this can be looser than translate.
app.post('/api/tts', limit('tts', 30, 0.5), async (req, res) => {
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
  const cached = lruGet(ttsCache, cacheKey);
  if (cached) return sendWav(cached, true);

  if (!useCloud) {
    try {
      const wav = await synthesiseWithGemini(text, lang);
      lruSet(ttsCache, cacheKey, wav, TTS_CACHE_MAX);
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
    const tier = reserveTtsTier(text.length);
    if (!tier) break;

    try {
      const wav = await synthesiseWithCloudTts(text, lang, tier);
      lruSet(ttsCache, cacheKey, wav, TTS_CACHE_MAX);
      return sendWav(wav, false, tier);
    } catch (err) {
      lastError = err;
      // Charged optimistically in reserveTtsTier() before this call, so any
      // failure -- Google's own quota or anything else -- gives it back.
      refundTtsTier(tier, text.length);
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

  console.warn(`TTS budget exhausted across all tiers: ${JSON.stringify(liveTtsUsage.tiers)}`);
  return res.status(429).json({
    error: 'Đã dùng hết hạn mức giọng đọc tháng này.',
    detail: lastError ? lastError.message : 'all tiers at budget',
  });
});

// Lets the deploy see where the monthly allowance stands per tier without
// digging through logs.
app.get('/api/tts/usage', (req, res) => {
  rollTtsUsagePeriod();
  const usage = liveTtsUsage;
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
