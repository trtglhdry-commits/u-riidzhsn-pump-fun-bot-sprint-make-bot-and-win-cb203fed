// Slackwater-style momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// The harness speaks NDJSON on stdin/stdout: hello, then one batch per slot, then
// done. Each batch carries the slot's universe events (CreateEvent, TradeEvent,
// CompleteEvent), marks for held/pending mints, fills that resolved since the last
// batch, and the account. This bot answers once per batch, echoing its seq, with
// its orders. Terms that matter here: hello, batch, orders, slot, fills, marks.
//
// Strategy, adapted from the Slackwater pattern to the pump.fun tape:
//  - Track every mint's price from its virtual reserves (virtual_quote_reserves /
//    virtual_token_reserves) and keep its trailing 60-minute high (about 9,000
//    slots) plus its price 4 hours ago (about 36,000 slots).
//  - Enter on strength, not on weakness: buy when the price breaks above its
//    trailing 60-minute high and the 4-hour trend filter passes (price no more
//    than 1% below where it was 4 hours ago; skipped for coins younger than
//    4 hours, where the breakout itself is the trend). The dev tape shows why:
//    a dip-buy off the same high loses on this data (coins that dip keep
//    dipping), while buying the breakout wins after the roughly 2.6% round-trip
//    fee. A take-profit below that fee cannot work here, so the exits are sized
//    for it: one take-profit at +40%, one stop at -10%.
//  - The high a decision uses lags one batch on purpose: the batch's own prices
//    are staged and folded into history at the next batch, so a buy fires on a
//    breakout the tape has already printed, not on a price the bot just saw
//    spike inside the batch it is answering. The first version compared the
//    live price with a high that already contained it and ended up buying
//    retests of old highs instead; its dev grade lost 4.37 SOL at an 11% win
//    rate, which is what this revision fixes.
//  - Fills resolve 2 slots after the decision, and a fill whose output is worse
//    than the decision-time reserves by more than max_slippage_bps is rejected,
//    so buys keep a tight 500 bps (a rejected buy costs nothing) while sells
//    use 3000 bps (a stop that cannot fill on a crashing coin is worthless).
//    A buy rejected for slippage blocks the mint for 10 minutes instead of
//    being retried every batch.
//  - Respect the caps: at most 5 open positions, buys on one mint in one reply
//    spend at most 1% of its real SOL reserve, at most 16 orders per batch.
//    Never buy dust (under 0.05 SOL) or a coin with too few trades to judge,
//    and never chase a coin that already gapped more than 15% past its high.
//
// Fully deterministic: every decision comes from the hello seed's run data, the
// slot and the state. No clock, no environment, no Math.random.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// One Solana slot is about 0.4 s: 9,000 slots ~ 60 minutes, 36,000 ~ 4 hours.
const HIGH_WINDOW_SLOTS = 9_000;
const TREND_WINDOW_SLOTS = 36_000;
const COOLDOWN_SLOTS = 3_600;
const REJECT_COOLDOWN_SLOTS = 600; // 10 minutes after a buy is rejected

// Slackwater's 4h trend filter: never buy a coin down more than 1% over 4 hours.
const TREND_MIN_RETURN = -0.01;

const FIRST_BUY_LAMPORTS = 500_000_000n; // 0.5 SOL
const MIN_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL: never buy dust
const MIN_BUY_LAMPORTS_ROUND_TRIP = 10_000_000n; // guardrail: 0.01 SOL per round trip

const TAKE_PROFIT = 0.40; // sell everything at +40% over the average entry
const STOP_LOSS = -0.10; // sell everything at -10%
const MAX_BREAKOUT_GAP = 0.15; // never chase more than 15% past the old high

const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;
const MIN_TRADES_BEFORE_ENTRY = 3;

/** Price samples for one mint, pruned to the trend window. */
interface MintHistory {
  /** (slot, price) pairs in slot order, pruned to the last TREND_WINDOW_SLOTS. */
  samples: Array<{ slot: number; price: number }>;
  /** Monotonic decreasing deque of (slot, price) for the trailing 60-minute high. */
  highDeque: Array<{ slot: number; price: number }>;
  /** Trades seen on this mint. */
  trades: number;
}

interface CoinBook {
  /** Slot until which the mint is blocked after a stop-out or a rejected buy. */
  blockedUntilSlot: number;
}

const histories = new Map<string, MintHistory>();
const books = new Map<string, CoinBook>();
/** Observations from the batch being answered, folded into history next batch. */
let staged: Array<{ mint: string; slot: number; price: number }> = [];

function historyFor(mint: string): MintHistory {
  let h = histories.get(mint);
  if (h === undefined) {
    h = { samples: [], highDeque: [], trades: 0 };
    histories.set(mint, h);
  }
  return h;
}

function bookFor(mint: string): CoinBook {
  let b = books.get(mint);
  if (b === undefined) {
    b = { blockedUntilSlot: -1 };
    books.set(mint, b);
  }
  return b;
}

/** Price of one token in SOL from a curve's virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Fold one observed price into the mint's history (sliding 60-min high + 4h samples). */
function observe(mint: string, slot: number, price: number): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const h = historyFor(mint);
  const cutHigh = slot - HIGH_WINDOW_SLOTS;
  while (h.highDeque.length > 0 && h.highDeque[0].slot < cutHigh) h.highDeque.shift();
  while (h.highDeque.length > 0 && h.highDeque[h.highDeque.length - 1].price <= price) h.highDeque.pop();
  h.highDeque.push({ slot, price });
  h.samples.push({ slot, price });
  const cutTrend = slot - TREND_WINDOW_SLOTS;
  while (h.samples.length > 0 && h.samples[0].slot < cutTrend) h.samples.shift();
}

/** Trailing 60-minute high, or 0 when the mint has no history yet. */
function trailingHigh(h: MintHistory): number {
  return h.highDeque.length > 0 ? h.highDeque[0].price : 0;
}

/** Price TREND_WINDOW_SLOTS ago (oldest surviving sample), or null when too young. */
function priceFourHoursAgo(h: MintHistory, slot: number): number | null {
  const target = slot - TREND_WINDOW_SLOTS;
  for (const s of h.samples) {
    if (s.slot >= target) return s.price;
  }
  return null;
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

    // Fold the previous batch's staged observations into history first, so the
    // trailing high a decision uses never contains the batch being answered.
    const toMerge = staged;
    staged = [];
    for (const o of toMerge) observe(o.mint, o.slot, o.price);

    // A buy the harness rejected (usually max_slippage on a spike) blocks its
    // mint for a while instead of being retried on every batch.
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') {
        bookFor(f.mint).blockedUntilSlot = slot + REJECT_COOLDOWN_SLOTS;
      }
    }

    // Stage this batch's events: their prices reach the history next batch.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const h = historyFor(e.mint);
        h.trades += 1;
        staged.push({
          mint: e.mint,
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
      } else if (e.event === 'CreateEvent') {
        staged.push({
          mint: e.mint,
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
      } else {
        // CompleteEvent: the curve is done; forget its book so nothing re-enters.
        const b = books.get(e.mint);
        if (b !== undefined) b.blockedUntilSlot = Number.MAX_SAFE_INTEGER;
      }
    }

    // Marks refresh the reserves of held/pending mints even on slots with no trade.
    for (const m of batch.marks) {
      staged.push({
        mint: m.mint,
        slot: m.slot,
        price: priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves)),
      });
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
        bookFor(mint).blockedUntilSlot = slot + COOLDOWN_SLOTS;
      } else if (ret >= TAKE_PROFIT) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // Entries: a breakout above the lagged trailing 60-minute high, with the
    // 4-hour trend filter green, not chased more than 15% past the high.
    if (orders.length < 16 && state.committedPositionCount() < state.hello.caps.max_open_positions) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (hasPendingOrder(state, mint, 'buy')) continue;
        const h = histories.get(mint);
        if (h === undefined || h.trades < MIN_TRADES_BEFORE_ENTRY) continue;
        const book = books.get(mint);
        if (book !== undefined && slot < book.blockedUntilSlot) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (!(price > 0)) continue;
        // Breakout against the lagged high: the high was set in an earlier batch,
        // because this batch's prices only reach the history next batch.
        const high = trailingHigh(h);
        if (high <= 0 || price < high) continue;
        if (price > high * (1 + MAX_BREAKOUT_GAP)) continue;
        // 4-hour trend filter: not down more than 1% over 4 hours (skipped while young).
        const old = priceFourHoursAgo(h, slot);
        if (old !== null && old > 0 && price < old * (1 + TREND_MIN_RETURN)) continue;
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
