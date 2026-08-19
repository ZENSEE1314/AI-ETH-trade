// The Sniper Entry System: assembles a trade Signal by walking the core
// philosophy in order — Bias > Context > Liquidity > Market Structure >
// Timing > Execution. Each stage must agree or the setup is rejected.
//
// Top-down entry model (the ETH example this was tuned on):
//   4H  — draw on liquidity: a sweep sets the side, the opposing resting pool
//         sets the target. This is the high-probability read the lower
//         timeframes can't show on their own.
//   15M — the reaction swing (HL for a long / LH for a short) that confirms the
//         setup after the 4H sweep.
//   1M  — the next reaction swing that times the entry, giving a tight stop and
//         a long runway toward the 4H draw.

import { randomUUID } from 'node:crypto';
import type { Candle, Signal, Side } from '../types.js';
import { buildBias } from './bias.js';
import { readStructure, lastReactionSwing } from './structure.js';
import { buildLiquidity, detectSweep } from './liquidity.js';
import { detectDrawOnLiquidity } from './drawOnLiquidity.js';
import { premiumDiscount } from './fvg.js';
import { readVwap } from './vwap.js';
import { analyzeCandle } from './candles.js';

/** Multi-timeframe input. Any series may be omitted; the engine degrades gracefully. */
export interface MarketSnapshot {
  symbol: string;
  h4: Candle[]; // bias / draw on liquidity
  h1: Candle[]; // confirmation / context
  m15: Candle[]; // setup
  m1: Candle[]; // entry / timing
}

const WEIGHTS = {
  draw: 25, // primary draw on liquidity (or HTF bias when no draw is present)
  ltfDraw: 8, // 15M draw agrees with the 4H draw (cross-timeframe confirmation)
  context: 10, // 1H not opposing / aligned
  structure: 12, // setup-TF structure agrees
  setup: 14, // 15M reaction swing confirms
  entry: 17, // 1M reaction swing + candle times the trigger
  liquidity: 6, // discount/premium pricing bonus
  vwap: 8,
} as const;

export function generateSignal(snap: MarketSnapshot): Signal | null {
  const reasons: string[] = [];
  let confluence = 0;

  const setup = snap.m15.length ? snap.m15 : snap.h1;
  const entryTf = snap.m1.length ? snap.m1 : setup;
  if (setup.length < 10 || entryTf.length < 3) return null;

  // 1. DRAW ON LIQUIDITY — the high-probability directional read. -------------
  // A sweep of one side plus an untapped pool on the other means price is drawn
  // to that opposing pool. The 4H is primary; the 15M often shows the same
  // both-sides picture and confirms (or, when the 4H is silent, drives) the
  // direction we then use to hunt the 15M/1M entry.
  const dol4h = snap.h4.length ? detectDrawOnLiquidity(snap.h4) : null;
  const dolLtf = detectDrawOnLiquidity(setup, 30);
  const driver = dol4h ?? dolLtf; // 4H wins when present
  let side: Side;
  if (driver) {
    side = driver.side;
    confluence += WEIGHTS.draw;
    const tf = dol4h ? '4H' : '15M';
    reasons.push(`DRAW (${tf}): ${driver.reasons.join('; ')}`);

    // Cross-timeframe agreement is a strong tell; disagreement is a caution.
    if (dol4h && dolLtf) {
      if (dolLtf.side === dol4h.side) {
        confluence += WEIGHTS.ltfDraw;
        reasons.push(
          `DRAW (15M): agrees — ${dolLtf.side} swept @ ${dolLtf.sweptLevel.toFixed(2)}, draw ${dolLtf.drawTarget.toFixed(2)}`,
        );
      } else {
        reasons.push(`DRAW (15M): conflicts with 4H (15M reads ${dolLtf.side}) — 4H leads`);
      }
    }
  } else {
    const bias = buildBias(snap.h4.length ? snap.h4 : snap.h1.length ? snap.h1 : setup);
    if (bias.direction === 'neutral') return null;
    side = bias.direction;
    confluence += WEIGHTS.draw;
    reasons.push(`BIAS (no draw): ${side.toUpperCase()} — ${bias.reasons.join('; ')}`);
  }

  // 2. CONTEXT (1H) — confirmation must not oppose the direction. --------------
  const ctx = readStructure(snap.h1.length ? snap.h1 : setup);
  const ctxOpposes =
    (side === 'long' && ctx.trend === 'bearish') || (side === 'short' && ctx.trend === 'bullish');
  if (ctxOpposes && !ctx.choch) {
    return null; // 1H structurally against us with no reversal — stand aside
  }
  if ((side === 'long' && ctx.trend === 'bullish') || (side === 'short' && ctx.trend === 'bearish')) {
    confluence += WEIGHTS.context;
    reasons.push(`CONTEXT: 1H aligned (${ctx.label})`);
  } else {
    reasons.push(`CONTEXT: 1H not opposing (${ctx.label})`);
  }

  // 3. LIQUIDITY / PRICING — sweep in our favor or good discount/premium. ------
  const liq = buildLiquidity(setup);
  const sweep = detectSweep(setup, liq);
  const favorableSweep =
    (side === 'long' && sweep.swept === 'sell-side') ||
    (side === 'short' && sweep.swept === 'buy-side');
  if (favorableSweep) {
    confluence += WEIGHTS.liquidity;
    reasons.push(`LIQUIDITY: ${sweep.swept} swept @ ${sweep.level?.toFixed(2)} then rejected`);
  } else {
    const pd = premiumDiscount(setup);
    const atDiscountForLong = side === 'long' && pd.zone === 'discount';
    const atPremiumForShort = side === 'short' && pd.zone === 'premium';
    if (atDiscountForLong || atPremiumForShort) {
      confluence += WEIGHTS.liquidity * 0.5;
      reasons.push(`LIQUIDITY: entering from ${pd.zone}`);
    } else {
      reasons.push('LIQUIDITY: no favorable sweep / poor pricing');
    }
  }

  // 4. MARKET STRUCTURE (setup TF) — CHoCH/BOS in our direction. ---------------
  const struct = readStructure(setup);
  const structAligned =
    (side === 'long' && (struct.trend === 'bullish' || struct.choch)) ||
    (side === 'short' && (struct.trend === 'bearish' || struct.choch));
  if (structAligned) {
    confluence += WEIGHTS.structure;
    reasons.push(`STRUCTURE: ${struct.label}`);
  } else {
    reasons.push(`STRUCTURE: not confirmed (${struct.label})`);
  }

  // 5. SETUP (15M) — the reaction swing after the sweep (HL long / LH short). --
  const setupSwing = lastReactionSwing(setup, side);
  if (!setupSwing) return null; // no pivot to build the setup on
  if (setupSwing.higher) {
    confluence += WEIGHTS.setup;
    reasons.push(
      `SETUP: 15M ${side === 'long' ? 'higher-low' : 'lower-high'} @ ${setupSwing.swing.price.toFixed(2)}`,
    );
  } else {
    confluence += WEIGHTS.setup * 0.5;
    reasons.push(
      `SETUP: 15M ${side === 'long' ? 'swing low' : 'swing high'} @ ${setupSwing.swing.price.toFixed(2)} (not yet a ${side === 'long' ? 'HL' : 'LH'})`,
    );
  }

  // 6. ENTRY (1M) — the reaction swing that times the trigger + candle confirm.
  const entrySwing = lastReactionSwing(entryTf, side) ?? setupSwing;
  const lastCandle = analyzeCandle(entryTf.at(-1)!);
  const candleConfirms =
    (side === 'long' && (lastCandle.bullish || lastCandle.rejection === 'bottom')) ||
    (side === 'short' && (lastCandle.bearish || lastCandle.rejection === 'top'));
  if (candleConfirms) {
    confluence += WEIGHTS.entry;
    reasons.push(
      `ENTRY: 1M ${side === 'long' ? 'HL' : 'LH'} @ ${entrySwing.swing.price.toFixed(2)}, candle confirms (${lastCandle.strength})`,
    );
  } else {
    confluence += WEIGHTS.entry * 0.4;
    reasons.push(`ENTRY: 1M ${side === 'long' ? 'HL' : 'LH'} @ ${entrySwing.swing.price.toFixed(2)}, awaiting candle confirmation`);
  }

  // 7. VWAP confirmation. -----------------------------------------------------
  const vwap = readVwap(entryTf);
  const vwapAgrees =
    (side === 'long' && vwap.signal.includes('long')) ||
    (side === 'short' && vwap.signal.includes('short'));
  if (vwapAgrees) {
    confluence += WEIGHTS.vwap;
    reasons.push(`VWAP: ${vwap.signal}`);
  }

  // 8. EXECUTION — entry off the 1M swing, tight stop under it, draw as target.
  const price = entryTf.at(-1)!.close;
  const entry = price;

  const stopLoss = computeStop(side, entry, entrySwing.swing.price, setup);
  const takeProfit = driver ? driver.drawTarget : computeTarget(side, entry, liq, struct);
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;
  const riskReward = reward / risk;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol: snap.symbol,
    side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(riskReward, 2),
    confluence: Math.round(confluence),
    source: 'engine',
    reasons,
    // Draw context for the dashboard (a long is drawn up after a sell-side sweep).
    ...(driver && {
      sweepSide: driver.side === 'long' ? 'sell-side' : 'buy-side',
      sweptLevel: round(driver.sweptLevel),
      drawTarget: round(driver.drawTarget),
      drawTimeframe: dol4h ? '4H' : '15M',
    }),
  };
}

/**
 * Stop sits just past the 1M reaction swing the entry is timed off — the tight
 * invalidation that gives the long runway toward the 4H draw. If that pivot is
 * on the wrong side of entry (a bad swing), fall back to the setup-window
 * extreme so risk is never zero or inverted.
 */
function computeStop(side: Side, entry: number, swingPrice: number, setup: Candle[]): number {
  const buffer = entry * 0.0015;
  const window = setup.slice(-10);
  if (side === 'long') {
    const base = swingPrice < entry ? swingPrice : Math.min(...window.map((c) => c.low));
    return base - buffer;
  }
  const base = swingPrice > entry ? swingPrice : Math.max(...window.map((c) => c.high));
  return base + buffer;
}

function computeTarget(
  side: Side,
  entry: number,
  liq: ReturnType<typeof buildLiquidity>,
  struct: ReturnType<typeof readStructure>,
): number {
  if (side === 'long') {
    const targets = [liq.pdh, liq.pwh, struct.lastSwingHigh?.price, ...liq.equalHighs]
      .filter((v): v is number => v != null && v > entry)
      .sort((a, b) => a - b);
    return targets[0] ?? entry * 1.01;
  }
  const targets = [liq.pdl, liq.pwl, struct.lastSwingLow?.price, ...liq.equalLows]
    .filter((v): v is number => v != null && v < entry)
    .sort((a, b) => b - a);
  return targets[0] ?? entry * 0.99;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
