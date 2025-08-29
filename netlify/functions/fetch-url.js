// netlify/functions/fetch-url.js
const dns = require('dns').promises;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => Number.isNaN(n))) return false;
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168) ||
    o[0] === 127 ||
    (o[0] === 169 && o[1] === 254)
  );
}
function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
}
function isLocalHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '0.0.0.0' || h === '::1';
}
async function assertNotPrivateHost(hostname) {
  if (isLocalHost(hostname)) throw new Error('Blocked private host');
  try {
    const { address, family } = await dns.lookup(hostname, { verbatim: true });
    if ((family === 4 && isPrivateIPv4(address)) || (family === 6 && isPrivateIPv6(address))) {
      throw new Error('Blocked private address');
    }
  } catch (e) {
    if (e && /Blocked private/.test(String(e.message))) throw e;
  }
}
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ac.signal,
      headers: {
        'user-agent': 'AI-Web-Scraper/1.0 (+netlify)',
        'accept-language': 'en-US,en;q=0.9',
        ...(opts.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}
async function allowedByRobots(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const res = await fetchWithTimeout(robotsUrl, {}, 5000);
    if (!res.ok) return true;
    const txt = await res.text();
    let relevant = false;
    const disallow = [];
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^user-agent:\s*\*/i.test(line)) relevant = true;
      else if (/^user-agent:/i.test(line)) relevant = false;
      else if (relevant && /^disallow:/i.test(line)) {
        const p = line.split(':')[1]?.trim();
        if (p) disallow.push(p);
      }
    }
    if (disallow.length === 0) return true;
    const path = new URL(targetUrl).pathname;
    return !disallow.some(d => d && path.startsWith(d));
  } catch {
    return true;
  }
}
function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(bodyObj)
  };
}

exports.handler = async (event) => {
  try {
    const url = event.queryStringParameters?.url;
    if (!url) return json(400, { error: 'URL parameter is required.' });

    const u = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return json(400, { error: 'Invalid URL protocol.' });

    await assertNotPrivateHost(u.hostname);

    const allowed = await allowedByRobots(url);
    if (!allowed) return json(403, { error: 'Blocked by robots.txt' });

    const r = await fetchWithTimeout(url);
    if (!r.ok) return json(r.status, { error: `Upstream HTTP ${r.status}` });

    const html = await r.text();
    return json(200, { html });
  } catch (error) {
    console.error('Fetch Error:', error);
    return json(500, { error: String(error.message || error) });
  }
};
