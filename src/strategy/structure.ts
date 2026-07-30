// Market structure: swing points, HH/HL/LH/LL, BOS, CHoCH.

import type { Candle, StructureState, Swing } from '../types.js';

/**
 * Detect swing highs/lows using a symmetric fractal of width `lookback`.
 * A swing high is a candle whose high is >= the `lookback` candles on each side.
 */
export function findSwings(candles: Candle[], lookback = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, kind: 'high' });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, kind: 'low' });
  }
  return swings;
}

/**
 * Read market structure from candles: classify the last swings as HH/HL/LH/LL,
 * infer trend, and flag Break of Structure (BOS) and Change of Character (CHoCH).
 */
export function readStructure(candles: Candle[], lookback = 2): StructureState {
  const swings = findSwings(candles, lookback);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');

  const lastSwingHigh = highs.at(-1) ?? null;
  const lastSwingLow = lows.at(-1) ?? null;

  if (highs.length < 2 || lows.length < 2) {
    return {
      trend: 'ranging',
      lastSwingHigh,
      lastSwingLow,
      bos: false,
      choch: false,
      label: 'insufficient structure',
    };
  }

  const hh = highs.at(-1)!.price > highs.at(-2)!.price; // higher high
  const hl = lows.at(-1)!.price > lows.at(-2)!.price; // higher low
  const lh = highs.at(-1)!.price < highs.at(-2)!.price; // lower high
  const ll = lows.at(-1)!.price < lows.at(-2)!.price; // lower low

  let trend: StructureState['trend'] = 'ranging';
  if (hh && hl) trend = 'bullish';
  else if (lh && ll) trend = 'bearish';

  const close = candles.at(-1)!.close;

  // BOS: price breaks the most recent swing in the direction of the trend.
  // CHoCH: price breaks a swing against the prevailing trend (reversal warning).
  let bos = false;
  let choch = false;

  if (trend === 'bullish' && lastSwingHigh && close > lastSwingHigh.price) bos = true;
  if (trend === 'bearish' && lastSwingLow && close < lastSwingLow.price) bos = true;

  if (trend === 'bullish' && lastSwingLow && close < lastSwingLow.price) choch = true;
  if (trend === 'bearish' && lastSwingHigh && close > lastSwingHigh.price) choch = true;
  // A range that just broke its last opposing swing is also a character change.
  if (trend === 'ranging') {
    if (lastSwingHigh && close > lastSwingHigh.price) choch = true;
    if (lastSwingLow && close < lastSwingLow.price) choch = true;
  }

  const parts: string[] = [];
  if (hh) parts.push('HH');
  if (hl) parts.push('HL');
  if (lh) parts.push('LH');
  if (ll) parts.push('LL');
  const label =
    `${parts.join('-') || 'range'} ${trend}` +
    (bos ? ', BOS' : '') +
    (choch ? ', CHoCH' : '');

  return { trend, lastSwingHigh, lastSwingLow, bos, choch, label };
}
