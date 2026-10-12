"""Kronos forecast microservice.

Loads the Kronos candlestick foundation model once and exposes a tiny HTTP API
the Node trading bot calls to confirm an NW-flip breakout. Given recent closed
OHLCV bars it forecasts the next few bars and returns the net direction.

The bot uses this as a FILTER, not a signal: it only takes a long breakout when
Kronos also forecasts up (and vice-versa). It fails open — if this service is
slow or down, the bot trades the breakout unfiltered rather than freezing.
"""

import os
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel

from model import Kronos, KronosTokenizer, KronosPredictor  # from the vendored Kronos repo (PYTHONPATH)

TOKENIZER = os.getenv("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base")
MODEL = os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-small")
DEVICE = os.getenv("KRONOS_DEVICE", "cpu")
MAX_CONTEXT = int(os.getenv("KRONOS_MAX_CONTEXT", "512"))

app = FastAPI(title="kronos-forecast")
_predictor: KronosPredictor | None = None


class Bar(BaseModel):
    t: int  # bar open time, epoch ms
    o: float
    h: float
    l: float
    c: float
    v: float


class ForecastReq(BaseModel):
    tf_minutes: int  # bar interval in minutes, to build future timestamps
    bars: list[Bar]  # recent CLOSED bars, oldest first
    pred_len: int = 6  # how many bars ahead to forecast
    lookback: int = 400  # how many recent bars to feed (capped to max_context)
    T: float = 1.0
    top_p: float = 0.9
    samples: int = 1


@app.on_event("startup")
def _load() -> None:
    global _predictor
    tok = KronosTokenizer.from_pretrained(TOKENIZER)
    mod = Kronos.from_pretrained(MODEL)
    _predictor = KronosPredictor(mod, tok, device=DEVICE, max_context=MAX_CONTEXT)


@app.get("/health")
def health() -> dict:
    return {"ok": _predictor is not None, "model": MODEL, "device": DEVICE}


@app.post("/forecast")
def forecast(req: ForecastReq) -> dict:
    if _predictor is None:
        return {"error": "model not loaded"}
    bars = req.bars[-min(req.lookback, MAX_CONTEXT):]
    if len(bars) < 32:
        return {"error": "need >=32 bars", "direction": "flat"}

    df = pd.DataFrame(
        [{"open": b.o, "high": b.h, "low": b.l, "close": b.c, "volume": b.v, "amount": b.v * b.c} for b in bars]
    )
    x_ts = pd.Series(pd.to_datetime([b.t for b in bars], unit="ms"))
    step = pd.Timedelta(minutes=req.tf_minutes)
    last = x_ts.iloc[-1]
    y_ts = pd.Series([last + step * (i + 1) for i in range(req.pred_len)])

    pred = _predictor.predict(
        df=df[["open", "high", "low", "close", "volume", "amount"]],
        x_timestamp=x_ts,
        y_timestamp=y_ts,
        pred_len=req.pred_len,
        T=req.T,
        top_p=req.top_p,
        sample_count=req.samples,
        verbose=False,
    )

    last_close = float(df["close"].iloc[-1])
    pred_close = float(pred["close"].iloc[-1])
    chg = (pred_close - last_close) / last_close if last_close else 0.0
    direction = "up" if chg > 0 else "down" if chg < 0 else "flat"
    return {
        "direction": direction,
        "lastClose": last_close,
        "predClose": pred_close,
        "predChangePct": chg * 100.0,
        "predHigh": float(pred["high"].max()),
        "predLow": float(pred["low"].min()),
        "predLen": req.pred_len,
    }
