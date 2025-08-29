// netlify/functions/get-schema.js
// Server-side Gemini call. Keeps your FE contract, adds stricter parsing & temperature.
// No external deps: uses Node 18+ global fetch in Netlify Functions.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(bodyObj)
  };
}

exports.handler = async (event) => {
  try {
    if (!GEMINI_API_KEY) return json(500, { error: 'Server is missing GEMINI_API_KEY environment variable.' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const { mainPageHtml, mainPageB64, subPageB64, nextButtonB64 } = body;

    if (!mainPageHtml || !mainPageB64 || !subPageB64 || !nextButtonB64) {
      return json(400, { error: 'Missing inputs (mainPageHtml, mainPageB64, subPageB64, nextButtonB64).' });
    }
    const safe = (x) => (x && typeof x === 'object' ? x : { mimeType: 'image/png', data: '' });

    const prompt = `
You are an expert web scraping assistant.
Return STRICT JSON with keys:
- linkSelector (string)
- nextButtonText (string)

Main Page HTML (first 8000 chars):
${(mainPageHtml || '').slice(0, 8000)}
`.trim();

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: safe(mainPageB64).mimeType, data: safe(mainPageB64).data } },
          { inlineData: { mimeType: safe(subPageB64).mimeType, data: safe(subPageB64).data } },
          { inlineData: { mimeType: safe(nextButtonB64).mimeType, data: safe(nextButtonB64).data } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", properties: { "linkSelector": { type: "STRING" }, "nextButtonText": { type: "STRING" } } }
      }
    };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!r.ok) {
      const body = await r.text();
      return json(r.status, { error: `Gemini API ${r.status}`, body });
    }
    const data = await r.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return json(502, { error: 'No JSON candidate from model', raw: data });

    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { return json(502, { error: 'Model returned non-JSON', raw: txt }); }

    const out = {
      linkSelector: parsed.linkSelector || parsed.link_selector || '',
      nextButtonText: parsed.nextButtonText || parsed.next_button_text || ''
    };
    return json(200, out);
  } catch (e) {
    console.error('Gemini API Error:', e);
    return json(500, { error: String(e.message || e) });
  }
};
