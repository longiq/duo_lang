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

app.listen(PORT, HOST, () => {
  console.log(`duo_lang server running on http://${HOST}:${PORT}`);
});
