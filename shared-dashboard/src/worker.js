// Shared THBT Price Deviation Dashboard: Cloudflare Worker
//
// Serves the dashboard page (public/index.html) and a single JSON endpoint, /api/rates, that
// compares each THBT pool's live Uniswap v4 price with the latest Bank Rate (Bank of Thailand
// daily average mid rate).
//
// The Graph API key and the BOT API token live here as Worker secrets, so viewers never need
// (or see) them. Every request is checked by the Worker itself, using one of two sign-in modes:
//   - "link":   each viewer gets a personal link (…/?k=TOKEN). Links are listed in the
//               VIEWER_LINKS secret and can be turned off one at a time.
//   - "access": Cloudflare Access in front of the Worker (e.g. an emailed one-time code); the
//               Worker verifies the Access token on every request.
// Until a mode is configured, the Worker refuses every request.
//
// Results are cached (pool prices for 3 minutes, Bank Rates for 3 hours) and shared by every
// viewer, so API usage stays the same however many people have the page open.
//
// Configuration (see shared-dashboard/README.md):
//   Secrets:  GRAPH_API_KEY, BOT_API_TOKEN, VIEWER_LINKS (link mode)
//   Vars:     AUTH_MODE           "link" or "access"
//             ACCESS_TEAM_DOMAIN  (access mode) e.g. "yourteam.cloudflareaccess.com"
//             ACCESS_AUD          (access mode) the Access application's Audience (AUD) tag
//             ALLOWED_EMAIL_DOMAIN (access mode, optional) e.g. "yourcompany.com"
//   KV:       RATES_CACHE (optional but recommended), shares the cache across Cloudflare locations

import { handleHistory, runScheduled, sendAlert, alertChannels, formatIct } from './history.js';
import { runDeviationCheck } from './deviation-alerts.js';

// Must match the deviation-check cron in wrangler.toml.
const DEVIATION_CHECK_CRON = '*/15 * * * *';

const SUBGRAPH_ID = 'Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj';
const BOT_ENDPOINT = 'https://gateway.api.bot.or.th/Stat-ExchangeRate/v2/DAILY_AVG_EXG_RATE/';

const DEVIATION_RED = 4;     // percent
const DEVIATION_YELLOW = 2;  // percent

const POOL_TTL_MS = 3 * 60 * 1000;          // pool prices: refetch at most every 3 minutes
const BOT_TTL_MS = 3 * 60 * 60 * 1000;      // BOT publishes once per business day
const BOT_LOOKBACK_DAYS = 14;               // covers long Thai public-holiday runs

// Same pools as index.html / dashboard.html. The migrated pool is current; the original pool is
// used only if the migrated one is missing from the subgraph.
const PAIRS = [
  { symbol: 'USDT', currency: 'USD', poolId: '0x0109d8915c44d44c4e80e313a97a297355d94a392f601d3475db9fc3f3a3e347', fallbackId: '0xf24771172649b8840fba253fea6d41db0fb5cfefaffac6c9035e866b9e75083e' },
  { symbol: 'USDC', currency: 'USD', poolId: '0x2170196fcf22ae7562908846a4db93d25803a9d4f580307449931df296d01d4e', fallbackId: '0xaa1f9fa78b71784ba98f633661c268116e14318ba24272fd923a172fd8adf814' },
  { symbol: 'EURC', currency: 'EUR', poolId: '0xec1379158e435022021b830b9b0c46b6cdf6bedc397ffa0bd7e18877714ddc0e', fallbackId: '0x68e22c98bb81fe3c9a34679bd2133b9808ba4486ccdcf48dcf011764aecaaa17' },
  { symbol: 'XSGD', currency: 'SGD', poolId: '0x0a4e35fbc70a9fec2bbe3bd1b0025f7989c46aef327bef7e09ae91d23359f1a3', fallbackId: '0xc1266073b10b0b3451ea052881a4be44d99c1d917db8088994babb3f0ce153f1' },
  { symbol: 'AUDD', currency: 'AUD', poolId: '0x16a3361fb09a61ae5a06979db6d3cbaf793721ac92757915018c7d66bbb24bf1', fallbackId: '0x5d0ebfd517e26be6d24e79ab244e31398ee822c190ea88eb3d517be33be8cc25' },
];
const BOT_CURRENCIES = [...new Set(PAIRS.map(p => p.currency))];

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');

    // Link mode: someone opening their personal link (…/?k=TOKEN). Swap the token for a cookie
    // and redirect to the clean URL, so the token doesn't stay in the address bar.
    if (authMode(env) === 'link' && url.searchParams.has(LINK_PARAM)) {
      return redeemLink(request, env, url);
    }

    const auth = await authenticate(request, env);
    if (!auth.ok) {
      if (isApi) return json({ error: auth.error, authMode: authMode(env) }, auth.status);
      return htmlMessage(auth.status, auth.title || 'Access denied', auth.error);
    }

    if (url.pathname === '/api/history') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      try {
        const result = await handleHistory(env, ctx, historyContext(env, ctx), url);
        const body = result.status === 200 ? { ...result.body, viewer: auth.email, authMode: authMode(env) } : result.body;
        return json(body, result.status);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    if (url.pathname === '/api/alert') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      // Only from this dashboard's own pages (the link cookie is SameSite=Lax, this is a second check).
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'Forbidden' }, 403);
      try {
        const result = await sendManualAlert(env, ctx, auth.email);
        return json({ ...result.body, viewer: auth.email, authMode: authMode(env) }, result.status);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    if (url.pathname === '/api/rates') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      try {
        const data = await getRates(env, ctx);
        return json({ ...data, viewer: auth.email, authMode: authMode(env) });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Everything else is the static page.
    const page = await env.ASSETS.fetch(request);
    const res = new Response(page.body, page);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  },

  // Cron triggers (wrangler.toml): shortly after each 6-hour mark, plus a retry.
  async scheduled(event, env, ctx) {
    if (event.cron === DEVIATION_CHECK_CRON) {
      const result = await runDeviationCheck(env, historyContext(env, ctx), event.scheduledTime);
      if (result.alerted || result.failed) console.log('deviation check', JSON.stringify(result));
      return;
    }
    const result = await runScheduled(env, historyContext(env, ctx), event.scheduledTime);
    console.log('scheduled capture', JSON.stringify(result));
  },
};

// What the history module needs from this file.
function historyContext(env, ctx) {
  return {
    pairs: PAIRS,
    subgraphId: SUBGRAPH_ID,
    deviationPct,
    classify,
    thresholds: { yellow: DEVIATION_YELLOW, red: DEVIATION_RED },
    getBotRates: () => getBotRates(env, ctx),
    getLiveRates: () => getRates(env, ctx),
    fetchBankRange: (currency, startKey, endKey) => fetchBankRange(env, currency, startKey, endKey),
  };
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

function htmlMessage(status, title, message) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1f2430;
         background: linear-gradient(160deg, #ff7a1a 0%, #f26a1b 45%, #ea5a0c 100%); }
  main { background: linear-gradient(135deg, #ffe4d2 0%, #fff1e7 45%, #fff 100%); border-radius: 18px; padding: 32px;
         max-width: 460px; box-shadow: 0 10px 30px rgba(150,60,10,.25); }
  h1 { font-size: 1.3em; margin: 0 0 10px; }
  p { margin: 0; line-height: 1.6; color: #4a5060; }
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}

// ---------------------------------------------------------------------------------------------
// Sign-in mode
//   AUTH_MODE = "link"    personal links (…/?k=TOKEN), listed in the VIEWER_LINKS secret
//   AUTH_MODE = "access"  Cloudflare Access (email one-time code, Google, etc.)
// Anything else, including unset, refuses every request.
// ---------------------------------------------------------------------------------------------
const LINK_PARAM = 'k';
const LINK_COOKIE = 'thbt_dash_key';
const LINK_COOKIE_MAX_AGE = 365 * 24 * 3600;  // the link is re-checked on every request anyway
const MIN_TOKEN_LENGTH = 24;

function authMode(env) {
  return String(env.AUTH_MODE || '').trim().toLowerCase();
}

async function authenticate(request, env) {
  // Only for `wrangler dev` on your own machine; never set this on the deployed Worker.
  if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true, email: 'local-dev' };

  const mode = authMode(env);
  if (mode === 'link') return authenticateLink(request, env);
  if (mode === 'access') return authenticateAccess(request, env);
  return {
    ok: false, status: 500, title: 'Not set up yet',
    error: 'This dashboard is not set up yet: AUTH_MODE must be "link" or "access" in wrangler.toml.',
  };
}

// VIEWER_LINKS secret: one entry per line (or comma-separated), "name:token".
// Entries with a short token are ignored, so a typo can't create a guessable link.
export function parseViewerLinks(raw) {
  const links = [];
  String(raw || '').split(/[\n,]+/).forEach(entry => {
    const i = entry.lastIndexOf(':');
    if (i < 1) return;
    const name = entry.slice(0, i).trim();
    const token = entry.slice(i + 1).trim();
    if (name && token.length >= MIN_TOKEN_LENGTH) links.push({ name, token });
  });
  return links;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares fixed-length hashes in constant time, so response timing reveals nothing about tokens.
async function findViewer(env, token) {
  if (!token) return null;
  const given = await sha256(token);
  let match = null;
  for (const link of parseViewerLinks(env.VIEWER_LINKS)) {
    const expected = await sha256(link.token);
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given[i] ^ expected[i];
    if (diff === 0 && !match) match = link.name;
  }
  return match;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const LINK_DENIED = {
  title: 'This link isn’t valid',
  error: 'Your access link is missing, mistyped or has been turned off. Ask the dashboard owner for a new link.',
};

async function authenticateLink(request, env) {
  if (!parseViewerLinks(env.VIEWER_LINKS).length) {
    return { ok: false, status: 500, title: 'Not set up yet', error: 'This dashboard is not set up yet: the VIEWER_LINKS secret has no valid links.' };
  }
  const name = await findViewer(env, readCookie(request, LINK_COOKIE));
  if (!name) return { ok: false, status: 403, ...LINK_DENIED };
  return { ok: true, email: name };
}

async function redeemLink(request, env, url) {
  const token = url.searchParams.get(LINK_PARAM);
  const name = await findViewer(env, token);
  if (!name) return htmlMessage(403, LINK_DENIED.title, LINK_DENIED.error);

  url.searchParams.delete(LINK_PARAM);
  const cookie = `${LINK_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${LINK_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, {
    status: 303,
    headers: { Location: url.pathname + url.search, 'Set-Cookie': cookie, ...SECURITY_HEADERS },
  });
}

// ---------------------------------------------------------------------------------------------
// Cloudflare Access token check
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
// ---------------------------------------------------------------------------------------------
async function authenticateAccess(request, env) {
  const teamDomain = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN);
  if (!teamDomain || !env.ACCESS_AUD) {
    return { ok: false, status: 500, error: 'This dashboard is not set up yet: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be configured on the Worker.' };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { ok: false, status: 403, error: 'Access denied: sign in through Cloudflare Access to view this dashboard.' };

  let payload;
  try {
    payload = await verifyAccessJwt(token, teamDomain, env.ACCESS_AUD);
  } catch (err) {
    return { ok: false, status: 403, error: `Access denied: ${err.message}` };
  }

  const email = String(payload.email || '');
  const domain = String(env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');
  if (domain && !email.toLowerCase().endsWith('@' + domain)) {
    return { ok: false, status: 403, error: 'Access denied: this dashboard is limited to company accounts.' };
  }
  return { ok: true, email };
}

function normaliseTeamDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

let certCache = { teamDomain: null, keys: [], fetchedAt: 0 };

async function accessKeys(teamDomain, forceRefresh) {
  const fresh = certCache.teamDomain === teamDomain && Date.now() - certCache.fetchedAt < 60 * 60 * 1000;
  if (fresh && !forceRefresh) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`could not load Access signing keys (HTTP ${res.status})`);
  const body = await res.json();
  certCache = { teamDomain, keys: body.keys || [], fetchedAt: Date.now() };
  return certCache.keys;
}

function base64UrlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function verifyAccessJwt(token, teamDomain, expectedAud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  let keys = await accessKeys(teamDomain, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    // Access rotates its keys; refetch once before giving up.
    keys = await accessKeys(teamDomain, true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expectedAud)) throw new Error('token is for a different application');
  if (payload.iss !== `https://${teamDomain}`) throw new Error('token issuer mismatch');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('session expired, reload the page to sign in again');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('token not yet valid');
  return payload;
}

// ---------------------------------------------------------------------------------------------
// Shared cache: in-memory per Worker instance, plus KV (if bound) so every location shares it
// ---------------------------------------------------------------------------------------------
const memoryCache = new Map();
const inFlight = new Map();

async function cacheGet(env, key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  if (!env.RATES_CACHE) return null;
  try {
    const value = await env.RATES_CACHE.get(key, 'json');
    if (value) memoryCache.set(key, value);
    return value;
  } catch (e) {
    return null;
  }
}

function cachePut(env, ctx, key, value, ttlSeconds) {
  memoryCache.set(key, value);
  if (!env.RATES_CACHE) return;
  const write = env.RATES_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(write); else return write;
}

// Fetches fresh data at most once at a time per Worker instance.
function once(key, fn) {
  if (!inFlight.has(key)) inFlight.set(key, fn().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

// ---------------------------------------------------------------------------------------------
// Upstream data
// ---------------------------------------------------------------------------------------------
async function fetchPools(env) {
  if (!env.GRAPH_API_KEY) throw new Error('GRAPH_API_KEY secret is not set on the Worker');
  const ids = PAIRS.flatMap(p => [p.poolId, p.fallbackId]);
  const swapQueries = ids.map((id, i) =>
    `s${i}: swaps(first: 1, orderBy: timestamp, orderDirection: desc, where: { pool: "${id}" }) { timestamp }`).join('\n');
  const query = `{
    pools(where: { id_in: ${JSON.stringify(ids)} }) {
      id
      token0Price
      token1Price
      token0 { symbol }
      token1 { symbol }
    }
    ${swapQueries}
  }`;

  const res = await fetch(`https://gateway.thegraph.com/api/${env.GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`The Graph returned HTTP ${res.status}`);
  const result = await res.json();
  if (result.errors) throw new Error(`The Graph: ${result.errors[0].message}`);

  const pools = {};
  (result.data.pools || []).forEach(p => {
    pools[p.id.toLowerCase()] = {
      token0Price: p.token0Price,
      token1Price: p.token1Price,
      token0Symbol: p.token0 && p.token0.symbol,
      token1Symbol: p.token1 && p.token1.symbol,
    };
  });
  const lastSwap = {};
  ids.forEach((id, i) => {
    const row = result.data[`s${i}`];
    lastSwap[id.toLowerCase()] = row && row[0] ? parseInt(row[0].timestamp, 10) : null;
  });
  return { pools, lastSwap, fetchedAt: Date.now() };
}

function bangkokDateKey(date) {
  return new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

async function fetchBotCurrency(env, currency, startKey, endKey) {
  const url = `${BOT_ENDPOINT}?start_period=${startKey}&end_period=${endKey}&currency=${currency}`;
  // Token is sent verbatim (no "Bearer " prefix), same as index.html.
  const res = await fetch(url, { headers: { Accept: '*/*', Authorization: env.BOT_API_TOKEN } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error(`non-JSON response (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body?.result?.data?.data_detail || body?.data?.data_detail || body?.data_detail || (Array.isArray(body) ? body : []);
}

// All published Bank Rates for one currency between two dates: [{ date, rate }], oldest first.
async function fetchBankRange(env, currency, startKey, endKey) {
  if (!env.BOT_API_TOKEN) throw new Error('the Bank Rate API token secret is not set on the Worker');
  const records = await fetchBotCurrency(env, currency, startKey, endKey);
  const out = [];
  records.forEach(rec => {
    const dateRaw = rec.period || rec.date || rec.period_date || rec.day;
    const rate = parseFloat(rec.mid_rate ?? rec.average_rate ?? rec.rate ?? rec.mid ?? rec.value);
    if (dateRaw && isFinite(rate) && rate > 0) out.push({ date: String(dateRaw).slice(0, 10), rate });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Latest published BOT mid rate per currency, from raw BOT records.
export function latestBotRates(records) {
  const latest = {};
  records.forEach(rec => {
    const dateRaw = rec.period || rec.date || rec.period_date || rec.day;
    const ccy = rec.currency_id || rec.currency || rec.ccy;
    const rate = parseFloat(rec.mid_rate ?? rec.average_rate ?? rec.rate ?? rec.mid ?? rec.value);
    if (!dateRaw || !ccy || !isFinite(rate)) return;
    const key = String(dateRaw).slice(0, 10);
    if (!latest[ccy] || key > latest[ccy].date) latest[ccy] = { rate, date: key };
  });
  return latest;
}

async function fetchBotRates(env) {
  if (!env.BOT_API_TOKEN) throw new Error('the Bank Rate API token secret is not set on the Worker');
  const now = new Date();
  const endKey = bangkokDateKey(now);
  const startKey = bangkokDateKey(new Date(now.getTime() - BOT_LOOKBACK_DAYS * 86400000));
  const results = await Promise.allSettled(BOT_CURRENCIES.map(c => fetchBotCurrency(env, c, startKey, endKey)));
  const records = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') records.push(...r.value);
    else failed.push(`${BOT_CURRENCIES[i]} (${r.reason.message})`);
  });
  if (failed.length === BOT_CURRENCIES.length) throw new Error(failed.join('; '));
  return { rates: latestBotRates(records), failed, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Calculation (same rules as dashboard.html)
// ---------------------------------------------------------------------------------------------

// token0/token1 order is fixed by contract address. token0Price is the token1 -> token0 rate, so
// "THBT per 1 token" is token0Price when THBT is token0 and token1Price when THBT is token1.
export function thbtPerToken(pool) {
  const isToken0Thbt = String(pool.token0Symbol || '').toUpperCase() === 'THBT';
  return parseFloat(isToken0Thbt ? pool.token0Price : pool.token1Price);
}

export function deviationPct(poolRate, bankRate) {
  if (!isFinite(poolRate) || !isFinite(bankRate) || bankRate <= 0 || poolRate <= 0) return null;
  return (poolRate - bankRate) / bankRate * 100;
}

export function classify(dev) {
  if (dev === null || dev === undefined) return 'none';
  const abs = Math.abs(dev);
  if (abs > DEVIATION_RED) return 'crit';
  if (abs > DEVIATION_YELLOW) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------------------------
// "Send to Google Chat" button: posts the prices as of right now. Nothing is stored.
// ---------------------------------------------------------------------------------------------
const MANUAL_ALERT_COOLDOWN_MS = 60 * 1000;
const COOLDOWN_KEY = 'manual-alert-last-sent';
let lastManualAlertAt = 0;

async function sendManualAlert(env, ctx, viewer) {
  const channels = alertChannels(env);
  if (!channels.length) {
    return { status: 503, body: { error: 'Alerts aren’t set up yet: add GOOGLE_CHAT_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to the Worker.' } };
  }
  // One alert a minute across everyone, so a double-click or two people at once don't spam the channels.
  let last = lastManualAlertAt;
  if (env.RATES_CACHE) {
    try { last = Math.max(last, Number(await env.RATES_CACHE.get(COOLDOWN_KEY)) || 0); } catch (e) { /* best effort */ }
  }
  const wait = last + MANUAL_ALERT_COOLDOWN_MS - Date.now();
  if (wait > 0) {
    const retryAfter = Math.ceil(wait / 1000);
    return { status: 429, body: { error: `An alert was just sent. You can send another in ${retryAfter} s.`, retryAfter } };
  }
  lastManualAlertAt = Date.now();
  if (env.RATES_CACHE) {
    try { await env.RATES_CACHE.put(COOLDOWN_KEY, String(lastManualAlertAt), { expirationTtl: 120 }); } catch (e) { /* best effort */ }
  }
  const releaseCooldown = async () => {
    lastManualAlertAt = 0;
    if (env.RATES_CACHE) { try { await env.RATES_CACHE.delete(COOLDOWN_KEY); } catch (e) { /* ignore */ } }
  };

  let data;
  try {
    data = await getRates(env, ctx, { fresh: true });
  } catch (err) {
    await releaseCooldown();
    throw err;
  }
  const sentAt = Date.now();
  const items = data.rows.map(r => ({ symbol: r.symbol, price: r.poolRate, bankRate: r.bankRate, deviation: r.deviation }));
  const who = viewer ? ` by ${viewer}` : '';
  const result = await sendAlert(env, `THBT prices: sent from the dashboard${who} at ${formatIct(sentAt)}`, items, '', 'Open the dashboard');
  if (!result.sent.length) {
    await releaseCooldown();
    return { status: 502, body: { error: result.failed.map(f => `${f.channel}: ${f.error}`).join('; '), failed: result.failed } };
  }
  return { status: 200, body: { ...data, sentAt, sent: result.sent, failed: result.failed } };
}

// The Bank Rate is published once per business day, around 18:00 Bangkok time (11:00 UTC).
const BANK_PUBLISH_UTC_HOUR = 11;
const BANK_RETRY_MS = 5 * 60 * 1000;          // after 18:00 on weekdays, re-check this often...
const BANK_RETRY_WINDOW_MS = 3 * 3600 * 1000; // ...until 21:00, or until today's rate shows up

// Whether the cached Bank Rates need fetching again.
export function bankCacheStale(bot, now) {
  if (!bot) return true;
  const age = now - bot.fetchedAt;
  if (age > BOT_TTL_MS) return true;
  const today = bangkokDateKey(new Date(now));
  const publishedAt = Date.parse(`${today}T00:00:00Z`) + BANK_PUBLISH_UTC_HOUR * 3600 * 1000;
  if (now < publishedAt) return false;
  if (bot.fetchedAt < publishedAt) return true;                 // fetched before this evening's rate
  const ictDay = new Date(now + 7 * 3600 * 1000).getUTCDay();
  const latest = Object.values(bot.rates || {}).map(r => r.date).sort().pop() || '';
  const weekday = ictDay >= 1 && ictDay <= 5;
  return weekday && latest < today && now - publishedAt < BANK_RETRY_WINDOW_MS && age > BANK_RETRY_MS;
}

// Latest Bank Rates, from the shared cache when it's fresh enough. Problems go into `warnings`.
async function getBotRates(env, ctx, warnings = []) {
  let bot = await cacheGet(env, 'bot');
  if (bankCacheStale(bot, Date.now())) {
    try {
      const fresh = await once('bot', () => fetchBotRates(env));
      // Keep previously cached rates for any currency that failed this time.
      bot = { rates: { ...(bot ? bot.rates : {}), ...fresh.rates }, fetchedAt: fresh.fetchedAt };
      cachePut(env, ctx, 'bot', bot, 7 * 24 * 3600);
      if (fresh.failed.length) warnings.push(`Bank Rate lookup failed for ${fresh.failed.join('; ')}. Showing the last known rate where available.`);
    } catch (err) {
      warnings.push(`Bank Rate lookup failed (${err.message}). Showing the last known rates where available.`);
    }
  }
  return bot;
}

// `fresh: true` fetches pool prices now instead of using the shared 3-minute cache.
async function getRates(env, ctx, { fresh = false } = {}) {
  const warnings = [];
  const now = Date.now();

  // Pool prices
  let pools = await cacheGet(env, 'pools');
  if (fresh || !pools || now - pools.fetchedAt > POOL_TTL_MS) {
    try {
      pools = await once('pools', () => fetchPools(env));
      cachePut(env, ctx, 'pools', pools, 24 * 3600);
    } catch (err) {
      if (!pools) throw new Error(`Couldn't load pool prices: ${err.message}`);
      warnings.push(`Couldn't refresh pool prices (${err.message}). Showing prices from ${new Date(pools.fetchedAt).toISOString()}.`);
    }
  }

  // BOT rates
  const bot = await getBotRates(env, ctx, warnings);

  const rows = PAIRS.map(p => {
    const id = pools.pools[p.poolId] ? p.poolId : p.fallbackId;
    const pool = pools.pools[id];
    const poolRate = pool ? thbtPerToken(pool) : null;
    const b = bot && bot.rates[p.currency];
    const dev = deviationPct(poolRate, b ? b.rate : NaN);
    if (!pool) warnings.push(`No pool data returned for THBT / ${p.symbol}.`);
    return {
      symbol: p.symbol,
      currency: p.currency,
      poolId: id,
      poolRate: isFinite(poolRate) ? poolRate : null,
      bankRate: b ? b.rate : null,
      bankDate: b ? b.date : null,
      deviation: dev,
      state: classify(dev),
      lastSwap: pools.lastSwap[id] || null,
    };
  });

  return {
    rows,
    warnings,
    thresholds: { yellow: DEVIATION_YELLOW, red: DEVIATION_RED },
    poolsFetchedAt: pools.fetchedAt,
    bankFetchedAt: bot ? bot.fetchedAt : null,
    servedAt: now,
  };
}
