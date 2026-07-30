// Daily bias: the top of the philosophy pipeline (Bias > Context > ...).
// Built from HTF structure, opening price vs PDH/PDL, and premium/discount.

import type { Bias, Candle } from '../types.js';
import { readStructure } from './structure.js';
import { buildLiquidity } from './liquidity.js';
import { premiumDiscount } from './fvg.js';

/**
 * Combine higher-timeframe structure, price location vs previous-day range,
 * and premium/discount into a single directional bias with a reasons trail.
 */
export function buildBias(htfCandles: Candle[]): Bias {
  const reasons: string[] = [];
  const structure = readStructure(htfCandles);
  const liq = buildLiquidity(htfCandles);
  const { zone } = premiumDiscount(htfCandles);
  const price = htfCandles.at(-1)?.close ?? 0;

  let score = 0; // >0 long, <0 short

  if (structure.trend === 'bullish') {
    score += 2;
    reasons.push(`HTF structure bullish (${structure.label})`);
  } else if (structure.trend === 'bearish') {
    score -= 2;
    reasons.push(`HTF structure bearish (${structure.label})`);
  } else {
    reasons.push('HTF structure ranging');
  }

  // Opening price relative to previous day range = intraday bias tell.
  if (liq.op != null && liq.pdh != null && liq.pdl != null) {
    if (price > liq.op) {
      score += 1;
      reasons.push('Price above opening price (bullish intent)');
    } else if (price < liq.op) {
      score -= 1;
      reasons.push('Price below opening price (bearish intent)');
    }
    if (price > liq.pdh) {
      score += 1;
      reasons.push('Trading above PDH — buy-side in control');
    } else if (price < liq.pdl) {
      score -= 1;
      reasons.push('Trading below PDL — sell-side in control');
    }
  }

  // In discount we favor longs; in premium we favor shorts.
  if (zone === 'discount') {
    score += 1;
    reasons.push('Price in discount (favor longs)');
  } else if (zone === 'premium') {
    score -= 1;
    reasons.push('Price in premium (favor shorts)');
  } else {
    reasons.push('Price near equilibrium');
  }

  const direction: Bias['direction'] = score >= 2 ? 'long' : score <= -2 ? 'short' : 'neutral';
  return { direction, premiumDiscount: zone, reasons };
}
