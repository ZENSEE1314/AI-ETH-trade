// LLM trade advisor — CLI.
//
//   npm run advisor                       # live: pull ETH from Binance, ask now
//   npm run advisor -- --at 2026-07-20T05:00Z   # replay: ask as of a past time
//   npm run advisor -- --file data/eth-1m-90d.json --at 2026-07-20T05:00Z
//   npm run advisor -- --model meta-llama/llama-3.3-70b-instruct:free
//   npm run advisor -- --provider anthropic --model claude-sonnet-5
//
// Needs OPENROUTER_API_KEY (free models, default) or ANTHROPIC_API_KEY in .env.

import { readFile } from 'node:fs/promises';
import type { Candle } from '../types.js';
import { config } from '../config.js';
import { fetchBinanceKlines } from '../backtest/fetchBinance.js';
import { resample } from '../backtest/resample.js';
import { buildContext } from './context.js';
import { askAdvisor } from './advisor.js';

function flag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function loadM1(): Promise<Candle[]> {
  const file = flag('--file');
  if (file) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed as Candle[];
  }
  const symbol = flag('--symbol', config.symbol)!;
  process.stderr.write(`Fetching 60d of ${symbol} 1m from Binance…\n`);
  return fetchBinanceKlines(symbol, 60);
}

async function main() {
  const m1all = await loadM1();
  const atArg = flag('--at');
  const cutoff = atArg ? Date.parse(atArg) : Infinity;
  const m1 = m1all.filter((c) => c.time <= cutoff);
  if (m1.length < 2000) {
    console.error(`Only ${m1.length} 1m candles up to the cutoff — need more history.`);
    process.exit(1);
  }
  // Bound the tail so higher-TF resampling stays cheap but daily still has depth.
  const tail = m1.slice(-90_000);

  const snap = {
    symbol: config.symbol,
    d1: resample(tail, 1440).slice(-60),
    h4: resample(tail, 240).slice(-120),
    h1: resample(tail, 60).slice(-250),
    m15: resample(tail, 15).slice(-200),
    m1: tail.slice(-250),
  };

  const context = await buildContext(snap);
  console.log('\n' + context + '\n');
  console.log('─'.repeat(70));
  process.stderr.write('Asking the advisor…\n');

  const rec = await askAdvisor(context, {
    model: flag('--model'),
    provider: flag('--provider') as 'gemini' | 'openrouter' | 'anthropic' | 'local' | undefined,
  });

  const badge = rec.verdict === 'wait' ? 'WAIT' : rec.verdict.toUpperCase();
  console.log(`\n  VERDICT: ${badge}   confidence ${rec.confidence}/100   [${rec.model}]`);
  if (rec.verdict !== 'wait') {
    console.log(`  entry ${rec.entry}   stop ${rec.stopLoss}   target ${rec.takeProfit}   R:R ${rec.riskReward}`);
  }
  console.log(`\n  ${rec.reasoning}`);
  if (rec.warnings.length) {
    console.log('\n  warnings:');
    for (const w of rec.warnings) console.log(`   · ${w}`);
  }
  console.log('\n  (decision support only — paper-trade first)\n');
  // Force a clean exit here — tsx + undici + Windows libuv asserts on teardown
  // if we let the event loop drain naturally after fetch().
  process.exit(0);
}

main().catch((err) => {
  console.error('advisor failed:', (err as Error).message);
  process.exit(1);
});
