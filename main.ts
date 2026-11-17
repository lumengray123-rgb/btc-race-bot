// Dip-buying BTC bot for make.fun's btc-race-24h-20261117-0603.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's SDK shim
// (vendor/makefun-bars.ts): the harness sends hello once, then one batch per
// 1-minute bar of cbBTC/USDC, then done. Every batch carries the bar that just
// closed plus the fills of the orders sent on the previous batch; the bot
// answers each batch with exactly one reply (its orders, echoing the batch
// seq). Orders decided on a bar's close fill at the next bar's open, so every
// decision here is made on closes only.
//
// Strategy: slow RSI mean reversion, long only, full size.
//   - RSI(25) over 1-minute closes (Wilder's smoothing, seeded by the mean of
//     the first 25 gains/losses). Buy all cash when RSI < 25: a 25-bar washout
//     is an oversold dip, and on the dev window these dips reverted.
//   - Sell the whole position when RSI > 75: the bounce is overbought.
//   - Stop-loss: sell when the position is worth less than 98.5% of its cost
//     (cost basis as the harness reports it, fees included). This never fired
//     on the dev window; it is insurance against a race window that keeps
//     falling after a dip-buy.
//   - One order per reply at most, full cash on a buy, full quantity on a
//     sell, max slippage 100 bps (a 1-minute move that far is far outside the
//     ~6 bps 1-minute noise, so the cap only bites in a genuine gap).
//
// Why this and not a trend follower: the dev window (1,440 bars, +0.49% net,
// 2.49% range) was tested against a faithful local replay of the harness's
// fill math (4 bps fee, 2 bps slippage, constant-product impact on the bar's
// open depth, ~34 bps per full-size round trip). Every EMA-cross, SMA-break,
// Donchian and momentum variant lost money on it (-$11 to -$132): the trends
// do not persist long enough at 1-minute resolution to pay the round trip.
// The RSI family was positive across a broad plateau (spans 20-45, buy 20-35,
// sell 65-80), and RSI(25) 25/75 sits in its middle. Verified with the kit's
// own grader (grade-local, process driver): net PnL +$7.72 USDC on the dev
// window, 4 trades, max drawdown 1.27%, 0 rejected orders, +$6.11 even at
// doubled fees, and the L1 regrade reproduced the run byte for byte. The
// parameters were chosen for the plateau, not for the single best dev number.
//
// Determinism: float64 arithmetic (+ - * /) on the closes only, no clock, no
// environment, no randomness, so two runs on the same bars answer alike.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** RSI span in bars (minutes). */
const RSI_SPAN = 25;
/** Buy when RSI falls under this: the dip. */
const RSI_BUY = 25;
/** Sell when RSI rises over this: the bounce is overbought. */
const RSI_SELL = 75;
/** Stop-loss in bps under cost: sell when value < cost * (10000 - STOP_BPS) / 10000. */
const STOP_BPS = 150;
/** Per-order slippage cap, measured from the latest close the batch carried. */
const MAX_SLIPPAGE_BPS = 100;

// --- Wilder's RSI, streamed over closes ------------------------------------

let prevClose: number | null = null;
/** Diffs seen so far (one per bar after the first). */
let diffs = 0;
let gainSum = 0;
let lossSum = 0;
let avgGain: number | null = null;
let avgLoss: number | null = null;
/** The current RSI, null until RSI_SPAN diffs have been seen. */
let rsi: number | null = null;

function rsiFrom(gain: number, loss: number): number {
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

function pushClose(close: number): void {
  if (prevClose !== null) {
    const d = close - prevClose;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    diffs++;
    if (avgGain === null || avgLoss === null) {
      gainSum += gain;
      lossSum += loss;
      if (diffs === RSI_SPAN) {
        avgGain = gainSum / RSI_SPAN;
        avgLoss = lossSum / RSI_SPAN;
        rsi = rsiFrom(avgGain, avgLoss);
      }
    } else {
      avgGain = (avgGain * (RSI_SPAN - 1) + gain) / RSI_SPAN;
      avgLoss = (avgLoss * (RSI_SPAN - 1) + loss) / RSI_SPAN;
      rsi = rsiFrom(avgGain, avgLoss);
    }
  }
  prevClose = close;
}

// --- The bot ----------------------------------------------------------------

await runBars({
  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushClose(Number(bar.c));
    }
    // Warm-up batches (if any) carry bars but no trading; the RSI still
    // builds from them, and no order is sent until the scored window starts.
    if (state.warmingUp) return [];
    if (rsi === null) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const stopped = value * 10000n < held.cost * BigInt(10000 - STOP_BPS);
      if (rsi > RSI_SELL || stopped) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (rsi < RSI_BUY) {
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (state.cash < minNotional) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
