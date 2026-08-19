# AI-ETH-trade 📈

An AI-assisted **ETH perpetual-futures** trading bot for **Bitunix**, built around a
Smart-Money-Concepts strategy and a strict risk core.

> **Core philosophy:** `Bias > Context > Liquidity > Market Structure > Timing > Execution > Risk Management`

**Paper trading is the default and cannot touch real funds.** Live execution only
runs when you supply your own Bitunix API keys *and* set `TRADING_MODE=live`.

---

## ⚠️ Read this first — the honest math

- **50x leverage liquidates on a ~2% move against you.** The engine refuses any
  setup whose stop sits beyond the liquidation price (see `src/risk/riskManager.ts`).
- **"2–50% per day" is a target, not an expectation.** No system compounds that
  reliably; chasing it is how accounts blow up. This bot is engineered to *protect
  a 3% daily-loss cap* first and let profit be a byproduct of good risk.
- This software is for research and education. **It is not financial advice**, and
  trading leveraged futures can lose your entire deposit.

---

## What it does

- **Multi-timeframe analysis** — 4H bias → 1H confirmation → 15M setup → 1M entry.
- **Draw on liquidity (4H)** — a 4H sweep of one side plus an untapped pool on the
  other sets the high-probability direction *and* the take-profit: the sweep picks
  the side, the opposing resting pool is where price is drawn
  (`src/strategy/drawOnLiquidity.ts`).
- **Smart Money Concepts** — market structure (BOS/CHoCH, HH/HL/LH/LL), liquidity
  (PDH/PDL/PWH/PWL, equal highs/lows, sweeps/stop-hunts), Fair Value Gaps,
  premium/discount, VWAP bands, Power of 3.
- **Sniper entry engine** — after the 4H draw, it steps down to the 15M reaction
  swing (HL long / LH short) to confirm the setup, then to the 1M reaction swing to
  time the trigger with a tight stop — only firing above a confluence threshold
  (`src/strategy/signal.ts`).
- **Risk core** — position sizing from stop distance, min R:R, per-trade risk cap,
  daily & weekly loss **kill switches**, leverage/liquidation guard.
- **TradingView webhook** — drive entries from your own Pine alerts.
- **Paper broker** — simulated fills, or live orders on Bitunix (opt-in).
- **Journal & dashboard** — win rate, expectancy, profit factor, drawdown, plus a
  full strategy "Playbook" tab mapping every concept to the code that implements it.

## Architecture

```
src/
  strategy/    candles · structure · liquidity · fvg · vwap · bias · signal
  risk/        riskManager (sizing, R:R, kill switches, liquidation guard)
  exchange/    bitunix (klines + live orders) · paperBroker (simulated fills)
  engine/      tradeEngine (orchestrator) · journal · marketData
  webhooks/    tradingview (alert parser)
  knowledge/   curriculum (the full playbook)
  server.ts    dashboard + JSON API + SSE + webhook
public/        dashboard UI
```

## Run locally

```bash
npm install
cp env.example .env    # edit values
npm run dev            # http://localhost:3000
```

Production build:

```bash
npm run build && npm start
```

## Backtesting

Measure how often the 1M-timed entries actually reach the draw (take-profit)
before the stop, on a 1-minute history the tool resamples up to 15M/1H/4H:

```bash
npm run backtest -- data/eth-1m.json        # replay a saved 1m history (JSON)
npm run backtest -- --fetch ETHUSDT 1000    # pull recent 1m from Bitunix
npm run backtest -- --demo                  # synthetic smoke test
```

It walks the history minute by minute with **no lookahead** (higher timeframes
are rebuilt only from candles seen so far), applies the same confluence / R:R
gates as the live engine (override with `--min-conf` / `--min-rr`), and reports
the reached-draw rate, win rate, expectancy in R, profit factor and max
drawdown — broken down by whether the 4H or 15M draw drove each trade. The 1m
JSON accepts either `{time,open,high,low,close,volume}` objects or
`[time,open,high,low,close,volume]` arrays.

## Accounts & the Settings page

The dashboard is gated by login. On first visit, `/login.html` lets you create the
**owner account** (the first registration is always allowed). After that, new
sign-ups require `REGISTRATION_CODE` — leave it blank to keep the app single-user.

Once signed in, the **Settings** tab lets you enter your **Bitunix API key &
secret** and tune trading params (mode, leverage, risk %, daily-loss cap,
confluence) without touching env vars. The secret is **encrypted at rest**
(AES-256-GCM) and never returned to the browser.

Persistence:
- Users and settings are stored as JSON under `DATA_DIR`.
- Set `APP_SECRET` to a long, stable random string so sessions and the encrypted
  API secret survive restarts.
- On Railway, **mount a volume** so `DATA_DIR` (`RAILWAY_VOLUME_MOUNT_PATH`)
  persists across redeploys — otherwise accounts reset on each deploy.

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `TRADING_MODE` | `paper` | `paper` = simulated, `live` = real Bitunix orders |
| `SYMBOL` | `ETHUSDT` | Trading pair |
| `ACCOUNT_EQUITY_USDT` | `1000` | Starting equity for sizing/paper PnL |
| `LEVERAGE` | `50` | Leverage used for margin & liquidation calc |
| `RISK_PER_TRADE_PCT` | `1.0` | % of equity risked per trade |
| `MAX_DAILY_LOSS_PCT` | `3.0` | Daily kill switch |
| `MAX_WEEKLY_LOSS_PCT` | `8.0` | Weekly kill switch |
| `MIN_RISK_REWARD` | `2.0` | Minimum R:R to take a trade |
| `MIN_CONFLUENCE` | `60` | Minimum signal score (0–100) |
| `ANALYSIS_INTERVAL_MS` | `60000` | Self-analysis poll interval (0 = off) |
| `WEBHOOK_SECRET` | — | Shared secret for TradingView alerts |
| `APP_SECRET` | — | Signs sessions + encrypts stored API secret (set a stable random string) |
| `REGISTRATION_CODE` | — | Code required for sign-ups after the owner account |
| `DATA_DIR` | `data` | Where users/settings persist (use a Railway volume) |
| `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` | — | Optional seed; usually set via the Settings page instead |

## TradingView integration

Point a TradingView alert (requires a paid TV plan for webhooks) at:

```
POST https://<your-app>/webhook/tradingview
```

with this JSON message:

```json
{
  "secret": "<WEBHOOK_SECRET>",
  "symbol": "ETHUSDT",
  "side": "long",
  "entry": {{close}},
  "stopLoss": 3450.0,
  "takeProfit": 3650.0,
  "confluence": 75
}
```

Every inbound alert still passes through the full risk core before any order.
The bot **also** analyses Bitunix klines itself on an interval, so it works with
or without TradingView.

## Deploy to Railway

Already wired via `railway.json` (build `npm run build`, start `npm start`,
health check `/healthz`). Set your env vars in the Railway service, then deploy.
Keep `TRADING_MODE=paper` until you've validated behaviour.

## Going live (do this carefully)

1. Validate on paper for a meaningful sample of trades; review the Journal tab.
2. Add `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` (trade permission, IP-allowlisted).
3. Set `TRADING_MODE=live`. Start with tiny size and low leverage.
4. The live order path in `src/exchange/bitunix.ts` is conservative scaffolding —
   **verify it against your account with minimal size before trusting it.**

## License

MIT — provided as-is, with no warranty. You are responsible for your own trades.
