// Session-open behaviour for BTC / ETH / BNB at the 3 major market opens (UTC):
//   Asia   00:00   ·   London 08:00   ·   New York 13:00
//
//   npx tsx src/backtest/runSessionOpen.ts [--days 365]
//
// For each session each day: the first 15m candle's range, whether it's a
// "manipulation candle" (range ≥ 25% Daily ATR), then over the next 8h —
// how far price travels (MFE/MAE in the fade direction) and how often it
// retraces to the 38.2% / 61.8% / 100% Fib of that candle. Ends with the
// actual Carl-style fade backtest per coin per session.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const MIN = 60_000;
const COST = 7 / 10_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const SESSIONS: [string, number][] = [['Asia', 0], ['London', 8], ['New York', 13]];

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg('days', '365'));
const ATR_FRAC = Number(arg('atrFrac', '0.25'));
const LOOK_BARS = 32; // 8h of 15m bars to observe the post-open move

async function fetch1m(symbol: string): Promise<Candle[]> {
  const cache = join(process.cwd(), 'data', `${symbol.toLowerCase()}-1m-${DAYS}d-tt.json`);
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, 'utf8')) as Candle[];
    if (c.length > 1000 && Date.now() - c[c.length - 1].time < 3 * 86_400_000) return c;
  }
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - DAYS * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${symbol}&interval=1m&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) byTime.set(Number(r[0]), { time: Number(r[0]), open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + MIN;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
async function fetchDaily(symbol: string): Promise<Candle[]> {
  const res = await fetch(`${MIRROR}?symbol=${symbol}&interval=1d&limit=1000`, { signal: AbortSignal.timeout(20_000) });
  return ((await res.json()) as unknown[][]).map((r) => ({ time: Number(r[0]), open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 }));
}
function atr14(daily: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  let atr = 0;
  for (let i = 1; i < daily.length; i++) {
    const tr = Math.max(daily[i].high - daily[i].low, Math.abs(daily[i].high - daily[i - 1].close), Math.abs(daily[i].low - daily[i - 1].close));
    if (i <= 14) atr += tr / 14; else atr = (atr * 13 + tr) / 14;
    if (i >= 14) out.set(Math.floor((daily[i].time + 86_400_000) / 86_400_000) * 86_400_000, atr);
  }
  return out;
}
const dayKey = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a: boolean[]) => (a.length ? a.filter(Boolean).length / a.length * 100 : 0);

async function main() {
  console.log(`\nSESSION-OPEN BEHAVIOUR — BTC / ETH / BNB · Asia 00:00 · London 08:00 · New York 13:00 UTC · ${DAYS}d`);
  console.log(`"manipulation candle" = first 15m range ≥ ${ATR_FRAC * 100}% of Daily ATR(14)\n`);

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} …`);
    const m1 = await fetch1m(sym);
    const daily = await fetchDaily(sym);
    const atrBy = atr14(daily);
    const byMin = new Map<number, Candle>();
    for (const c of m1) byMin.set(c.time, c);
    console.log(` ${m1.length} m1 bars`);

    for (const [name, oh] of SESSIONS) {
      const openMs = oh * 60 * MIN;
      const rangePctPx: number[] = [], rangePctAtr: number[] = [];
      let greens = 0, reds = 0, manip = 0, total = 0;
      const mfeFade: number[] = [], maeFade: number[] = [];
      const hit382: boolean[] = [], hit618: boolean[] = [], hit100: boolean[] = [], touched: boolean[] = [];
      // backtest accumulators
      let n = 0, wins = 0, tp = 0, sl = 0; let totR = 0; let eq = 1000;

      const first = dayKey(m1[0].time) + 86_400_000;
      const lastD = dayKey(m1[m1.length - 1].time);
      for (let d = first; d <= lastD; d += 86_400_000) {
        const openT = d + openMs;
        let hi = -Infinity, lo = Infinity, fo: number | null = null, lc = 0;
        for (let k = 0; k < 15; k++) { const c = byMin.get(openT + k * MIN); if (!c) continue; if (fo === null) fo = c.open; lc = c.close; hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); }
        if (fo === null || !isFinite(hi) || !isFinite(lo)) continue;
        const range = hi - lo;
        if (range <= 0) continue;
        total++;
        const atr = atrBy.get(dayKey(openT));
        rangePctPx.push((range / lc) * 100);
        if (atr) rangePctAtr.push((range / atr) * 100);
        const green = lc >= fo;
        green ? greens++ : reds++;
        const isManip = atr ? range >= ATR_FRAC * atr : false;
        if (!isManip) continue;
        manip++;

        // fade: green -> short from high, red -> long from low
        const side = green ? 'short' : 'long';
        const entry = green ? hi : lo;
        const dir = side === 'long' ? 1 : -1;
        const oppExtreme = green ? lo : hi;
        const f382 = green ? hi - 0.382 * range : lo + 0.382 * range;
        const f618 = green ? hi - 0.618 * range : lo + 0.618 * range;

        let mfe = 0, mae = 0, didTouch = false, h382 = false, h618 = false, h100 = false;
        let filled = false, exitR = 0, done = false;
        const tpDist = 0.618 * range; // use the 61.8% target for the trade
        const tpPx = green ? entry - tpDist : entry + tpDist;
        const slPx = green ? entry + tpDist / 2 : entry - tpDist / 2;
        for (let k = 15; k < 15 + LOOK_BARS && !done; k++) {
          const c = byMin.get(openT + k * MIN);
          if (!c) continue;
          // observational stats (fade direction favourable = toward oppExtreme)
          const fav = dir === 1 ? c.high - entry : entry - c.low; // won't be used pre-fill; track from open
          const favFromOpen = green ? entry - c.low : c.high - entry;
          if (favFromOpen > mfe) mfe = favFromOpen;
          const advFromOpen = green ? c.high - entry : entry - c.low;
          if (advFromOpen > mae) mae = advFromOpen;
          if ((green && c.low <= f382) || (!green && c.high >= f382)) h382 = true;
          if ((green && c.low <= f618) || (!green && c.high >= f618)) h618 = true;
          if ((green && c.low <= oppExtreme) || (!green && c.high >= oppExtreme)) h100 = true;
          // trade: touch & turn fill, then TP/SL
          if (!filled) {
            if ((side === 'long' && c.low <= entry) || (side === 'short' && c.high >= entry)) { filled = true; didTouch = true; }
          } else {
            const hitSl = side === 'long' ? c.low <= slPx : c.high >= slPx;
            const hitTp = side === 'long' ? c.high >= tpPx : c.low <= tpPx;
            if (hitSl) { exitR = -1; done = true; }
            else if (hitTp) { exitR = 2; done = true; }
          }
        }
        mfeFade.push((mfe / entry) * 100);
        maeFade.push((mae / entry) * 100);
        hit382.push(h382); hit618.push(h618); hit100.push(h100); touched.push(didTouch);
        if (filled) {
          n++;
          const rr = done ? exitR : 0; // timeout ~ flat
          totR += rr;
          const netPct = (rr === 2 ? tpDist : rr === -1 ? -tpDist / 2 : 0) / entry * dir * dir - 2 * COST;
          eq += eq * 0.1 * 10 * netPct;
          if (rr > 0) { wins++; tp++; } else if (rr < 0) sl++;
        }
      }

      console.log(`  ── ${sym.replace('USDT', '')} · ${name} open (${String(oh).padStart(2, '0')}:00 UTC) ──`);
      console.log(`     opening 15m range: median ${med(rangePctPx).toFixed(2)}% of price · ${med(rangePctAtr).toFixed(0)}% of Daily ATR · dir ${greens}/${total} green`);
      console.log(`     manipulation candle (≥${ATR_FRAC * 100}% ATR): ${manip}/${total} days (${(manip / total * 100).toFixed(0)}%)`);
      console.log(`     after a manip candle, over 8h: median move back ${med(mfeFade).toFixed(2)}% · median adverse ${med(maeFade).toFixed(2)}%`);
      console.log(`        retrace to 38.2% Fib: ${pct(hit382).toFixed(0)}% · to 61.8%: ${pct(hit618).toFixed(0)}% · full reversal (100%): ${pct(hit100).toFixed(0)}% · touched entry: ${pct(touched).toFixed(0)}%`);
      console.log(`     FADE trade (TP 61.8%, SL ½): ${n} trades · WR ${n ? (wins / n * 100).toFixed(0) : 0}% · totR ${totR.toFixed(0)} · $1000→ $${eq.toFixed(0)} (10x)`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
