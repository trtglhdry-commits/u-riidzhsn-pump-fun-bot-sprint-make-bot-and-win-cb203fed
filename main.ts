// Launch-sniper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The harness speaks NDJSON on stdin/stdout: hello, then one batch per slot, then
// done. Each batch carries the slot's universe events (CreateEvent, TradeEvent,
// CompleteEvent), marks for held/pending mints, fills that resolved since the
// last batch, and the account. This bot answers once per batch, echoing its seq,
// with its orders. Terms that matter here: hello, batch, orders, slot, fills,
// marks.
//
// Strategy (Slackwater skeleton, entry re-aimed by the dev tape):
//  - A new coin's first trades are where the money is on the pump.fun tape:
//    the bonding curve starts at a fixed price and early buyers push it up, so
//    the bot snipes launches. It buys on a coin's 3rd trade, but only while the
//    launch is fresh (created within the last hour) and the price has not already
//    dumped more than 5% below its launch price.
//  - The earlier dip-buy and breakout versions of this bot were graded on the
//    same dev window and both lost (dip-buy: -4.37 SOL at an 11% win rate;
//    breakout: -3.14 SOL at 22%), and a corrected offline replay of the tape
//    agrees: dip-buy -22.7 SOL, breakout with a chase cap -3.4 SOL, while
//    buying the 3rd trade with a wide take-profit is +8.9 SOL. The entry is
//    therefore the launch, not the dip and not the breakout.
//  - Exits are sized for the roughly 2.6% round-trip fee: sell everything at
//    +50% over the average entry (fees included in the cost basis), or at -10%.
//    A take-profit below the fee cannot work here.
//  - Fills resolve 2 slots after the decision, and a fill whose output is worse
//    than the decision-time reserves by more than max_slippage_bps is rejected,
//    so buys keep a tight 500 bps (a rejected buy costs nothing and the launch
//    is simply missed) while sells use 3000 bps (a stop that cannot fill on a
//    crashing coin is worthless). A buy rejected for slippage blocks its mint
//    for 10 minutes instead of being retried every batch.
//  - Respect the caps: at most 5 open positions, buys on one mint in one reply
//    spend at most 1% of its real SOL reserve, at most 16 orders per batch.
//    Never buy dust (under 0.05 SOL).
//
// Fully deterministic: every decision comes from the hello seed's run data, the
// slot and the state. No clock, no environment, no Math.random.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// One Solana slot is about 0.4 s: 3,600 slots ~ 1 hour.
const LAUNCH_WINDOW_SLOTS = 3_600;
const COOLDOWN_SLOTS = 3_600;
const REJECT_COOLDOWN_SLOTS = 600; // 10 minutes after a buy is rejected

const SNIPE_TRADE = 3; // buy when the coin's 3rd trade has been seen
const MAX_LAUNCH_DUMP = 0.05; // skip a launch already down more than 5% from its first price

const FIRST_BUY_LAMPORTS = 500_000_000n; // 0.5 SOL
const MIN_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL: never buy dust
const MIN_BUY_LAMPORTS_ROUND_TRIP = 10_000_000n; // guardrail: 0.01 SOL per round trip

const TAKE_PROFIT = 0.50; // sell everything at +50% over the average entry
const STOP_LOSS = -0.10; // sell everything at -10%

const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;

/** What the bot knows about one mint's launch. */
interface Launch {
  /** Slot of its CreateEvent, or null when first seen through a trade. */
  createdSlot: number | null;
  /** Slot it was first observed, for the launch window when no create was seen. */
  firstSeenSlot: number;
  /** Price of its first observed trade (the launch price). */
  firstPrice: number;
  /** Trades seen on this mint. */
  trades: number;
  /** The snipe was already attempted on this mint. */
  snipeTried: boolean;
  /** Slot until which the mint is blocked after a stop-out or a rejected buy. */
  blockedUntilSlot: number;
}

const launches = new Map<string, Launch>();

function launchFor(mint: string): Launch {
  let l = launches.get(mint);
  if (l === undefined) {
    l = { createdSlot: null, firstSeenSlot: -1, firstPrice: 0, trades: 0, snipeTried: false, blockedUntilSlot: -1 };
    launches.set(mint, l);
  }
  return l;
}

/** Price of one token in SOL from a curve's virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Average entry price (lamports of SOL per token) from the position's cost basis. */
function avgEntryPrice(tokens: bigint, costLamports: bigint): number {
  if (tokens <= 0n) return 0;
  return Number(costLamports) / Number(tokens);
}

function hasPendingOrder(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // A buy the harness rejected (usually max_slippage on a spike) blocks its
    // mint for a while instead of being retried on every batch.
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') {
        launchFor(f.mint).blockedUntilSlot = slot + REJECT_COOLDOWN_SLOTS;
      }
    }

    // Take the batch's events in: count trades and note each launch's first price.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const l = launchFor(e.mint);
        if (l.firstSeenSlot < 0) l.firstSeenSlot = e.slot;
        l.trades += 1;
        if (l.firstPrice === 0) {
          l.firstPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
      } else if (e.event === 'CreateEvent') {
        const l = launchFor(e.mint);
        if (l.firstSeenSlot < 0) l.firstSeenSlot = e.slot;
        l.createdSlot = e.slot;
        if (l.firstPrice === 0) {
          l.firstPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
      } else {
        // CompleteEvent: the curve is done; nothing re-enters it.
        launchFor(e.mint).blockedUntilSlot = Number.MAX_SAFE_INTEGER;
      }
    }

    // Exits first: every open position against its take-profit / stop.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      const entry = avgEntryPrice(holding.token_amount, holding.cost_lamports);
      if (!(entry > 0)) continue;
      const ret = price / entry - 1;
      if (hasPendingOrder(state, mint, 'sell')) continue;
      if (ret <= STOP_LOSS) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        launchFor(mint).blockedUntilSlot = slot + COOLDOWN_SLOTS;
      } else if (ret >= TAKE_PROFIT) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // Entries: snipe a fresh launch on its 3rd trade, unless it already dumped.
    if (orders.length < 16 && state.committedPositionCount() < state.hello.caps.max_open_positions) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (hasPendingOrder(state, mint, 'buy')) continue;
        const l = launches.get(mint);
        if (l === undefined) continue;
        if (l.trades < SNIPE_TRADE || l.snipeTried) continue;
        if (slot < l.blockedUntilSlot) continue;
        // Fresh launches only: created within the last hour (or first seen then).
        const ageFrom = l.createdSlot ?? l.firstSeenSlot;
        if (ageFrom >= 0 && slot - ageFrom > LAUNCH_WINDOW_SLOTS) {
          l.snipeTried = true;
          continue;
        }
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (!(price > 0)) continue;
        // Skip a launch that already dumped more than 5% below its first price.
        if (l.firstPrice > 0 && price < l.firstPrice * (1 - MAX_LAUNCH_DUMP)) {
          l.snipeTried = true;
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const size = FIRST_BUY_LAMPORTS < cap ? FIRST_BUY_LAMPORTS : cap;
        if (size < MIN_BUY_LAMPORTS_ROUND_TRIP) continue;
        const free = state.freeCashLamports();
        const alreadyCommitted = orders
          .filter((o) => o.side === 'buy')
          .reduce((sum, o) => sum + BigInt(o.quote_lamports as string), 0n);
        if (free - alreadyCommitted < size + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        l.snipeTried = true;
      }
    }

    return orders;
  },

  onDone(state: BotState): void {
    const cash = state.cash;
    const start = BigInt(state.hello.capital.lamports);
    const pnl = cash - start;
    console.error(
      `done: batches=${state.seq} cash=${cash} start=${start} pnl_lamports=${pnl} ` +
        `positions=${state.positions.size} curves_seen=${state.curves.size}`,
    );
  },
});

export { LAMPORTS_PER_SOL };
