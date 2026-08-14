// Exercises the token-bucket rate limiter, in particular the trust-proxy /
// X-Forwarded-For handling: get that wrong and either every client shares one
// bucket (the app looks broken for everyone at once) or the limit is
// bypassable by sending a fake XFF header.
//
// Run with: npm test
const { check, finish, startServer, waitForServer } = require('./helpers');

const PORT = 3291;
const BASE = `http://127.0.0.1:${PORT}`;

// A trivial stand-in for generativelanguage.googleapis.com that always answers
// a valid translation, so a request that gets past the limiter reads as a
// clean 200 in these logs rather than a 502 that has to be explained away.
function startFakeGemini() {
  const http = require('http');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"en":"hello"}' }] } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function bootServer(extraEnv = {}) {
  const fake = await startFakeGemini();
  const child = startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GEMINI_API_KEY: 'fake-key',
    GEMINI_ENDPOINT_BASE: `http://127.0.0.1:${fake.port}/v1beta/models`,
    ...extraEnv,
  });
  return { child, fake };
}

const translateAs = (xff) => fetch(`${BASE}/api/translate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(xff ? { 'X-Forwarded-For': xff } : {}),
  },
  body: JSON.stringify({ text: 'xin chào', source: 'vi', targets: ['en'] }),
});

async function burstThenRefill() {
  console.log('\n# a burst past capacity is refused, then recovers as tokens refill');
  const { child, fake } = await bootServer();
  await waitForServer(`${BASE}/`);

  try {
    // The real capacity is 15 (server/index.js); burst past it from one IP.
    const results = [];
    for (let i = 0; i < 17; i++) {
      results.push((await translateAs('9.1.1.1')).status);
    }
    const okCount = results.filter((s) => s === 200).length;
    check('capacity is enforced (not all 17 succeed)', okCount <= 15, `ok: ${okCount}, results: ${results.join(',')}`);
    check('the burst tail is refused', results[16] === 429, `last status: ${results[16]}`);

    const refused = await translateAs('9.1.1.1');
    check('refusal carries Retry-After', refused.headers.has('retry-after'), [...refused.headers.keys()].join(','));
    const refusedBody = await refused.json();
    check('refusal message is Vietnamese', /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(refusedBody.error || ''),
          refusedBody.error);

    // A different IP is a different bucket -- must succeed immediately.
    const otherIp = await translateAs('9.1.1.2');
    check('a different client is unaffected', otherIp.status === 200, `status: ${otherIp.status}`);

    // The translate route refills at 0.15 tokens/sec, so ~6.7s regains one
    // token. This is the one deliberately slow check in the suite -- it is
    // the only way to prove refill actually happens rather than just capping.
    await new Promise((r) => setTimeout(r, 7500));
    const afterWait = await translateAs('9.1.1.1');
    check('one refill interval later, the exhausted client succeeds again', afterWait.status === 200,
          `status: ${afterWait.status}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function xffSpoofingIsIgnored() {
  console.log('\n# trust proxy "loopback" takes the last XFF hop (nginx\'s), not the first (the client\'s)');
  const { child, fake } = await bootServer();
  await waitForServer(`${BASE}/`);

  try {
    // Two distinct single-hop XFF values must land in two distinct buckets.
    const a = await translateAs('1.2.3.4');
    const b = await translateAs('5.6.7.8');
    check('distinct single-hop XFF values get distinct buckets', a.status === 200 && b.status === 200,
          `a: ${a.status}, b: ${b.status}`);

    // Now exhaust 1.2.3.4's bucket with plain requests.
    for (let i = 0; i < 15; i++) await translateAs('1.2.3.4');
    const exhausted = await translateAs('1.2.3.4');
    check('1.2.3.4 is now exhausted', exhausted.status === 429, `status: ${exhausted.status}`);

    // This is what nginx actually sends when a client tries to spoof its own
    // XFF: "<attacker's fake value>, <nginx's real peer>". With trust proxy
    // set to 'loopback', Express must take the LAST entry (1.2.3.4, the real
    // peer nginx appended) and ignore the attacker-controlled prefix -- so
    // this must be refused too, not treated as a fresh, unrelated client.
    const spoofed = await translateAs('9.9.9.9, 1.2.3.4');
    check('a forged leading hop does not bypass the real peer\'s limit', spoofed.status === 429,
          `status: ${spoofed.status}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function ipv6SlashSixtyFour() {
  console.log('\n# IPv6 clients are bucketed by /64, not by full address');
  const { child, fake } = await bootServer();
  await waitForServer(`${BASE}/`);

  try {
    // Exhaust one address in a /64.
    for (let i = 0; i < 15; i++) await translateAs('2001:db8:1234:5678::1');
    const sameBlockDifferentHost = await translateAs('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    check('a different host in the same /64 shares the bucket', sameBlockDifferentHost.status === 429,
          `status: ${sameBlockDifferentHost.status}`);

    const differentBlock = await translateAs('2001:db8:1234:9999::1');
    check('a different /64 is a fresh bucket', differentBlock.status === 200, `status: ${differentBlock.status}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function oversizedAndMalformedBodies() {
  console.log('\n# the Phase 1 body guards still answer JSON when the limiter is in front of them');
  const { child, fake } = await bootServer();
  await waitForServer(`${BASE}/`);

  try {
    const big = await fetch(`${BASE}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '3.3.3.3' },
      body: JSON.stringify({ text: 'a'.repeat(9000) }),
    });
    check('oversized body is 413', big.status === 413, `status: ${big.status}`);
    check('oversized body response is JSON', (big.headers.get('content-type') || '').includes('application/json'),
          big.headers.get('content-type'));

    const malformed = await fetch(`${BASE}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '3.3.3.4' },
      body: '{not valid json',
    });
    check('malformed body is 400', malformed.status === 400, `status: ${malformed.status}`);
    check('malformed body response is JSON', (malformed.headers.get('content-type') || '').includes('application/json'),
          malformed.headers.get('content-type'));
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  await burstThenRefill();
  await xffSpoofingIsIgnored();
  await ipv6SlashSixtyFour();
  await oversizedAndMalformedBodies();

  finish();
}

main().catch((err) => { console.error(err); process.exit(1); });
