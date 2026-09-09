// TAD system — time-of-day analysis. Which UTC hour to enter for the best win
// rate / cleanest R, on the intraday timeframes.
//
//   npx tsx src/backtest/runTadHours.ts [--dir ls|l] [--tf 1h,30m,15m,1m]
//
// For each timeframe it runs the TAD breakout across BTC+ETH+BNB, buckets every
// trade by the UTC hour of its entry bar, and reports n / WR% / avgR / totalR /
// profit-factor per hour. Data: Binance spot mirror (data-api.binance.vision).
// Lookback is capped per timeframe so a run finishes.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DIR = arg('dir', 'ls'); // 'l' long-only, 's' short-only, 'ls' both
const TFS = arg('tf', '1h,30m,15m,1m').split(',');
const COST = 7 / 10_000;

const DON_ENTRY = 20, DON_EXIT = 10, BB_LEN = 20, BB_SD = 1.0, EMA_LEN = 50, VOL_LEN = 20;
const HARD_STOP_PCT = 5;

const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };
const CAP_DAYS: Record<string, number> = { '1m': 180, '5m': 365, '15m': 730, '30m': 1095, '1h': 1825, '2h': 1825, '4h': 2555 };

async function fetchAll(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - (CAP_DAYS[tf] ?? 365) * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${tf}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r[0]);
      byTime.set(t, { time: t, open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    }
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ema(vals: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
const sma = (v: number[], i: number, len: number) => { if (i < len - 1) return NaN; let s = 0; for (let j = i - len + 1; j <= i; j++) s += v[j]; return s / len; };
const std = (v: number[], i: number, len: number, m: number) => { let s = 0; for (let j = i - len + 1; j <= i; j++) s += (v[j] - m) ** 2; return Math.sqrt(s / len); };
const hh = (c: Candle[], a: number, b: number) => { let m = -Infinity; for (let j = a; j <= b; j++) m = Math.max(m, c[j].high); return m; };
const ll = (c: Candle[], a: number, b: number) => { let m = Infinity; for (let j = a; j <= b; j++) m = Math.min(m, c[j].low); return m; };

interface Trade { hour: number; rMultiple: number; pctReturn: number; }

function backtest(c: Candle[], allowLong: boolean, allowShort: boolean): Trade[] {
  const closes = c.map((x) => x.close);
  const vols = c.map((x) => x.volume);
  const ema50 = ema(closes, EMA_LEN);
  const trades: Trade[] = [];
  let pos: null | { side: 'long' | 'short'; entry: number; entryIdx: number; stop: number; init: number } = null;

  const longBreak = (i: number) => {
    const donHi = hh(c, i - DON_ENTRY, i - 1);
    const mid = sma(closes, i, BB_LEN);
    return closes[i] > donHi && closes[i] > mid + BB_SD * std(closes, i, BB_LEN, mid) && closes[i] > ema50[i];
  };
  const shortBreak = (i: number) => {
    const donLo = ll(c, i - DON_ENTRY, i - 1);
    const mid = sma(closes, i, BB_LEN);
    return closes[i] < donLo && closes[i] < mid - BB_SD * std(closes, i, BB_LEN, mid) && closes[i] < ema50[i];
  };

  for (let i = Math.max(DON_ENTRY, EMA_LEN, BB_LEN, VOL_LEN) + 2; i < c.length; i++) {
    const bar = c[i];
    if (pos) {
      const trail = pos.side === 'long' ? ll(c, i - DON_EXIT, i - 1) : hh(c, i - DON_EXIT, i - 1);
      pos.stop = pos.side === 'long' ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
      const hardFloor = pos.side === 'long' ? pos.entry * (1 - HARD_STOP_PCT / 100) : pos.entry * (1 + HARD_STOP_PCT / 100);
      const eff = pos.side === 'long' ? Math.max(pos.stop, hardFloor) : Math.min(pos.stop, hardFloor);
      const hit = pos.side === 'long' ? bar.low <= eff : bar.high >= eff;
      if (hit) {
        const dir = pos.side === 'long' ? 1 : -1;
        const net = dir * (eff - pos.entry) / pos.entry - 2 * COST;
        const risk = Math.abs(pos.entry - pos.init) / pos.entry || 0.02;
        trades.push({ hour: new Date(c[pos.entryIdx].time).getUTCHours(), rMultiple: net / risk, pctReturn: net });
        pos = null;
      } else continue;
    }
    if (pos || Number.isNaN(sma(vols, i, VOL_LEN))) continue;
    if (vols[i] <= sma(vols, i, VOL_LEN)) continue;
    let side: 'long' | 'short' | null = null;
    if (allowLong && longBreak(i) && !longBreak(i - 1)) side = 'long';
    else if (allowShort && shortBreak(i) && !shortBreak(i - 1)) side = 'short';
    if (!side) continue;
    const init = side === 'long' ? ll(c, i - DON_EXIT + 1, i) : hh(c, i - DON_EXIT + 1, i);
    const hardFloor = side === 'long' ? c[i].close * (1 - HARD_STOP_PCT / 100) : c[i].close * (1 + HARD_STOP_PCT / 100);
    pos = { side, entry: c[i].close, entryIdx: i, stop: init, init: side === 'long' ? Math.max(init, hardFloor) : Math.min(init, hardFloor) };
  }
  return trades;
}

function main() {
  return (async () => {
    console.log(`\nTAD time-of-day — dir ${DIR} · BTC+ETH+BNB · trail Donchian-10 + hard 5% · 7bps/side`);
    console.log(`entry-hour buckets are UTC. "risk-free" ≈ high WR + positive avgR + shallow worst streak.\n`);
    const allowLong = DIR.includes('l');
    const allowShort = DIR.includes('s');

    for (const tf of TFS) {
      const all: Trade[] = [];
      let span = '';
      for (const sym of SYMBOLS) {
        process.stdout.write(`  ${sym} ${tf} …`);
        const bars = await fetchAll(sym, tf);
        const tr = backtest(bars, allowLong, allowShort);
        all.push(...tr);
        span = `${new Date(bars[0].time).toISOString().slice(0, 10)}→${new Date(bars.at(-1)!.time).toISOString().slice(0, 10)}`;
        console.log(` ${bars.length} bars, ${tr.length} trades`);
      }
      console.log(`\n══ ${tf}  (${span}, ${all.length} trades across 3 coins) ══`);
      console.log(`  hr    n    WR%    avgR   totalR    PF`);
      const byHour = new Map<number, Trade[]>();
      for (let h = 0; h < 24; h++) byHour.set(h, []);
      for (const t of all) byHour.get(t.hour)!.push(t);
      const rows: { h: number; n: number; wr: number; avgR: number; totR: number; pf: number }[] = [];
      for (let h = 0; h < 24; h++) {
        const g = byHour.get(h)!;
        if (!g.length) { rows.push({ h, n: 0, wr: 0, avgR: 0, totR: 0, pf: 0 }); continue; }
        const w = g.filter((t) => t.pctReturn > 0).length;
        const totR = g.reduce((s, t) => s + t.rMultiple, 0);
        const gW = g.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
        const gL = -g.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);
        rows.push({ h, n: g.length, wr: w / g.length * 100, avgR: totR / g.length, totR, pf: gL > 0 ? gW / gL : 99 });
      }
      for (const r of rows) {
        const bar = r.n ? '█'.repeat(Math.round(r.wr / 5)) : '';
        const mark = r.n >= 8 && r.wr >= 45 && r.avgR > 0 ? '  ★' : r.n >= 8 && r.wr >= 40 && r.avgR > 0 ? '  ·' : '';
        console.log(
          `  ${String(r.h).padStart(2)}  ${String(r.n).padStart(3)}  ${r.n ? r.wr.toFixed(0).padStart(4) : '  -'}  ${r.n ? r.avgR.toFixed(2).padStart(6) : '     -'}  ${r.n ? r.totR.toFixed(1).padStart(7) : '      -'}  ${r.n ? (r.pf === 99 ? '  ∞' : r.pf.toFixed(2).padStart(4)) : '   -'}  ${bar}${mark}`,
        );
      }
      const best = rows.filter((r) => r.n >= 8).sort((a, b) => b.wr - a.wr).slice(0, 5);
      const worst = rows.filter((r) => r.n >= 8).sort((a, b) => a.wr - b.wr).slice(0, 5);
      console.log(`  best hours (n≥8):  ${best.map((r) => `${r.h}h ${r.wr.toFixed(0)}%/${r.avgR.toFixed(2)}R`).join('  ')}`);
      console.log(`  worst hours:       ${worst.map((r) => `${r.h}h ${r.wr.toFixed(0)}%/${r.avgR.toFixed(2)}R`).join('  ')}`);
      const overall = all.length ? all.filter((t) => t.pctReturn > 0).length / all.length * 100 : 0;
      console.log(`  ALL hours WR: ${overall.toFixed(1)}%  ·  totalR ${all.reduce((s, t) => s + t.rMultiple, 0).toFixed(0)}`);

      // Whitelist sim: only the hours that were positive in-sample (WARNING:
      // that makes this in-sample — expect the live edge to be weaker).
      const WL: Record<string, number[]> = { '1h': [3, 10, 12, 13, 15, 16], '2h': [2, 6, 12, 16, 18] };
      const wl = WL[tf];
      if (wl) {
        const kept = all.filter((t) => wl.includes(t.hour)).sort(() => 0);
        const w = kept.filter((t) => t.pctReturn > 0).length;
        const totR = kept.reduce((s, t) => s + t.rMultiple, 0);
        // $1000, 10% margin @ 10x, compounding, sequential
        let eq = 1000;
        for (const t of kept) eq += eq * 0.1 * 10 * t.pctReturn;
        console.log(
          `  WHITELIST hours [${wl.join(',')}]: ${kept.length} trades · WR ${(w / kept.length * 100).toFixed(1)}% · totalR ${totR.toFixed(0)} · $1000→$${eq.toFixed(0)} (10%/10x, in-sample)`,
        );
      }
      console.log();
    }
  })();
}

main().catch((e) => { console.error(e); process.exit(1); });
