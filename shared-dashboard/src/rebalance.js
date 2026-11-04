// Rebalance: how much to swap in a pool to move its price to a target (the Bank Rate).
//
// Uniswap v4 pools use concentrated liquidity, so the amount depends on how much liquidity sits
// between the current price and the target. This walks from the current price to the target one
// liquidity range at a time (between initialised ticks), using the standard range formulas:
//
//   price going up   (token1 in, token0 out):  Δtoken1 = L·(√P_b − √P_a),   Δtoken0 = L·(1/√P_a − 1/√P_b)
//   price going down (token0 in, token1 out):  Δtoken0 = L·(1/√P_b − 1/√P_a), Δtoken1 = L·(√P_a − √P_b)
//
// where √P is the square root of the raw token1/token0 price and L the active liquidity. Crossing
// a tick upwards adds its liquidityNet to L; crossing downwards subtracts it. The pool's swap fee
// is added on top of the amount paid in.
//
// It's an estimate for a single swap made right now: it assumes nobody else trades first and that
// the pool's hook (if any) doesn't change the swap maths.

const Q96 = 2 ** 96;
const DYNAMIC_FEE_FLAG = 0x800000;         // v4 pools with a dynamic fee set by their hook
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const sqrtAtTick = tick => Math.pow(1.0001, tick / 2);

// pool: { sqrtPrice, liquidity, tick, feeTier, hooks, token0Symbol, token1Symbol, token0Decimals, token1Decimals }
// ticks: [{ tickIdx, liquidityNet }] (initialised ticks of that pool)
// target: THBT per 1 token to move the pool to.
// Returns null when it can't be worked out, otherwise:
//   { side: 'buy' | 'sell' | 'none', tokenAmount, thbtAmount, feePct, dynamicFee, hasHook, reachable }
// 'buy'  = buy `tokenAmount` of the token, paying `thbtAmount` THBT (fee included)
// 'sell' = sell `tokenAmount` of the token (fee included), receiving `thbtAmount` THBT
export function computeRebalance(pool, ticks, target) {
  if (!pool || !isFinite(target) || target <= 0) return null;
  const d0 = Number(pool.token0Decimals), d1 = Number(pool.token1Decimals);
  if (!Number.isInteger(d0) || !Number.isInteger(d1)) return null;
  let s0;
  try { s0 = Number(BigInt(pool.sqrtPrice)) / Q96; } catch (e) { return null; }
  let L = Number(pool.liquidity);
  const current = Number(pool.tick);
  if (!(s0 > 0) || !isFinite(L) || !Number.isFinite(current)) return null;

  const thbtIs0 = String(pool.token0Symbol || '').toUpperCase() === 'THBT';
  const feeTier = Number(pool.feeTier) || 0;
  const dynamicFee = (feeTier & DYNAMIC_FEE_FLAG) !== 0;
  const fee = dynamicFee ? 0 : feeTier / 1e6;
  const hasHook = !!pool.hooks && String(pool.hooks).toLowerCase() !== ZERO_ADDRESS;
  const base = { feePct: fee * 100, dynamicFee, hasHook };

  // Target as √(raw token1 / token0).
  const price1Human = thbtIs0 ? 1 / target : target;       // token1 per token0, in whole tokens
  const sT = Math.sqrt(price1Human * Math.pow(10, d1 - d0));
  if (!(sT > 0) || !isFinite(sT)) return null;
  if (Math.abs(sT - s0) / s0 < 1e-12) return { ...base, side: 'none', tokenAmount: 0, thbtAmount: 0, reachable: true };

  const list = (ticks || [])
    .map(t => ({ idx: Number(t.tickIdx), net: Number(t.liquidityNet) }))
    .filter(t => Number.isFinite(t.idx) && isFinite(t.net))
    .sort((a, b) => a.idx - b.idx);

  let s = s0, amount0 = 0, amount1 = 0, reached = false;
  const up = sT > s0;
  const step = next => {
    if (L > 0) {
      if (up) { amount1 += L * (next - s); amount0 += L * (1 / s - 1 / next); }
      else { amount0 += L * (1 / next - 1 / s); amount1 += L * (s - next); }
    }
    s = next;
  };

  if (up) {
    for (const t of list.filter(t => t.idx > current)) {
      const next = Math.min(sqrtAtTick(t.idx), sT);
      step(next);
      if (next >= sT) { reached = true; break; }
      L += t.net;
    }
  } else {
    for (const t of list.filter(t => t.idx <= current).reverse()) {
      const next = Math.max(sqrtAtTick(t.idx), sT);
      step(next);
      if (next <= sT) { reached = true; break; }
      L -= t.net;
    }
  }
  if (!reached && L > 0) { step(sT); reached = true; }

  // Raw amounts to whole tokens. Going up, token1 is paid in; going down, token0 is.
  const in0 = !up;
  const amountIn = (in0 ? amount0 / Math.pow(10, d0) : amount1 / Math.pow(10, d1)) / (1 - fee);
  const amountOut = in0 ? amount1 / Math.pow(10, d1) : amount0 / Math.pow(10, d0);
  const thbtIsIn = in0 === thbtIs0;
  return {
    ...base,
    side: thbtIsIn ? 'buy' : 'sell',
    tokenAmount: thbtIsIn ? amountOut : amountIn,
    thbtAmount: thbtIsIn ? amountIn : amountOut,
    reachable: reached,
  };
}
