// Coach Jaz's TAD method for CRYPTO — the version he states explicitly in the
// "Modern Wealth Academy" podcast (YouTube _OGdOF6jLYs).
//
// His Forex "4C" (zone + arrow + out-of-band + RSI cross, TP1 mid band / TP2
// outer band, no stop, re-enter at the next zone) is a RANGE scalp. For crypto
// he says: "go to the 4-hour chart. Every time there is a GREEN ARROW that is
// OUT OF THE BAND — just buy. Like a monthly saving. About twice a month. If
// the price is similar to a recent green arrow, don't enter. You end up buying
// almost all the lows." It's long-only accumulation, HOLD (never sell).
//
//   npx tsx src/backtest/runTadBuy.ts [--tf 4h] [--years 3]
//
// Proxies for his (closed-source) indicator:
//   "out of the band" = close below EMA(emaLen) − bandK · stdev(emaLen)
//                       ("a stretched moving average", not Bollinger)
//   "green arrow"      = momentum turning up: RSI(ohlc4, rsiLen) crosses up
//                       through its SMA  AND  this close > previous close
//   cooldown so entries land ~2×/month and skips a re-buy near a recent price.
//
// Compares: TAD-buy accumulation vs. same-cash weekly DCA vs. lump-sum hold.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const COST = 7 / 10_000;

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TF = arg('tf', '4h');
const YEARS = Number(arg('years', '3'));
const BUY_USD = 100; // cash added per TAD buy signal
const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000 };

interface Params { emaLen: number; bandK: number; rsiLen: number; rsiMaLen: number; cooldownBars: number; nearPct: number; armBars: number; }
const BASE: Params = {
  emaLen: Number(arg('ema', '50')), bandK: Number(arg('k', '1')),
  rsiLen: Number(arg('rsi', '14')), rsiMaLen: 14,
  cooldownBars: Number(arg('cd', '18')), nearPct: 3, armBars: Number(arg('arm', '6')),
};

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const step = TF_MS[TF];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - YEARS * 365 * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${symbol}&interval=${TF}&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) byTime.set(Number(r[0]), { time: Number(r[0]), open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ema(v: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const o: number[] = [];
  let p = v[0];
  for (let i = 0; i < v.length; i++) { p = i === 0 ? v[0] : v[i] * k + p * (1 - k); o.push(p); }
  return o;
}
function rsi(v: number[], len: number): number[] {
  const out = new Array(v.length).fill(50);
  if (v.length < len + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (len - 1) + (d > 0 ? d : 0)) / len;
    l = (l * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
const ohlc4 = (c: Candle[]) => c.map((b) => (b.open + b.high + b.low + b.close) / 4);
const sma = (v: number[], i: number, len: number) => { const s = Math.max(0, i - len + 1); let a = 0; for (let j = s; j <= i; j++) a += v[j]; return a / (i - s + 1); };
const stdev = (v: number[], i: number, len: number, m: number) => { const s = Math.max(0, i - len + 1); let a = 0; for (let j = s; j <= i; j++) a += (v[j] - m) ** 2; return Math.sqrt(a / (i - s + 1)); };

interface Buy { time: number; price: number; }
function tadBuys(c: Candle[], p: Params): Buy[] {
  const close = c.map((x) => x.close);
  const e = ema(close, p.emaLen);
  const r = rsi(ohlc4(c), p.rsiLen);
  const rMa = r.map((_, i) => sma(r, i, p.rsiMaLen));
  const buys: Buy[] = [];
  let lastBar = -1e9;
  let armedAt = -1e9;
  for (let i = p.emaLen + 2; i < c.length; i++) {
    const lowerBand = e[i] - p.bandK * stdev(close, i, p.emaLen, e[i]);
    if (close[i] < lowerBand) armedAt = i; // price is "out of the band"
    if (i - armedAt > p.armBars) continue; // arrow must come while still stretched
    const arrowUp = r[i - 1] <= rMa[i - 1] && r[i] > rMa[i] && close[i] > close[i - 1];
    if (!arrowUp) continue;
    if (i - lastBar < p.cooldownBars) continue;
    if (buys.length && Math.abs(close[i] - buys[buys.length - 1].price) / buys[buys.length - 1].price < p.nearPct / 100) { lastBar = i; continue; }
    buys.push({ time: c[i].time, price: close[i] });
    lastBar = i;
  }
  return buys;
}

/** Accumulate: add BUY_USD at each buy, hold to the end. */
function accumulate(buys: Buy[], endPrice: number) {
  let coins = 0, invested = 0;
  for (const b of buys) { const eff = b.price * (1 + COST); coins += BUY_USD / eff; invested += BUY_USD; }
  const value = coins * endPrice;
  const avgCost = invested / (coins || 1);
  return { n: buys.length, invested, value, avgCost, roi: invested ? (value / invested - 1) * 100 : 0 };
}

/** Weekly DCA with the SAME total cash, spread evenly. */
function weeklyDca(c: Candle[], totalCash: number, endPrice: number) {
  const weeks: Candle[] = [];
  let lastW = -1;
  for (const bar of c) { const w = Math.floor(bar.time / (7 * 86_400_000)); if (w !== lastW) { weeks.push(bar); lastW = w; } }
  const per = totalCash / weeks.length;
  let coins = 0;
  for (const w of weeks) coins += per / (w.close * (1 + COST));
  return { n: weeks.length, invested: totalCash, value: coins * endPrice, roi: (coins * endPrice / totalCash - 1) * 100 };
}

async function main() {
  console.log(`\nTAD "buy the green arrow out of the band, hold" — CRYPTO version · ${TF} · ${YEARS}y · 7bps/buy`);
  console.log(`band: close < EMA${BASE.emaLen} − ${BASE.bandK}σ · arrow: RSI(ohlc4,${BASE.rsiLen})↑ its MA + up close · ~cooldown ${BASE.cooldownBars} bars\n`);

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} …`);
    const c = await fetchKlines(sym);
    const endPx = c[c.length - 1].close;
    const startPx = c[0].close;
    const buys = tadBuys(c, BASE);
    const span = (c[c.length - 1].time - c[0].time) / (365.25 * 86_400_000);
    const acc = accumulate(buys, endPx);
    const dca = weeklyDca(c, acc.invested || 100, endPx);
    // lump sum: same total cash all at the start
    const lumpCoins = (acc.invested || 100) / (startPx * (1 + COST));
    const lump = { value: lumpCoins * endPx, roi: (lumpCoins * endPx / (acc.invested || 100) - 1) * 100 };
    const bh = endPx / startPx;

    console.log(` ${c.length} bars · ${new Date(c[0].time).toISOString().slice(0, 10)}→${new Date(c[c.length - 1].time).toISOString().slice(0, 10)} (${span.toFixed(1)}y) · buy&hold ${bh.toFixed(1)}x`);
    console.log(`  ${sym.replace('USDT', '')}  ${acc.n} TAD buys (${(acc.n / span / 12).toFixed(1)}/mo)  avg entry $${acc.avgCost.toFixed(0)}  vs period avg $${(c.reduce((s, x) => s + x.close, 0) / c.length).toFixed(0)}`);
    console.log(`     TAD accumulate : invested $${acc.invested.toFixed(0)} → $${acc.value.toFixed(0)}  (ROI ${acc.roi.toFixed(0)}%)`);
    console.log(`     weekly DCA     : invested $${dca.invested.toFixed(0)} → $${dca.value.toFixed(0)}  (ROI ${dca.roi.toFixed(0)}%)`);
    console.log(`     lump sum @ t0  : invested $${(acc.invested || 100).toFixed(0)} → $${lump.value.toFixed(0)}  (ROI ${lump.roi.toFixed(0)}%)`);
    console.log();
  }
  console.log(`Read: does timing buys on the TAD signal beat mindless weekly DCA on the same cash?\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
