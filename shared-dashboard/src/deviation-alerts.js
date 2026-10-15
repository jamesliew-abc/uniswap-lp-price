// Deviation alerts: every 5 minutes (cron), compare each pair's live Uniswap price with the
// Bank Rate and alert when a pair's status changes:
//   - goes over 2%            -> "now over 2%"
//   - goes over 4%            -> "now over 4%"
//   - comes back within 2%    -> "back within 2%"
// A pair that stays out of range doesn't alert again, and easing from over 4% to over 2% is
// recorded silently. To stop a price hovering right at a threshold from flapping, a pair only
// counts as back below a threshold once it's at least 0.2 percentage points under it.
//
// The last known status of each pair is kept in KV. It's only saved once an alert has gone out
// to at least one channel, so a failed send is retried on the next check.

import { sendAlert, alertChannels, formatIct } from './history.js';

const STATE_KEY = 'deviation-alert-state';
export const RECOVERY_MARGIN = 0.2;   // percentage points

// 0 = within the yellow threshold, 1 = over yellow (2%), 2 = over red (4%).
export function levelOf(absDev, th) {
  return absDev > th.red ? 2 : absDev > th.yellow ? 1 : 0;
}

// Next level, with hysteresis on the way down.
export function nextLevel(prev, absDev, th) {
  const raw = levelOf(absDev, th);
  if (raw >= prev) return raw;
  const easedTo = absDev > th.red - RECOVERY_MARGIN ? 2 : absDev > th.yellow - RECOVERY_MARGIN ? 1 : 0;
  return Math.min(prev, Math.max(raw, easedTo));
}

async function loadState(env) {
  if (!env.RATES_CACHE) return {};
  try { return (await env.RATES_CACHE.get(STATE_KEY, 'json')) || {}; } catch (e) { return {}; }
}

async function saveState(env, state) {
  if (!env.RATES_CACHE) return;
  await env.RATES_CACHE.put(STATE_KEY, JSON.stringify(state));
}

// rows: [{ symbol, poolRate, botRate, deviation }] from the live rates.
// Returns { state, changes: [{ symbol, from, to, row }] } without side effects.
export function evaluate(prevState, rows, th, now) {
  const state = { ...prevState };
  const changes = [];
  rows.forEach(r => {
    if (r.deviation === null || r.deviation === undefined || !isFinite(r.deviation)) return;   // no price or no Bank Rate
    const prev = prevState[r.symbol] ? prevState[r.symbol].level : 0;
    const next = nextLevel(prev, Math.abs(r.deviation), th);
    if (next === prev) return;
    state[r.symbol] = { level: next, since: now, deviation: r.deviation };
    const alerts = next > prev || next === 0;     // up a level, or fully back in range
    changes.push({ symbol: r.symbol, from: prev, to: next, row: r, alerts });
  });
  return { state, changes };
}

export async function runDeviationCheck(env, ctxShared, now = Date.now()) {
  if (String(env.DEVIATION_ALERTS || 'on').trim().toLowerCase() === 'off') return { skipped: 'DEVIATION_ALERTS is off' };
  if (!alertChannels(env).length) return { skipped: 'no alert channels set up' };
  if (!env.RATES_CACHE) return { skipped: 'RATES_CACHE KV binding is needed to remember each pair’s status' };

  const th = ctxShared.thresholds;
  const data = await ctxShared.getLiveRates();
  const prevState = await loadState(env);
  const { state, changes } = evaluate(prevState, data.rows, th, now);
  if (!changes.length) return { changes: 0 };

  const toAlert = changes.filter(c => c.alerts);
  if (!toAlert.length) {
    await saveState(env, state);
    return { changes: changes.length, alerted: [] };
  }

  const note = c => c.to === 2 ? `now over ${th.red}%` : c.to === 1 ? `now over ${th.yellow}%` : `back within ${th.yellow}%`;
  const items = toAlert.map(c => ({
    symbol: c.symbol, price: c.row.poolRate, bankRate: c.row.botRate, deviation: c.row.deviation, note: note(c),
  }));
  const anyOver = toAlert.some(c => c.to > 0);
  const title = toAlert.length === 1
    ? `${anyOver ? '⚠️' : '✅'} THBT deviation alert: THBT / ${toAlert[0].symbol} ${note(toAlert[0])} (${formatIct(now)})`
    : `${anyOver ? '⚠️' : '✅'} THBT deviation alert: ${toAlert.length} pairs changed (${formatIct(now)})`;

  const result = await sendAlert(env, title, items, 'deviation.html', 'Open deviation history');
  if (result.sent.length) await saveState(env, state);   // otherwise try again next check
  return { changes: changes.length, alerted: toAlert.map(c => `${c.symbol}: ${note(c)}`), sent: result.sent, failed: result.failed };
}
