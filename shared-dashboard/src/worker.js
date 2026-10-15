// Shared THBT Price Deviation Dashboard: Cloudflare Worker
//
// Serves the dashboard page (public/index.html) and a single JSON endpoint, /api/rates, that
// compares each THBT pool's live Uniswap v4 price with the latest BOT daily average mid rate.
//
// The Graph API key and the BOT API token live here as Worker secrets, so viewers never need
// (or see) them. Every request must carry a valid Cloudflare Access token: the Worker checks it
// itself, so the page stays closed even if the Access application is ever misconfigured.
//
// Results are cached (pool prices for 3 minutes, BOT rates for 3 hours) and shared by every
// viewer, so API usage stays the same however many people have the page open.
//
// Configuration (see shared-dashboard/README.md):
//   Secrets:  GRAPH_API_KEY, BOT_API_TOKEN
//   Vars:     ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"
//             ACCESS_AUD          the Access application's Audience (AUD) tag
//             ALLOWED_EMAIL_DOMAIN (optional) e.g. "yourcompany.com", an extra check on top of Access
//   KV:       RATES_CACHE (optional but recommended), shares the cache across Cloudflare locations

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
    const auth = await authenticate(request, env);
    if (!auth.ok) {
      return new Response(auth.error + '\n', {
        status: auth.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/rates') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      try {
        const data = await getRates(env, ctx);
        return json({ ...data, viewer: auth.email });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Everything else is the static page.
    return env.ASSETS.fetch(request);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------------------------
// Cloudflare Access token check
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
// ---------------------------------------------------------------------------------------------
async function authenticate(request, env) {
  // Only for `wrangler dev` on your own machine; never set this on the deployed Worker.
  if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true, email: 'local-dev' };

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
  if (!env.BOT_API_TOKEN) throw new Error('BOT_API_TOKEN secret is not set on the Worker');
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

export function deviationPct(poolRate, botRate) {
  if (!isFinite(poolRate) || !isFinite(botRate) || botRate <= 0 || poolRate <= 0) return null;
  return (poolRate - botRate) / botRate * 100;
}

export function classify(dev) {
  if (dev === null || dev === undefined) return 'none';
  const abs = Math.abs(dev);
  if (abs > DEVIATION_RED) return 'crit';
  if (abs > DEVIATION_YELLOW) return 'warn';
  return 'ok';
}

async function getRates(env, ctx) {
  const warnings = [];
  const now = Date.now();

  // Pool prices
  let pools = await cacheGet(env, 'pools');
  if (!pools || now - pools.fetchedAt > POOL_TTL_MS) {
    try {
      pools = await once('pools', () => fetchPools(env));
      cachePut(env, ctx, 'pools', pools, 24 * 3600);
    } catch (err) {
      if (!pools) throw new Error(`Couldn't load pool prices: ${err.message}`);
      warnings.push(`Couldn't refresh pool prices (${err.message}). Showing prices from ${new Date(pools.fetchedAt).toISOString()}.`);
    }
  }

  // BOT rates
  let bot = await cacheGet(env, 'bot');
  if (!bot || now - bot.fetchedAt > BOT_TTL_MS) {
    try {
      const fresh = await once('bot', () => fetchBotRates(env));
      // Keep previously cached rates for any currency that failed this time.
      bot = { rates: { ...(bot ? bot.rates : {}), ...fresh.rates }, fetchedAt: fresh.fetchedAt };
      cachePut(env, ctx, 'bot', bot, 7 * 24 * 3600);
      if (fresh.failed.length) warnings.push(`BOT rate lookup failed for ${fresh.failed.join('; ')}. Showing the last known rate where available.`);
    } catch (err) {
      warnings.push(`BOT rate lookup failed (${err.message}). Showing the last known rates where available.`);
    }
  }

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
      botRate: b ? b.rate : null,
      botDate: b ? b.date : null,
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
    botFetchedAt: bot ? bot.fetchedAt : null,
    servedAt: now,
  };
}
