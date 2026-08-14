// Exercises the /api/translate error branches translate.test.js doesn't touch:
// its stub always answers a clean 200 with valid JSON, so none of the
// malformed-response throws in translateBatch(), nor the validation 400s,
// nor the upstream-failure mapping, are covered anywhere else.
//
// Run with: npm test
const { check, finish, startServer, waitForServer } = require('./helpers');

const PORT = 3290;
const BASE = `http://127.0.0.1:${PORT}`;
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

// A local stand-in for generativelanguage.googleapis.com's translate endpoint.
// `queue` is consumed one item per request, so each test scripts exactly what
// the "model" answers.
function startFakeGemini(queue) {
  const http = require('http');
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      req.on('data', () => {});
      req.on('end', () => {
        const item = queue.shift() || { status: 200, json: {} };
        if (item.status !== 200) {
          res.writeHead(item.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: item.status, message: 'stub error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item.body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function bootServer(fake, extraEnv = {}) {
  return startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GEMINI_API_KEY: 'fake-key',
    GEMINI_ENDPOINT_BASE: `http://127.0.0.1:${fake.port}/v1beta/models`,
    ...extraEnv,
  });
}

const translate = (body) => fetch(`${BASE}/api/translate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function validationChecks() {
  console.log('\n# validation rejects bad input before ever calling upstream');
  const fake = await startFakeGemini([]);
  const child = bootServer(fake);
  await waitForServer(`${BASE}/`);

  try {
    const noText = await translate({});
    check('missing text is 400', noText.status === 400, `status: ${noText.status}`);

    const tooLong = await translate({ text: 'a'.repeat(1001) });
    check('over the length cap is 413', tooLong.status === 413, `status: ${tooLong.status}`);

    const badSource = await translate({ text: 'hi', source: 'de' });
    check('unsupported source is 400', badSource.status === 400, `status: ${badSource.status}`);

    const badTarget = await translate({ text: 'hi', source: 'vi', targets: ['de'] });
    check('unsupported target is 400', badTarget.status === 400, `status: ${badTarget.status}`);

    const sourceIsTarget = await translate({ text: 'hi', source: 'vi', targets: ['vi', 'en'] });
    check('source among targets is 400', sourceIsTarget.status === 400, `status: ${sourceIsTarget.status}`);

    for (const res of [noText, tooLong, badSource, badTarget, sourceIsTarget]) {
      const body = await res.json();
      check(`error is Vietnamese (${res.status})`, VIETNAMESE.test(body.error || ''), body.error);
    }

    check('none of these reached the upstream stub', fake.requests.length === 0, `requests: ${fake.requests.length}`);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function noApiKeyIs500() {
  console.log('\n# a missing GEMINI_API_KEY is a clear 500');
  const fake = await startFakeGemini([]);
  const child = bootServer(fake, { GEMINI_API_KEY: '' });
  await waitForServer(`${BASE}/`);

  try {
    const res = await translate({ text: 'hi' });
    check('status is 500', res.status === 500, `status: ${res.status}`);
    const body = await res.json();
    check('error is Vietnamese', VIETNAMESE.test(body.error || ''), body.error);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function upstreamFailureMapping() {
  console.log('\n# upstream failures map to the right status and a Vietnamese message');
  const fake = await startFakeGemini([{ status: 429 }, { status: 500 }]);
  const child = bootServer(fake);
  await waitForServer(`${BASE}/`);

  try {
    const quota = await translate({ text: 'câu một', source: 'vi', targets: ['en'] });
    check('upstream 429 becomes client 429', quota.status === 429, `status: ${quota.status}`);
    const quotaBody = await quota.json();
    check('quota message mentions the rate limit', /hạn mức/i.test(quotaBody.error || ''), quotaBody.error);

    const upstream500 = await translate({ text: 'câu hai', source: 'vi', targets: ['en'] });
    check('upstream 500 becomes client 502', upstream500.status === 502, `status: ${upstream500.status}`);
    const body502 = await upstream500.json();
    check('502 error is Vietnamese', VIETNAMESE.test(body502.error || ''), body502.error);
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function malformedResponsesAre502() {
  console.log('\n# a malformed model response is a 502, not a crash');
  const fake = await startFakeGemini([
    // No candidates at all -> raw is undefined -> "empty translation response".
    { status: 200, body: { candidates: [] } },
    // Text that isn't valid JSON -> "unparseable translation response".
    { status: 200, body: { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] } },
    // Valid JSON, but missing the one target that was actually requested.
    { status: 200, body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } },
  ]);
  const child = bootServer(fake);
  await waitForServer(`${BASE}/`);

  try {
    const empty = await translate({ text: 'câu ba', source: 'vi', targets: ['en'] });
    check('no candidates -> 502', empty.status === 502, `status: ${empty.status}`);

    const unparseable = await translate({ text: 'câu bốn', source: 'vi', targets: ['en'] });
    check('unparseable JSON -> 502', unparseable.status === 502, `status: ${unparseable.status}`);

    const missingTarget = await translate({ text: 'câu năm', source: 'vi', targets: ['en'] });
    check('response missing the requested target -> 502', missingTarget.status === 502, `status: ${missingTarget.status}`);

    for (const res of [empty, unparseable, missingTarget]) {
      const body = await res.json();
      check(`error is Vietnamese (${res.status})`, VIETNAMESE.test(body.error || ''), body.error);
    }
  } finally {
    child.kill();
    fake.server.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  await validationChecks();
  await noApiKeyIs500();
  await upstreamFailureMapping();
  await malformedResponsesAre502();

  finish();
}

main().catch((err) => { console.error(err); process.exit(1); });
