// Builds the market brief the LLM advisor reads — a compact, structured summary
// of multi-timeframe structure, the green/red lines, stacked liquidity, VWAP and
// recent price action. The advisor never sees raw candles; it reasons off this.

import type { Candle } from '../types.js';
import { readStructure } from '../strategy/structure.js';
import { buildMtfLiquidityMap } from '../strategy/mtfLiquidity.js';
import { computeVwap, todaysCandles } from '../strategy/vwap.js';
import { analyzeCandle } from '../strategy/candles.js';

export interface AdvisorSnapshot {
  symbol: string;
  d1: Candle[];
  h4: Candle[];
  h1: Candle[];
  m15: Candle[];
  m1: Candle[];
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;

function structLine(name: string, c: Candle[], lb = 2): string {
  if (c.length < lb * 2 + 4) return `${name}: (insufficient history)`;
  const s = readStructure(c, lb);
  const g = s.lastSwingLow?.price;
  const r = s.lastSwingHigh?.price;
  const px = c.at(-1)!.close;
  const parts = [`${name}: ${s.trend}`, s.label];
  if (g != null) parts.push(`green(HL)=${g.toFixed(2)} [${pct(px, g).toFixed(2)}% away]`);
  if (r != null) parts.push(`red(SH)=${r.toFixed(2)} [${pct(px, r).toFixed(2)}% away]`);
  if (g != null && r != null) parts.push(`range=${pct(r, g).toFixed(1)}%`);
  return parts.join('  ·  ');
}

export function buildContext(snap: AdvisorSnapshot): string {
  const { d1, h4, h1, m15, m1 } = snap;
  const px = m1.at(-1)?.close ?? m15.at(-1)!.close;
  const lines: string[] = [];

  lines.push(`SYMBOL ${snap.symbol}   PRICE ${px.toFixed(2)}   ${new Date(m1.at(-1)?.time ?? Date.now()).toISOString()}`);
  lines.push('');
  lines.push('STRUCTURE (confirmed swings, no repaint):');
  lines.push('  ' + structLine('1D ', d1));
  lines.push('  ' + structLine('4H ', h4));
  lines.push('  ' + structLine('1H ', h1));
  lines.push('  ' + structLine('15M', m15));

  // Stacked liquidity map.
  const map = buildMtfLiquidityMap(
    [
      { label: '1D', weight: 5, candles: d1, fractal: 2 },
      { label: '4H', weight: 3, candles: h4, fractal: 2 },
      { label: '1H', weight: 2, candles: h1, fractal: 2 },
      { label: '15M', weight: 1, candles: m15, fractal: 2 },
    ],
    px,
  );
  lines.push('');
  lines.push('STACKED LIQUIDITY (price magnets / walls, nearest first):');
  lines.push('  above: ' + (map.above.slice(0, 4).map((p) => `${p.price.toFixed(2)} (${p.distancePct}%, str ${p.strength}, ${p.tfs.join('+')})`).join('  |  ') || 'none'));
  lines.push('  below: ' + (map.below.slice(0, 4).map((p) => `${p.price.toFixed(2)} (${p.distancePct}%, str ${p.strength}, ${p.tfs.join('+')})`).join('  |  ') || 'none'));

  // VWAP.
  const sess = todaysCandles(m15);
  if (sess.length > 2) {
    const v = computeVwap(sess);
    const posv = px > v.vwap ? 'above' : 'below';
    lines.push('');
    lines.push(`VWAP (session): ${v.vwap.toFixed(2)} — price ${posv}  ·  bands ${v.lower.toFixed(2)} / ${v.upper.toFixed(2)}`);
  }

  // Recent sweep of the 4H structure lines.
  const s4 = readStructure(h4, 2);
  if (s4.lastSwingLow && s4.lastSwingHigh) {
    const tail = m15.slice(-24);
    const sweptLow = tail.some((c) => c.low < s4.lastSwingLow!.price) && px > s4.lastSwingLow!.price;
    const sweptHigh = tail.some((c) => c.high > s4.lastSwingHigh!.price) && px < s4.lastSwingHigh!.price;
    lines.push('');
    lines.push(`RECENT SWEEP (last 6h of 15M): 4H green ${sweptLow ? 'PIERCED then reclaimed' : 'held'}  ·  4H red ${sweptHigh ? 'PIERCED then rejected' : 'held'}`);
  }

  // Last 10 15M candles.
  const avgVol = m15.slice(-30).reduce((s, c) => s + c.volume, 0) / Math.min(30, m15.length);
  lines.push('');
  lines.push('LAST 10 × 15M (O/H/L/C, vol×avg, body):');
  for (const c of m15.slice(-10)) {
    const a = analyzeCandle(c);
    const t = new Date(c.time).toISOString().slice(11, 16);
    lines.push(
      `  ${t}  ${c.open.toFixed(1)}/${c.high.toFixed(1)}/${c.low.toFixed(1)}/${c.close.toFixed(1)}  ` +
        `${(c.volume / (avgVol || 1)).toFixed(1)}×  ${a.bullish ? 'bull' : a.bearish ? 'bear' : 'doji'} ${a.strength}${a.rejection ? ` rej-${a.rejection}` : ''}`,
    );
  }

  return lines.join('\n');
}
