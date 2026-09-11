// THE setup — exactly as the user trades it, backtested end to end.
//
//   Entry : a candle CLOSES fully outside the NW band, then RSI(ohlc4, 14)
//           crosses back through its SMA(14) toward the mean (within armBars).
//           LONG below the lower band, SHORT above the upper band.
//   Stop  : 0.5% from entry.
//   TP1   : the NW middle line (smoother) — bank 50%, stop to breakeven.
//   TP2   : the opposite outer band — close the rest.
//   Exit  : else time-stop after maxBars (mark to market).
//
//   npx tsx src/backtest/runSetup.ts [--tf 1h] [--years 3] [--stop 0.5] [--rsi 14]
//
// Reports WR, profit factor, expectancy, avg win/loss R, worst losing streak,
// $1000 outcome at 1x/3x/5x/10x, and a month-by-month table.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const COST = 7 / 10_000;
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SYMS = (arg('syms', 'BTCUSDT,ETHUSDT,BNBUSDT')).split(',');
const TF = arg('tf', '1h');
const YEARS = Number(arg('years', '3'));
const STOP_PCT = Number(arg('stop', '0.5'));
const RSI_LEN = Number(arg('rsi', '14'));
const RSI_MA = Number(arg('rsima', '14'));
const NOSL = process.argv.includes('--nosl');
const TOUCH = process.argv.includes('--touch');
const SAMEBAR = process.argv.includes('--samebar'); // enter on the SAME bar as the band touch, no multi-bar wait
const REBOUND = process.argv.includes('--rebound'); // no RSI wait: touch the band + this candle already closes back the right way
const NEXTBAR = process.argv.includes('--nextbar'); // touch bar, then wait for the FOLLOWING candle to close green/red, enter there
const H = 8, MULT = 3, MAE_LEN = 100, ARM = 6;
const MAX_BARS = NOSL ? Number(arg('hold', '240')) : 48; // no-stop → hold longer ("price comes back")
const TF_MS: Record<string, number> = { '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };

async function fetchK(sym: string): Promise<Candle[]> {
  const step = TF_MS[TF];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - (YEARS * 365 + 20) * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${sym}&interval=${TF}&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
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
function nwCausal(cl: number[]): number[] {
  const out = new Array(cl.length).fill(0);
  const span = Math.ceil(H * 3);
  for (let i = 0; i < cl.length; i++) { let num = 0, den = 0; for (let j = Math.max(0, i - span); j <= i; j++) { const w = Math.exp(-((i - j) ** 2) / (2 * H * H)); num += cl[j] * w; den += w; } out[i] = num / den; }
  return out;
}
function rsiS(v: number[], len: number): number[] {
  const out = new Array(v.length).fill(50);
  if (v.length < len + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len; out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (len - 1) + (d > 0 ? d : 0)) / len; l = (l * (len - 1) + (d < 0 ? -d : 0)) / len; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
const ohlc4 = (c: Candle[]) => c.map((b) => (b.open + b.high + b.low + b.close) / 4);
const sma = (v: number[], i: number, len: number) => { const s = Math.max(0, i - len + 1); let a = 0; for (let j = s; j <= i; j++) a += v[j]; return a / (i - s + 1); };

interface Trade { sym: string; time: number; side: 'long' | 'short'; entry: number; rr: number; pctRet: number; reason: string; worstAdvPct: number; stop: number; exitPx: number; }

function run(c: Candle[], sym: string, slOverride?: number | null): Trade[] {
  const slPct: number = slOverride === undefined ? STOP_PCT : (slOverride ?? 0);
  const noStop = NOSL || slOverride === null;
  const cl = c.map((x) => x.close);
  const nw = nwCausal(cl);
  const rsi = rsiS(ohlc4(c), RSI_LEN);
  const rMa = rsi.map((_, i) => sma(rsi, i, RSI_MA));
  const mae = cl.map((_, i) => { const s = Math.max(0, i - MAE_LEN + 1); let a = 0; for (let j = s; j <= i; j++) a += Math.abs(cl[j] - nw[j]); return a / (i - s + 1); });
  const up = (i: number) => nw[i] + MULT * mae[i];
  const lo = (i: number) => nw[i] - MULT * mae[i];
  const out: Trade[] = [];
  let arm: { side: 'long' | 'short'; bar: number; extreme?: number } | null = null;

  for (let i = MAE_LEN + 5; i < c.length; i++) {
    const b = c[i];
    let side: 'long' | 'short' | null = null;

    let nextBarExtreme: number | undefined;
    if (NEXTBAR) {
      // touch bar arms it (tracking the extreme reached); the VERY NEXT candle
      // must close the right way (green after a low touch, red after a high
      // touch) to enter — one bar of confirmation, no RSI.
      if (!arm) {
        if (b.low <= lo(i)) arm = { side: 'long', bar: i, extreme: b.low };
        else if (b.high >= up(i)) arm = { side: 'short', bar: i, extreme: b.high };
        continue;
      }
      if (i === arm.bar + 1) {
        const ok = arm.side === 'long' ? b.close > b.open : b.close < b.open;
        nextBarExtreme = arm.extreme;
        const armedSide = arm.side;
        arm = null;
        if (!ok) continue;
        side = armedSide;
      } else { arm = null; continue; }
    } else if (REBOUND) {
      // no RSI wait: the wick pierces the band AND the candle already closes
      // back the right way (a reaction candle) — buy/sell immediately.
      const touchLong = b.low <= lo(i), touchShort = b.high >= up(i);
      if (touchLong && b.close > b.open) side = 'long';
      else if (touchShort && b.close < b.open) side = 'short';
      if (!side) continue;
    } else if (SAMEBAR) {
      // enter on THIS bar: it touches the band AND RSI crosses, both at once —
      // no waiting for a later confirmation bar (removes the entry lag).
      const touchLong = b.low <= lo(i), touchShort = b.high >= up(i);
      const crossUp = rsi[i - 1] <= rMa[i - 1] && rsi[i] > rMa[i];
      const crossDn = rsi[i - 1] >= rMa[i - 1] && rsi[i] < rMa[i];
      if (touchLong && crossUp) side = 'long';
      else if (touchShort && crossDn) side = 'short';
      if (!side) continue;
    } else {
      if (!arm) {
        // "on the edge": wick reaches the band (not necessarily a full close beyond it)
        if (TOUCH ? b.low <= lo(i) : b.close < lo(i)) arm = { side: 'long', bar: i };
        else if (TOUCH ? b.high >= up(i) : b.close > up(i)) arm = { side: 'short', bar: i };
        continue;
      }
      if (i - arm.bar > ARM) { arm = null; continue; }
      const cross = arm.side === 'long' ? rsi[i - 1] <= rMa[i - 1] && rsi[i] > rMa[i] : rsi[i - 1] >= rMa[i - 1] && rsi[i] < rMa[i];
      if (!cross) continue;
      side = arm.side; arm = null;
    }
    const entry = b.close;
    // REBOUND / NEXTBAR: "SL on the edge +10%" = the band level (or the actual
    // touched extreme), pushed slPct% further out.
    const edge = nextBarExtreme ?? (side === 'long' ? lo(i) : up(i));
    const stop = (REBOUND || NEXTBAR)
      ? (side === 'long' ? edge * (1 - slPct / 100) : edge * (1 + slPct / 100))
      : (side === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100));
    const risk = entry * (STOP_PCT / 100); // R unit stays 0.5% for comparability even with no stop
    const dir = side === 'long' ? 1 : -1;
    let banked = 0, remaining = 1, curStop = stop, tookTp1 = false, legs = 1, exitPx = entry, reason = 'timeout', tp1Px = entry;
    let worstAdvPct = 0;
    for (let k = i + 1; k < Math.min(c.length, i + 1 + MAX_BARS); k++) {
      const x = c[k];
      const adv = side === 'long' ? (entry - x.low) / entry * 100 : (x.high - entry) / entry * 100;
      if (adv > worstAdvPct) worstAdvPct = adv;
      const hitStop = !noStop && (side === 'long' ? x.low <= curStop : x.high >= curStop);
      if (hitStop) { banked += remaining * dir * (curStop - entry) / entry; remaining = 0; reason = tookTp1 ? 'be' : 'stop'; exitPx = curStop; break; }
      // no-stop mode still moves to breakeven after TP1
      if (noStop && tookTp1) { const be = side === 'long' ? x.low <= entry : x.high >= entry; if (be) { remaining = 0; reason = 'be'; exitPx = entry; break; } }
      if (!tookTp1) {
        const mid = nw[k];
        const hitMid = side === 'long' ? x.high >= mid : x.low <= mid;
        // TP1: bank 50% at the middle line, then the runner's stop = the TP1 price
        // (so if TP2 isn't reached, we exit at TP1 with the gain locked).
        if (hitMid) { banked += 0.5 * dir * (mid - entry) / entry; remaining -= 0.5; curStop = mid; tp1Px = mid; tookTp1 = true; legs++; reason = 'tp1'; exitPx = mid; continue; }
      } else {
        const band = side === 'long' ? up(k) : lo(k);
        const hitBand = side === 'long' ? x.high >= band : x.low <= band;
        if (hitBand) { banked += remaining * dir * (band - entry) / entry; remaining = 0; legs++; reason = 'tp2'; exitPx = band; break; }
      }
      exitPx = x.close;
    }
    if (remaining > 0) banked += remaining * dir * (exitPx - entry) / entry;
    const net = banked - legs * COST;
    out.push({ sym, time: b.time, side, entry, rr: net / (risk / entry), pctRet: net, reason, worstAdvPct, stop, exitPx });
  }
  return out;
}

function report(label: string, ts: Trade[], months: number) {
  const n = ts.length;
  if (!n) { console.log(`  ${label}: 0 trades`); return; }
  const w = ts.filter((t) => t.pctRet > 0);
  const lz = ts.filter((t) => t.pctRet <= 0);
  const gW = w.reduce((s, t) => s + t.rr, 0), gL = -lz.reduce((s, t) => s + t.rr, 0);
  const avgW = w.length ? gW / w.length : 0, avgL = lz.length ? -gL / lz.length : 0;
  const totR = ts.reduce((s, t) => s + t.rr, 0);
  const exp = totR / n;
  // worst losing streak
  let streak = 0, worst = 0;
  for (const t of ts) { if (t.pctRet <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0; }
  const tp1 = ts.filter((t) => t.reason === 'tp1').length, tp2 = ts.filter((t) => t.reason === 'tp2').length, stop = ts.filter((t) => t.reason === 'stop').length, be = ts.filter((t) => t.reason === 'be').length, to = ts.filter((t) => t.reason === 'timeout').length;
  const worstAdv = Math.max(...ts.map((t) => t.worstAdvPct));
  const worstLoss = Math.min(...ts.map((t) => t.pctRet)) * 100;
  // liquidation-aware equity: at 10x, a >~9.5% adverse excursion = liquidated (lose the 10% margin)
  const eq = (lev: number) => {
    let e = 1000;
    for (const t of ts) {
      const liqAt = 100 / lev - (lev >= 50 ? 0.5 : lev >= 10 ? 0.3 : 0.1);
      if (lev > 1 && t.worstAdvPct >= liqAt) { e -= e * 0.1; if (e < 0) return 0; continue; }
      e += e * 0.1 * lev * t.pctRet;
      if (e < 0) return 0;
    }
    return e;
  };
  console.log(`  ${label.padEnd(10)} n=${String(n).padStart(3)}  WR ${(w.length / n * 100).toFixed(0)}%  PF ${gL > 0 ? (gW / gL).toFixed(2) : '∞'}  exp ${exp.toFixed(2)}R  avgW +${avgW.toFixed(2)}R avgL ${avgL.toFixed(2)}R  streak ${worst}  (${tp1}tp1/${tp2}tp2/${be}be/${stop}stop/${to}timeout)`);
  console.log(`             worst adverse move ${worstAdv.toFixed(1)}%  ·  worst single trade ${worstLoss.toFixed(1)}%`);
  console.log(`             $1000 → 1x $${eq(1).toFixed(0)}  ·  3x $${eq(3).toFixed(0)}  ·  5x $${eq(5).toFixed(0)}  ·  10x $${eq(10).toFixed(0)}  ·  20x $${eq(20).toFixed(0)}  ·  50x $${eq(50).toFixed(0)}   (${((eq(5) - 1000) / months).toFixed(0)} $/mo at 5x)`);
}

function sweepSim(ts: Trade[], lev: number) {
  let eq = 1000, peak = 1000, dd = 0, liq = 0, wins = 0;
  const liqAt = 100 / lev - (lev >= 50 ? 0.5 : lev >= 10 ? 0.3 : 0.1);
  for (const t of ts) {
    if (lev > 1 && t.worstAdvPct >= liqAt) { eq -= eq * 0.1; liq++; }
    else { eq += eq * 0.1 * lev * t.pctRet; if (t.pctRet > 0) wins++; }
    if (eq < 0) eq = 0;
    peak = Math.max(peak, eq);
    if (peak > 0) dd = Math.max(dd, (peak - eq) / peak * 100);
    if (eq === 0) break;
  }
  return { eq, dd, liq, wins, n: ts.length };
}

async function main() {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMS) { process.stdout.write(`${s} …`); data[s] = await fetchK(s); console.log(` ${data[s].length} bars`); }

  if (process.argv.includes('--list')) {
    console.log(`\nEVERY TRADE — ${TF} · long only · ${SAMEBAR ? 'same-bar touch+cross' : 'arm+wait'} · ${STOP_PCT}% stop\n`);
    const all: Trade[] = [];
    for (const s of SYMS) all.push(...run(data[s], s));
    const long = all.filter((t) => t.side === 'long').sort((a, b) => a.time - b.time);
    console.log(`  date (UTC)         coin  entry      stop      exit    reason    R`);
    let totR = 0, wins = 0;
    for (const t of long) {
      totR += t.rr; if (t.pctRet > 0) wins++;
      const p = (n: number) => n >= 1000 ? n.toFixed(0) : n.toFixed(2);
      console.log(`  ${new Date(t.time).toISOString().slice(0, 16).replace('T', ' ')}  ${t.sym.padEnd(4)} ${p(t.entry).padStart(9)} ${p(t.stop).padStart(9)} ${p(t.exitPx).padStart(9)}  ${t.reason.padEnd(7)} ${(t.rr >= 0 ? '+' : '') + t.rr.toFixed(2)}`);
    }
    console.log(`\n  ${long.length} trades · ${wins} winners (${(wins / long.length * 100).toFixed(0)}% WR) · net ${totR.toFixed(1)}R\n`);
    return;
  }

  if (process.argv.includes('--sweep')) {
    console.log(`\nSL SWEEP — ${TF} · LONG only · close-outside-band + RSI(ohlc4,${RSI_LEN})×MA · BTC+ETH+BNB · ${YEARS}y`);
    console.log(`(worst single loss must stay < liquidation dist: 10x liq ≈ 9.5% · 20x ≈ 4.5% · 50x ≈ 1.5%)\n`);
    const SLS: (number | null)[] = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, null];
    console.log(`  SL      n   WR%   PF   exp    worstLoss   $1k→3x   $1k→5x   $1k→10x   $1k→20x   maxDD@5x`);
    for (const sl of SLS) {
      (globalThis as any).__SL = sl; // signal to run()
      const all: Trade[] = [];
      for (const s of SYMS) all.push(...run(data[s], s, sl));
      const long = all.filter((t) => t.side === 'long');
      if (!long.length) continue;
      const w = long.filter((t) => t.pctRet > 0).length;
      const gW = long.filter((t) => t.rr > 0).reduce((s, t) => s + t.rr, 0);
      const gL = -long.filter((t) => t.rr < 0).reduce((s, t) => s + t.rr, 0);
      const exp = long.reduce((s, t) => s + t.rr, 0) / long.length;
      const wl = Math.min(...long.map((t) => t.pctRet)) * 100;
      const f = (lev: number) => { const r = sweepSim(long, lev); return `$${r.eq.toFixed(0)}${r.liq ? `│${r.liq}L` : ''}`; };
      console.log(
        `  ${(sl === null ? 'none' : sl + '%').padEnd(6)} ${String(long.length).padStart(3)}  ${(w / long.length * 100).toFixed(0).padStart(3)}  ${(gL > 0 ? gW / gL : 99).toFixed(2)}  ${exp.toFixed(2).padStart(5)}  ${wl.toFixed(1).padStart(7)}%   ${f(3).padStart(7)}  ${f(5).padStart(7)}  ${f(10).padStart(8)}  ${f(20).padStart(8)}  ${sweepSim(long, 5).dd.toFixed(0)}%`,
      );
    }
    console.log(`\n  "│NL" = N liquidations. Pick the SL where worstLoss < your leverage's liq distance AND $ result is best.\n`);
    return;
  }

  console.log(`\nTHE SETUP — close outside NW band + RSI(ohlc4,${RSI_LEN})×MA(${RSI_MA}) cross · ${TF} · ${YEARS}y · ${STOP_PCT}% stop · TP1 mid / TP2 band`);
  const all: Trade[] = [];
  for (const s of SYMS) all.push(...run(data[s], s));
  all.sort((a, b) => a.time - b.time);
  const months = all.length ? (all[all.length - 1].time - all[0].time) / (30.44 * 86_400_000) : 1;
  console.log(`\n${all.length} total setups over ${months.toFixed(0)} months (${new Date(all[0].time).toISOString().slice(0, 10)} → ${new Date(all[all.length - 1].time).toISOString().slice(0, 10)})\n`);

  report('BOTH', all, months);
  report('LONG only', all.filter((t) => t.side === 'long'), months);
  report('SHORT only', all.filter((t) => t.side === 'short'), months);
  console.log(`\n  per coin (both sides):`);
  for (const s of SYMS) report(`  ${s.replace('USDT', '')}`, all.filter((t) => t.sym === s), months);

  // month-by-month (long only — the side the user trades)
  console.log(`\n  month-by-month (LONG only):`);
  const byM = new Map<string, Trade[]>();
  for (const t of all.filter((t) => t.side === 'long')) { const k = new Date(t.time).toISOString().slice(0, 7); if (!byM.has(k)) byM.set(k, []); byM.get(k)!.push(t); }
  for (const k of [...byM.keys()].sort()) {
    const g = byM.get(k)!;
    const w = g.filter((t) => t.pctRet > 0).length;
    const r = g.reduce((s, t) => s + t.rr, 0);
    console.log(`    ${k}  ${String(g.length).padStart(2)} trades  ${w}/${g.length} win  ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`);
  }
  console.log();
}
main().catch((e) => { console.error(e); process.exit(1); });
