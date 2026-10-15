// Price history: the THBT price of each pool at fixed 6-hour marks, stored in Supabase.
//
// Marks are 09:00, 15:00, 21:00 and 03:00 Bangkok time (02:00, 08:00, 14:00, 20:00 UTC).
// The price at a mark is the pool price right after the last swap before that moment, worked
// out from the swap's sqrtPriceX96 with the same formula the subgraph uses for token0Price /
// token1Price. That makes live captures and the 90-day backfill exactly comparable.
//
// - A cron trigger shortly after each mark captures it and posts a Google Chat alert.
// - Any mark in the last 90 days that's missing (first run, a failed run) is backfilled from
//   swap history, a chunk at a time, by the cron and by visits to the history page.

export const MARK_HOURS_UTC = [2, 8, 14, 20];
export const MARK_STEP_MS = 6 * 3600 * 1000;
const MARK_OFFSET_MS = 2 * 3600 * 1000;              // marks sit 2h after each 6h UTC boundary
export const HISTORY_DAYS = 90;
const DAY_MS = 86400 * 1000;

const BACKFILL_MARKS_PER_RUN = 120;                    // ~5 subgraph queries per run
const ALIASES_PER_QUERY = 120;
const LAZY_BACKFILL_MIN_AGE_MS = 30 * 60 * 1000;       // newest marks are left to the cron (it sends the alert)
const TABLE = 'thbt_price_marks';

// ---------------------------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------------------------

// The latest mark at or before `ms`.
export function markAtOrBefore(ms) {
  return Math.floor((ms - MARK_OFFSET_MS) / MARK_STEP_MS) * MARK_STEP_MS + MARK_OFFSET_MS;
}

// Every mark in [fromMs, toMs], oldest first.
export function marksBetween(fromMs, toMs) {
  const out = [];
  let m = markAtOrBefore(toMs);
  while (m >= fromMs) { out.push(m); m -= MARK_STEP_MS; }
  return out.reverse();
}

// ---------------------------------------------------------------------------------------------
// Price maths
// ---------------------------------------------------------------------------------------------

// THBT per 1 token from a swap's sqrtPriceX96. price1 (token1 per token0) is
// sqrtPriceX96^2 / 2^192 * 10^dec0 / 10^dec1; token0Price is its inverse.
export function thbtPerTokenFromSqrt(sqrtPriceX96, pool) {
  const sqrt = BigInt(sqrtPriceX96);
  if (sqrt <= 0n) return null;
  const dec0 = BigInt(pool.token0Decimals);
  const dec1 = BigInt(pool.token1Decimals);
  const SCALE = 10n ** 36n;
  let num = sqrt * sqrt * SCALE;
  let den = 1n << 192n;
  if (dec0 >= dec1) num *= 10n ** (dec0 - dec1); else den *= 10n ** (dec1 - dec0);
  const price1 = Number(num / den) / 1e36;            // token1 per token0
  if (!isFinite(price1) || price1 <= 0) return null;
  const thbtIsToken0 = String(pool.token0Symbol).toUpperCase() === 'THBT';
  return thbtIsToken0 ? 1 / price1 : price1;
}

// ---------------------------------------------------------------------------------------------
// The Graph
// ---------------------------------------------------------------------------------------------
async function graphQuery(env, query, subgraphId) {
  if (!env.GRAPH_API_KEY) throw new Error('GRAPH_API_KEY secret is not set on the Worker');
  const res = await fetch(`https://gateway.thegraph.com/api/${env.GRAPH_API_KEY}/subgraphs/id/${subgraphId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`The Graph returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(`The Graph: ${body.errors[0].message}`);
  return body.data;
}

// Token order, decimals and creation time for every pool (current and original).
async function poolMeta(env, pairs, subgraphId) {
  const ids = pairs.flatMap(p => [p.poolId, p.fallbackId]);
  const data = await graphQuery(env, `{
    _meta { block { timestamp } }
    pools(where: { id_in: ${JSON.stringify(ids)} }) {
      id
      createdAtTimestamp
      token0 { symbol decimals }
      token1 { symbol decimals }
    }
  }`, subgraphId);
  const pools = {};
  (data.pools || []).forEach(p => {
    pools[p.id.toLowerCase()] = {
      createdAt: Number(p.createdAtTimestamp) * 1000,
      token0Symbol: p.token0.symbol, token0Decimals: Number(p.token0.decimals),
      token1Symbol: p.token1.symbol, token1Decimals: Number(p.token1.decimals),
    };
  });
  const indexedTo = data._meta && data._meta.block && data._meta.block.timestamp
    ? Number(data._meta.block.timestamp) * 1000 : 0;
  return { pools, indexedTo };
}

// Last swap before each (pool, mark). `jobs` = [{ key, poolId, mark }]. Returns { key: swap|null }.
async function lastSwapsBefore(env, jobs, subgraphId) {
  const out = {};
  for (let i = 0; i < jobs.length; i += ALIASES_PER_QUERY) {
    const chunk = jobs.slice(i, i + ALIASES_PER_QUERY);
    const fields = chunk.map((j, n) =>
      `q${n}: swaps(first: 1, orderBy: timestamp, orderDirection: desc, where: { pool: "${j.poolId}", timestamp_lt: ${Math.floor(j.mark / 1000)} }) { timestamp sqrtPriceX96 }`);
    const data = await graphQuery(env, `{\n${fields.join('\n')}\n}`, subgraphId);
    chunk.forEach((j, n) => {
      const row = data[`q${n}`];
      out[j.key] = row && row[0] ? { timestamp: Number(row[0].timestamp) * 1000, sqrtPriceX96: row[0].sqrtPriceX96 } : null;
    });
  }
  return out;
}

// Prices for the given marks: rows ready to store, one per (mark, pair). Uses each pair's
// current pool from the moment it existed, and the original pool before that (or if the
// current pool hadn't traded yet). Pairs with no trades at all before a mark get a null price.
export async function pricesAtMarks(env, marks, pairs, subgraphId, meta) {
  const { pools } = meta;
  const pick = (p, mark) => {
    const current = pools[p.poolId];
    return current && mark >= current.createdAt ? [p.poolId, p.fallbackId] : [p.fallbackId, p.poolId];
  };

  const first = [];
  marks.forEach(mark => pairs.forEach(p => {
    const [primary] = pick(p, mark);
    if (pools[primary]) first.push({ key: `${mark}|${p.symbol}`, poolId: primary, mark });
  }));
  const found = await lastSwapsBefore(env, first, subgraphId);

  // Second pass: the other pool, for any (mark, pair) the first pool had no swap for.
  const second = [];
  marks.forEach(mark => pairs.forEach(p => {
    const key = `${mark}|${p.symbol}`;
    const [, secondary] = pick(p, mark);
    if (!found[key] && pools[secondary]) second.push({ key: key + '|2', poolId: secondary, mark });
  }));
  const found2 = second.length ? await lastSwapsBefore(env, second, subgraphId) : {};

  const rows = [];
  marks.forEach(mark => pairs.forEach(p => {
    const key = `${mark}|${p.symbol}`;
    const [primary, secondary] = pick(p, mark);
    let swap = found[key];
    let poolId = primary;
    if (!swap && found2[key + '|2']) { swap = found2[key + '|2']; poolId = secondary; }
    const price = swap ? thbtPerTokenFromSqrt(swap.sqrtPriceX96, pools[poolId]) : null;
    rows.push({
      mark_at: new Date(mark).toISOString(),
      symbol: p.symbol,
      pool_id: swap ? poolId : null,
      thbt_per_token: price,
      price_as_of: swap ? new Date(swap.timestamp).toISOString() : null,
    });
  }));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Supabase (PostgREST)
// ---------------------------------------------------------------------------------------------
function supabaseConfigured(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

function supabaseHeaders(env, extra = {}) {
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys don't.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function restUrl(env, query, table = TABLE) {
  return `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${table}?${query}`;
}

async function supabaseSelectAll(env, query, table = TABLE) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(restUrl(env, `${query}&limit=${pageSize}&offset=${offset}`, table), { headers: supabaseHeaders(env) });
    if (!res.ok) throw new Error(`Supabase returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function storedMarks(env, fromMs, toMs, symbol) {
  const rows = await supabaseSelectAll(env,
    `select=mark_at&symbol=eq.${encodeURIComponent(symbol)}&mark_at=gte.${new Date(fromMs).toISOString()}&mark_at=lte.${new Date(toMs).toISOString()}&order=mark_at`);
  return new Set(rows.map(r => Date.parse(r.mark_at)));
}

async function upsertRows(env, rows, source) {
  if (!rows.length) return;
  const res = await fetch(restUrl(env, 'on_conflict=mark_at,symbol'), {
    method: 'POST',
    headers: supabaseHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows.map(r => ({ ...r, source }))),
  });
  if (!res.ok) throw new Error(`Supabase insert failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------------------------
// Bank Rates (Bank of Thailand daily average mid rate), stored per business day
// ---------------------------------------------------------------------------------------------
const BANK_TABLE = 'thbt_bank_rates';
const BANK_PUBLISH_UTC_HOUR = 11;           // published around 18:00 Bangkok time
const BANK_LOOKBACK_DAYS = 10;              // a rate from before the first mark (long holidays)
const BANK_CHUNK_DAYS = 31;

const ictDateKey = ms => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);

// When a rate dated `dateKey` became available: 18:00 Bangkok time that day.
export function bankRateAvailableAt(dateKey) {
  return Date.parse(`${dateKey}T00:00:00Z`) + BANK_PUBLISH_UTC_HOUR * 3600 * 1000;
}

// The Bank Rate in effect at `ms`: the latest one already published. `list` is sorted oldest first.
export function bankRateAt(list, ms) {
  let found = null;
  for (const r of list) {
    if (bankRateAvailableAt(r.date) <= ms) found = r; else break;
  }
  return found;
}

async function storedBankRates(env, fromKey, toKey) {
  const rows = await supabaseSelectAll(env,
    `select=rate_date,currency,mid_rate&rate_date=gte.${fromKey}&rate_date=lte.${toKey}&order=rate_date`, BANK_TABLE);
  const byCurrency = {};
  rows.forEach(r => {
    (byCurrency[r.currency] = byCurrency[r.currency] || []).push({ date: String(r.rate_date).slice(0, 10), rate: Number(r.mid_rate) });
  });
  return byCurrency;
}

async function bankCoverage(env, currency) {
  const q = order => restUrl(env, `select=rate_date&currency=eq.${currency}&order=rate_date.${order}&limit=1`, BANK_TABLE);
  const [first, last] = await Promise.all(['asc', 'desc'].map(async o => {
    const res = await fetch(q(o), { headers: supabaseHeaders(env) });
    if (!res.ok) throw new Error(`Supabase returned HTTP ${res.status}`);
    const rows = await res.json();
    return rows[0] ? String(rows[0].rate_date).slice(0, 10) : null;
  }));
  return { first, last };
}

// Fetches Bank Rates for [startKey, endKey] (in 31-day requests) and stores them.
async function fetchAndStoreBankRates(env, ctxShared, startKey, endKey) {
  const currencies = [...new Set(ctxShared.pairs.map(p => p.currency))];
  const rows = [];
  const failed = [];
  for (let start = Date.parse(startKey); start <= Date.parse(endKey); start += BANK_CHUNK_DAYS * DAY_MS) {
    const s = new Date(start).toISOString().slice(0, 10);
    const e = new Date(Math.min(start + (BANK_CHUNK_DAYS - 1) * DAY_MS, Date.parse(endKey))).toISOString().slice(0, 10);
    const results = await Promise.allSettled(currencies.map(c => ctxShared.fetchBankRange(c, s, e)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') r.value.forEach(x => rows.push({ rate_date: x.date, currency: currencies[i], mid_rate: x.rate }));
      else failed.push(`${currencies[i]} ${s}..${e} (${r.reason.message})`);
    });
  }
  if (rows.length) {
    const res = await fetch(restUrl(env, 'on_conflict=currency,rate_date', BANK_TABLE), {
      method: 'POST',
      headers: supabaseHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows.map(r => ({ ...r, fetched_at: new Date().toISOString() }))),
    });
    if (!res.ok) throw new Error(`Supabase insert failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  if (failed.length) console.warn('Bank Rate fetch failed for', failed.join('; '));
  return { stored: rows.length, failed };
}

// Makes sure stored Bank Rates cover `fromMs` (minus a lookback) up to today.
// Returns true if it had to fetch anything.
async function ensureBankRates(env, ctxShared, fromMs, now) {
  const needFrom = ictDateKey(fromMs - BANK_LOOKBACK_DAYS * DAY_MS);
  const today = ictDateKey(now);
  const { first, last } = await bankCoverage(env, 'USD');
  if (!first || first > ictDateKey(fromMs - (BANK_LOOKBACK_DAYS - 5) * DAY_MS)) {
    await fetchAndStoreBankRates(env, ctxShared, needFrom, today);
    return true;
  }
  // Recent rates: refresh the last 10 days if the newest stored one is more than a day old.
  if (!last || last < ictDateKey(now - DAY_MS)) {
    await fetchAndStoreBankRates(env, ctxShared, ictDateKey(now - BANK_LOOKBACK_DAYS * DAY_MS), today);
    return true;
  }
  return false;
}

export function bankCoverageLooksShort(first, fromMs) {
  return !first || first > ictDateKey(fromMs - (BANK_LOOKBACK_DAYS - 5) * DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------------------------

// Fills up to BACKFILL_MARKS_PER_RUN missing marks (newest first) between `fromMs` and
// `untilMs`. Returns how many marks are still missing afterwards.
export async function backfill(env, ctxShared, { fromMs, untilMs, meta }) {
  const { pairs, subgraphId } = ctxShared;
  const have = await storedMarks(env, fromMs, untilMs, pairs[0].symbol);
  const missing = marksBetween(fromMs, untilMs).filter(m => !have.has(m));
  if (!missing.length) return 0;
  const batch = missing.slice(-BACKFILL_MARKS_PER_RUN);
  const m = meta || await poolMeta(env, pairs, subgraphId);
  // Only marks the subgraph has fully indexed.
  const ready = batch.filter(mark => mark <= m.indexedTo);
  const rows = await pricesAtMarks(env, ready, pairs, subgraphId, m);
  await upsertRows(env, rows, 'backfill');
  return missing.length - ready.length;
}

// One backfill at a time per location; KV keeps parallel page visits from piling up.
const LOCK_KEY = 'history-backfill-lock';
let localLockUntil = 0;

async function withBackfillLock(env, fn) {
  if (Date.now() < localLockUntil) return false;
  if (env.RATES_CACHE) {
    try {
      if (await env.RATES_CACHE.get(LOCK_KEY)) return false;
      await env.RATES_CACHE.put(LOCK_KEY, '1', { expirationTtl: 60 });
    } catch (e) { /* lock is best effort; upserts are idempotent */ }
  }
  localLockUntil = Date.now() + 60 * 1000;
  try { await fn(); } finally {
    localLockUntil = 0;
    if (env.RATES_CACHE) { try { await env.RATES_CACHE.delete(LOCK_KEY); } catch (e) { /* ignore */ } }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Scheduled capture + alert
// ---------------------------------------------------------------------------------------------

// Runs from the cron trigger. Captures the latest mark if it isn't stored yet (and alerts),
// then backfills a chunk of older missing marks.
export async function runScheduled(env, ctxShared, scheduledTime) {
  if (!supabaseConfigured(env)) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const { pairs, subgraphId } = ctxShared;
  const mark = markAtOrBefore(scheduledTime);
  const meta = await poolMeta(env, pairs, subgraphId);
  const result = { mark: new Date(mark).toISOString(), captured: false, alerted: false, stillMissing: null };

  const have = await storedMarks(env, mark, mark, pairs[0].symbol);
  if (!have.has(mark)) {
    if (meta.indexedTo < mark) {
      // The subgraph hasn't indexed up to the mark yet; the retry cron picks it up.
      result.note = 'subgraph not yet indexed to the mark';
    } else {
      const rows = await pricesAtMarks(env, [mark], pairs, subgraphId, meta);
      await upsertRows(env, rows, 'scheduled');
      result.captured = true;
      if (alertChannels(env).length) {
        const bot = ctxShared.getBotRates ? await ctxShared.getBotRates().catch(() => null) : null;
        const sent = await sendCaptureAlert(env, mark, rows, bot, ctxShared);
        result.alerted = sent.sent;
        if (sent.failed.length) result.alertFailures = sent.failed;
      }
    }
  }

  try {
    result.bankRatesFetched = await ensureBankRates(env, ctxShared, mark - HISTORY_DAYS * DAY_MS, scheduledTime);
  } catch (err) {
    result.bankRatesError = err.message;
  }

  result.stillMissing = await backfill(env, ctxShared, {
    fromMs: mark - HISTORY_DAYS * DAY_MS, untilMs: mark - MARK_STEP_MS, meta,
  });
  return result;
}

export function formatIct(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' ICT';
}

// One line per pair, e.g. "THBT / USDC: Uniswap: 33.21, Bank Rate: 33.01, Deviation: +0.61%".
// `items` = [{ symbol, price, bankRate, deviation }]; missing values show as "n/a".
export function formatAlertLine({ symbol, price, bankRate, deviation }) {
  const num = v => (v === null || v === undefined || !isFinite(v) ? 'n/a' : Number(v).toFixed(2));
  const dev = deviation === null || deviation === undefined || !isFinite(deviation)
    ? 'n/a' : `${deviation > 0 ? '+' : ''}${deviation.toFixed(2)}%`;
  return `THBT / ${symbol}: Uniswap: ${num(price)}, Bank Rate: ${num(bankRate)}, Deviation: ${dev}`;
}

// Google Chat: *bold* title and <url|label> link.
export function buildChatMessage(title, items, dashboardUrl, linkPage = 'history.html', linkLabel = 'Open price history') {
  const parts = [`*${title}*`, ...items.map(formatAlertLine)];
  if (dashboardUrl) parts.push('', `<${dashboardUrl}/${linkPage}|${linkLabel}>`);
  return { text: parts.join('\n') };
}

// Telegram: HTML formatting (only <b> and <a>; everything else escaped).
const escapeTg = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function buildTelegramMessage(title, items, dashboardUrl, linkPage = 'history.html', linkLabel = 'Open price history') {
  const parts = [`<b>${escapeTg(title)}</b>`, ...items.map(i => escapeTg(formatAlertLine(i)))];
  if (dashboardUrl) parts.push('', `<a href="${escapeTg(`${dashboardUrl}/${linkPage}`)}">${escapeTg(linkLabel)}</a>`);
  return parts.join('\n');
}

export async function postToChat(env, message) {
  if (!env.GOOGLE_CHAT_WEBHOOK_URL) throw new Error('GOOGLE_CHAT_WEBHOOK_URL secret is not set on the Worker');
  const res = await fetch(env.GOOGLE_CHAT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Google Chat returned HTTP ${res.status}`);
}

export async function postToTelegram(env, html) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set on the Worker');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(env.TELEGRAM_CHAT_ID).trim(), text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).description || ''; } catch (e) { /* ignore */ }
    throw new Error(`Telegram returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

// Channels with their settings filled in.
export function alertChannels(env) {
  const out = [];
  if (env.GOOGLE_CHAT_WEBHOOK_URL) out.push('Google Chat');
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push('Telegram');
  return out;
}

// Sends one alert to every configured channel. One channel failing doesn't stop the other.
// Returns { sent: [channel names], failed: [{ channel, error }] }.
export async function sendAlert(env, title, items, linkPage = 'history.html', linkLabel = 'Open price history') {
  const url = dashboardUrlFrom(env);
  const jobs = [];
  if (env.GOOGLE_CHAT_WEBHOOK_URL) jobs.push(['Google Chat', () => postToChat(env, buildChatMessage(title, items, url, linkPage, linkLabel))]);
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) jobs.push(['Telegram', () => postToTelegram(env, buildTelegramMessage(title, items, url, linkPage, linkLabel))]);
  const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const sent = [], failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent.push(jobs[i][0]);
    else failed.push({ channel: jobs[i][0], error: r.reason.message });
  });
  return { sent, failed };
}

export function dashboardUrlFrom(env) {
  return env.DASHBOARD_URL ? String(env.DASHBOARD_URL).replace(/\/+$/, '') : '';
}

async function sendCaptureAlert(env, mark, rows, bot, ctxShared) {
  const currencyBySymbol = Object.fromEntries(ctxShared.pairs.map(p => [p.symbol, p.currency]));
  const items = rows.map(r => {
    const b = bot && bot.rates && bot.rates[currencyBySymbol[r.symbol]];
    return {
      symbol: r.symbol,
      price: r.thbt_per_token,
      bankRate: b ? b.rate : null,
      deviation: b && r.thbt_per_token !== null ? ctxShared.deviationPct(r.thbt_per_token, b.rate) : null,
    };
  });
  return sendAlert(env, `THBT prices: 6-hour capture at ${formatIct(mark)}`, items);
}

// ---------------------------------------------------------------------------------------------
// /api/history
// ---------------------------------------------------------------------------------------------

// Validates the requested range: from at most 90 days ago, to no later than now, at most 90
// days apart. Returns { fromMs, toMs } or { error }.
export function parseRange(searchParams, now) {
  const earliest = now - HISTORY_DAYS * DAY_MS;
  const toRaw = searchParams.get('to');
  const fromRaw = searchParams.get('from');
  let toMs = toRaw ? Date.parse(toRaw) : now;
  let fromMs = fromRaw ? Date.parse(fromRaw) : toMs - 7 * DAY_MS;
  if (!isFinite(toMs) || !isFinite(fromMs)) return { error: 'Invalid date range.' };
  if (toMs > now) toMs = now;
  if (fromMs < earliest - 60 * 1000) return { error: `History only goes back ${HISTORY_DAYS} days.` };
  fromMs = Math.max(fromMs, earliest);
  if (fromMs > toMs) return { error: 'The start date must be before the end date.' };
  if (toMs - fromMs > HISTORY_DAYS * DAY_MS + 60 * 1000) return { error: `Pick a range of at most ${HISTORY_DAYS} days.` };
  return { fromMs, toMs };
}

export async function handleHistory(env, ctx, ctxShared, url, now = Date.now()) {
  if (!supabaseConfigured(env)) {
    return { status: 500, body: { error: 'Price history isn’t set up yet: SUPABASE_URL and SUPABASE_SECRET_KEY must be set on the Worker.' } };
  }
  const range = parseRange(url.searchParams, now);
  if (range.error) return { status: 400, body: { error: range.error } };
  const { fromMs, toMs } = range;
  const { pairs } = ctxShared;

  const rows = await supabaseSelectAll(env,
    `select=mark_at,symbol,thbt_per_token,price_as_of,pool_id&mark_at=gte.${new Date(fromMs).toISOString()}&mark_at=lte.${new Date(toMs).toISOString()}&order=mark_at`);

  const expected = marksBetween(fromMs, toMs);
  const got = new Set(rows.filter(r => r.symbol === pairs[0].symbol).map(r => Date.parse(r.mark_at)));
  const settledBefore = now - LAZY_BACKFILL_MIN_AGE_MS;
  const missing = expected.filter(m => !got.has(m) && m <= settledBefore);

  // Bank Rates for the range (plus a lookback for the first marks).
  const bank = await storedBankRates(env, ictDateKey(fromMs - BANK_LOOKBACK_DAYS * DAY_MS), ictDateKey(toMs));
  const bankShort = bankCoverageLooksShort((bank.USD || [])[0] && bank.USD[0].date, Math.max(fromMs, now - HISTORY_DAYS * DAY_MS));

  // Fill gaps in the background; the page polls until they're in.
  let backfilling = false;
  if (missing.length || bankShort) {
    backfilling = true;
    const job = withBackfillLock(env, async () => {
      await ensureBankRates(env, ctxShared, now - HISTORY_DAYS * DAY_MS, now);
      if (missing.length) {
        await backfill(env, ctxShared, {
          fromMs: Math.max(fromMs, now - HISTORY_DAYS * DAY_MS), untilMs: Math.min(toMs, settledBefore),
        });
      }
    }).catch(err => console.error('history backfill failed', err));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  }

  const currencyBySymbol = Object.fromEntries(pairs.map(p => [p.symbol, p.currency]));
  const series = {};
  pairs.forEach(p => { series[p.symbol] = []; });
  rows.forEach(r => {
    if (!series[r.symbol]) return;
    const t = Date.parse(r.mark_at);
    const price = r.thbt_per_token === null ? null : Number(r.thbt_per_token);
    const b = bankRateAt(bank[currencyBySymbol[r.symbol]] || [], t);
    series[r.symbol].push({
      t,
      price,
      asOf: r.price_as_of ? Date.parse(r.price_as_of) : null,
      bank: b ? b.rate : null,
      bankDate: b ? b.date : null,
      dev: b && price !== null ? ctxShared.deviationPct(price, b.rate) : null,
    });
  });

  return {
    status: 200,
    body: {
      from: fromMs, to: toMs,
      expectedMarks: expected.length,
      missingMarks: missing.length,
      backfilling,
      thresholds: ctxShared.thresholds,
      pairs: pairs.map(p => ({ symbol: p.symbol, currency: p.currency })),
      series,
    },
  };
}
