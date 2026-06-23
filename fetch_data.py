#!/usr/bin/env python3
"""
Market Sentinel data fetcher.

Runs in GitHub Actions (server-side, NO browser/CORS), pulls daily closes for
every tracked symbol, and writes data.json into the repo root. The PWA then
reads /vym-sentinel/data.json same-origin -> zero third-party runtime calls,
nothing to break mid-session.

Source strategy (per symbol, with automatic failover):
  1. Yahoo /v8/chart  -- richer; includes the forming-day last price.
  2. Stooq CSV        -- no key, no crumb, datacenter-IP friendly.

Output is normalized to the EXACT shape the dashboard math already consumes:
  hist = [{ "t": <epoch_ms>, "c": <close_float> }, ...]
"""

import csv
import io
import json
import sys
import time
from datetime import datetime, timezone

import requests

# sym -> ()  ; benchmarks included because the quant engine needs them
SYMBOLS = ["VYM", "NVDA", "MAIN", "XOM", "VOO", "QQQ"]

RANGE = "1y"
KEEP = 300  # trailing points to retain (>=252 needed for the 1y metrics)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


# ----------------------------------------------------------------------------
# PURE PARSERS (no network -> unit-testable)
# ----------------------------------------------------------------------------
def parse_yahoo(payload: dict):
    """Yahoo /v8/chart JSON -> [{t,c}] sorted ascending, nulls dropped."""
    result = payload["chart"]["result"][0]
    ts = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    out = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        out.append({"t": int(t) * 1000, "c": round(float(c), 4)})
    out.sort(key=lambda x: x["t"])
    return out


def parse_stooq(csv_text: str):
    """Stooq daily CSV -> [{t,c}]. Header: Date,Open,High,Low,Close,Volume."""
    out = []
    reader = csv.DictReader(io.StringIO(csv_text.strip()))
    for row in reader:
        d = (row.get("Date") or "").strip()
        c = (row.get("Close") or "").strip()
        if not d or not c or c.upper() in ("N/D", "NULL"):
            continue
        try:
            dt = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            out.append({"t": int(dt.timestamp()) * 1000, "c": round(float(c), 4)})
        except ValueError:
            continue
    out.sort(key=lambda x: x["t"])
    return out


# ----------------------------------------------------------------------------
# NETWORK (thin wrappers around the pure parsers)
# ----------------------------------------------------------------------------
def fetch_yahoo(sym: str, session: requests.Session):
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        f"?interval=1d&range={RANGE}"
    )
    last_err = None
    for attempt in range(3):
        try:
            r = session.get(url, headers={"User-Agent": UA}, timeout=20)
            if r.status_code == 200:
                hist = parse_yahoo(r.json())
                if hist:
                    return hist
                last_err = "empty series"
            else:
                last_err = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"yahoo {sym}: {last_err}")


def fetch_stooq(sym: str, session: requests.Session):
    url = f"https://stooq.com/q/d/l/?s={sym.lower()}.us&i=d"
    r = session.get(url, headers={"User-Agent": UA}, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"stooq {sym}: HTTP {r.status_code}")
    txt = r.text
    # Stooq returns a tiny HTML/text blob (not CSV) when rate-limited.
    if "Date,Open" not in txt.splitlines()[0]:
        raise RuntimeError(f"stooq {sym}: non-CSV response ({txt[:40]!r})")
    hist = parse_stooq(txt)
    if not hist:
        raise RuntimeError(f"stooq {sym}: empty after parse")
    return hist


def fetch_symbol(sym: str, session: requests.Session):
    """Return (hist, source). Try Yahoo, fall back to Stooq."""
    try:
        return fetch_yahoo(sym, session)[-KEEP:], "yahoo"
    except Exception as ye:  # noqa: BLE001
        print(f"  [warn] {ye}; falling back to stooq", file=sys.stderr)
        return fetch_stooq(sym, session)[-KEEP:], "stooq"


def main():
    session = requests.Session()
    symbols = {}
    sources = set()
    failures = []

    for sym in SYMBOLS:
        try:
            hist, src = fetch_symbol(sym, session)
            symbols[sym] = {"source": src, "points": len(hist), "hist": hist}
            sources.add(src)
            print(f"  {sym}: {len(hist)} pts via {src} "
                  f"(last close {hist[-1]['c']})")
        except Exception as e:  # noqa: BLE001
            failures.append(sym)
            print(f"  [ERROR] {sym}: {e}", file=sys.stderr)
        time.sleep(0.4)  # be polite between symbols

    if failures:
        # Fail the Action loudly so a broken source never silently ships
        # stale data to users. data.json is only overwritten on full success.
        print(f"FATAL: failed symbols: {failures}", file=sys.stderr)
        sys.exit(1)

    overall = sources.pop() if len(sources) == 1 else "mixed"
    out = {
        "generated": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "source": overall,
        "symbols": symbols,
    }
    with open("data.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"WROTE data.json ({overall}) for {list(symbols)}")


if __name__ == "__main__":
    main()
