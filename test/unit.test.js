// Unit-level coverage for the byte-plumbing and cache helpers in
// server/index.js, exercised directly (no subprocess, no stub HTTP server)
// since server/index.js now exports them for exactly this.
//
// Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish } = require('./helpers');

// TTS_USAGE_FILE is read once at module load, so it has to be set before the
// require() below picks it up.
const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duolang-unit-')), 'usage.json');
process.env.TTS_USAGE_FILE = usageFile;

const { pcmToWav, parseAudioMime, lruGet, lruSet, currentPeriod, readUsage } = require('../server/index.js');

function pcmToWavChecks() {
  console.log('\n# pcmToWav wraps raw PCM in a correct RIFF/WAVE header');
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // four 16-bit samples
  const wav = pcmToWav(pcm, 24000, 1);

  check('RIFF magic at byte 0', wav.toString('ascii', 0, 4) === 'RIFF', wav.toString('ascii', 0, 4));
  check('WAVE magic at byte 8', wav.toString('ascii', 8, 12) === 'WAVE', wav.toString('ascii', 8, 12));
  check('fmt chunk marker', wav.toString('ascii', 12, 16) === 'fmt ');
  check('data chunk marker at byte 36', wav.toString('ascii', 36, 40) === 'data');
  check('RIFF size field is 36 + pcm length', wav.readUInt32LE(4) === 36 + pcm.length,
        `got ${wav.readUInt32LE(4)}, want ${36 + pcm.length}`);
  check('data size field is pcm length', wav.readUInt32LE(40) === pcm.length,
        `got ${wav.readUInt32LE(40)}, want ${pcm.length}`);
  check('byte rate is sampleRate * blockAlign', wav.readUInt32LE(28) === 24000 * 2,
        `got ${wav.readUInt32LE(28)}`);
  check('total length is header plus pcm', wav.length === 44 + pcm.length, `got ${wav.length}`);

  const stereo = pcmToWav(pcm, 16000, 2);
  check('stereo block align doubles', stereo.readUInt16LE(32) === 4, `got ${stereo.readUInt16LE(32)}`);
}

function parseAudioMimeChecks() {
  console.log('\n# parseAudioMime reads both real-world shapes the API returns');
  const a = parseAudioMime('audio/L16;codec=pcm;rate=24000');
  check('semicolon-packed shape: rate', a.sampleRate === 24000, JSON.stringify(a));
  check('semicolon-packed shape: default channels', a.channels === 1, JSON.stringify(a));

  const b = parseAudioMime('audio/l16; rate=16000; channels=2');
  check('spaced shape: rate', b.sampleRate === 16000, JSON.stringify(b));
  check('spaced shape: channels', b.channels === 2, JSON.stringify(b));

  const c = parseAudioMime(undefined);
  check('undefined mime falls back to 24000/1', c.sampleRate === 24000 && c.channels === 1, JSON.stringify(c));
}

function lruChecks() {
  console.log('\n# lruSet/lruGet evict the least recently used entry');
  const cache = new Map();
  const max = 3;
  ['a', 'b', 'c', 'd', 'e'].forEach((k, i) => lruSet(cache, k, i, max));
  check('cache never exceeds max', cache.size === max, `size: ${cache.size}`);
  check('the two oldest were evicted', !cache.has('a') && !cache.has('b'),
        `keys: ${[...cache.keys()]}`);
  check('the three most recent survive', cache.has('c') && cache.has('d') && cache.has('e'),
        `keys: ${[...cache.keys()]}`);

  // Touch the current oldest survivor ('c') to mark it recent, then push one
  // more entry in. If lruGet's reinsert-to-mark-recent (index.js) did nothing,
  // 'c' would still be oldest and would be evicted here instead of 'd'.
  lruGet(cache, 'c');
  lruSet(cache, 'f', 99, max);
  check('touched entry survives a later eviction', cache.has('c'), `keys: ${[...cache.keys()]}`);
  check('the next-oldest was evicted instead', !cache.has('d'), `keys: ${[...cache.keys()]}`);
  check('untouched recent entries still present', cache.has('e') && cache.has('f'),
        `keys: ${[...cache.keys()]}`);

  check('missing key returns null', lruGet(cache, 'nope') === null);
}

function monthRolloverChecks() {
  console.log('\n# readUsage() resets on a new month rather than trusting a stale file');
  fs.writeFileSync(usageFile, JSON.stringify({ period: '2000-01', tiers: { Standard: 999999 } }));
  const usage = readUsage();
  check('period is the current one, not the stale one', usage.period === currentPeriod(),
        `got ${usage.period}, want ${currentPeriod()}`);
  check('tiers reset to empty on rollover', Object.keys(usage.tiers).length === 0,
        JSON.stringify(usage.tiers));

  // Same period: the saved usage must be trusted, not discarded.
  fs.writeFileSync(usageFile, JSON.stringify({ period: currentPeriod(), tiers: { Standard: 42 } }));
  const kept = readUsage();
  check('usage from the current period is kept', kept.tiers.Standard === 42, JSON.stringify(kept.tiers));

  // Missing file: same as a fresh install, not a crash.
  fs.rmSync(usageFile, { force: true });
  const missing = readUsage();
  check('a missing usage file starts at zero, not a throw', Object.keys(missing.tiers).length === 0);
}

pcmToWavChecks();
parseAudioMimeChecks();
lruChecks();
monthRolloverChecks();
finish();
