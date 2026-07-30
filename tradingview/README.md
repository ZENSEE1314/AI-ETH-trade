# Sniper SMC + VWAP + VSA (Pine v5)

Original TradingView indicator for the AI-ETH-trade bot. Combines:

- **Market structure** — swing pivots, BOS (continuation) and CHoCH (reversal).
- **EQH / EQL** — equal highs/lows (resting liquidity) within an ATR tolerance.
- **Liquidity sweeps** — wick beyond a swing that closes back inside (stop hunt).
- **Fair Value Gaps** — 3-candle imbalances with mitigation fading.
- **VWAP** — session/weekly anchored with std-dev bands + reclaim detection.
- **Volume / VSA** — relative volume, climax, demand/supply, absorption.
- **Premium / Discount** — dealing-range equilibrium.

These are scored into a 0–100 **confluence** value per side; a signal fires only
when confluence ≥ threshold **and** Risk:Reward ≥ your minimum.

## Install

1. TradingView → **Pine Editor** → paste `SniperSMC.pine` → **Add to chart**.
2. Open settings and set, under **Webhook**:
   - `Webhook secret` = your bot's `WEBHOOK_SECRET`.
   - `Bot symbol` = e.g. `ETHUSDT`.
3. Tune **Signals & Risk** (confluence threshold, min R:R, stop buffer).

## Wire the alert to the bot (needs a paid TradingView plan)

1. Right-click the chart → **Add alert** (or the alarm clock icon).
2. **Condition** = this indicator → **"Any alert() function call"**.
3. **Notifications → Webhook URL** =
   `https://ai-eth-trade-production.up.railway.app/webhook/tradingview`
4. Leave the message empty — the script sends the JSON itself:

```json
{"secret":"...","symbol":"ETHUSDT","side":"long","entry":3500,"stopLoss":3465,"takeProfit":3605,"confluence":75}
```

Every alert still passes through the bot's risk core (daily-loss kill switch,
50× liquidation guard, R:R and confluence gates) before any order.

> Not financial advice. Backtest and forward-test on paper before going live.
