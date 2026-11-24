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
//  - Enter on strength, not on weakness: buy when the price prints a new 60-minute
//    high and the 4-hour trend filter passes (price no more than 1% below where it
//    was 4 hours ago; skipped for coins younger than 4 hours, where the breakout
//    itself is the trend). The dev tape shows why: a dip-buy off the same high
//    loses on this data (coins that dip keep dipping), while buying the breakout
//    wins after the roughly 2.6% round-trip fee. A take-profit below that fee
//    cannot work here, so the exits are sized for it.
//  - Scale in on further strength: add when the price reaches 15% above the
//    average entry, at most twice per coin.
//  - Exit half at +20% over the average entry (fees included in the cost basis),
//    the rest at +50%, and everything at -8%. After a stop-out the coin is
//    blocked for an hour so a dying coin is not re-bought.
//  - Respect the caps: at most 5 open positions, buys on one mint in one reply
//    spend at most 1% of its real SOL reserve, at most 16 orders per batch,
//    500 bps max slippage. Never buy dust (under 0.05 SOL) or a coin with too
//    few trades to judge.
//
// Fully deterministic: every decision comes from the hello seed's run data, the
// slot and the state. No clock, no environment, no Math.random.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// One Solana slot is about 0.4 s: 9,000 slots ~ 60 minutes, 36,000 ~ 4 hours.
const HIGH_WINDOW_SLOTS = 9_000;
const TREND_WINDOW_SLOTS = 36_000;
const COOLDOWN_SLOTS = 3_600;

// Slackwater's 4h trend filter: never buy a coin down more than 1% over 4 hours.
const TREND_MIN_RETURN = -0.01;

const FIRST_BUY_LAMPORTS = 500_000_000n; // 0.5 SOL
const SCALE_BUY_LAMPORTS = 300_000_000n; // 0.3 SOL
const MAX_SCALE_INS = 2;
const SCALE_TRIGGER = 0.15; // add when the price is 15% above the average entry
const MIN_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL: never buy dust
const MIN_BUY_LAMPORTS_ROUND_TRIP = 10_000_000n; // guardrail: 0.01 SOL per round trip

const TAKE_PROFIT_1 = 0.20; // sell half at +20% over the average entry
const TAKE_PROFIT_2 = 0.50; // sell the rest at +50%
const STOP_LOSS = -0.08; // sell everything at -8%

const MAX_SLIPPAGE_BPS = 500;
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
  /** Scale-ins already added to the open position. */
  scaleIns: number;
  /** Slot until which the mint is blocked after a stop-out. */
  blockedUntilSlot: number;
  /** Highest return seen while holding, for the exit ladder (unused by the ladder, kept for logs). */
  peakReturn: number;
}

const histories = new Map<string, MintHistory>();
const books = new Map<string, CoinBook>();

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
    b = { scaleIns: 0, blockedUntilSlot: -1, peakReturn: 0 };
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

    // Take the batch's events in: price history for every mint that traded.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const h = historyFor(e.mint);
        h.trades += 1;
        observe(e.mint, e.slot, priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
      } else if (e.event === 'CreateEvent') {
        observe(e.mint, e.slot, priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
      } else {
        // CompleteEvent: the curve is done; forget its book so nothing re-enters.
        const b = books.get(e.mint);
        if (b !== undefined) b.blockedUntilSlot = Number.MAX_SAFE_INTEGER;
      }
    }

    // Marks refresh the reserves of held/pending mints even on slots with no trade.
    for (const m of batch.marks) {
      observe(m.mint, m.slot, priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves)));
    }

    // Exits first: every open position against its take-profit / stop ladder.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      const entry = avgEntryPrice(holding.token_amount, holding.cost_lamports);
      if (!(entry > 0)) continue;
      const ret = price / entry - 1;
      const book = bookFor(mint);
      if (ret > book.peakReturn) book.peakReturn = ret;
      if (hasPendingOrder(state, mint, 'sell')) continue;
      if (ret <= STOP_LOSS) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        book.blockedUntilSlot = slot + COOLDOWN_SLOTS;
        book.scaleIns = 0;
        book.peakReturn = 0;
      } else if (ret >= TAKE_PROFIT_2) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        book.scaleIns = 0;
        book.peakReturn = 0;
      } else if (ret >= TAKE_PROFIT_1) {
        // Sell half at the first take-profit; the rest rides to the second rung.
        const half = holding.token_amount / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    // Scale-ins: a held coin that prints 15% above its average entry gets more size.
    if (orders.length < 16) {
      for (const [mint, holding] of state.positions) {
        if (orders.length >= 16) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (!(price > 0)) continue;
        const entry = avgEntryPrice(holding.token_amount, holding.cost_lamports);
        if (!(entry > 0)) continue;
        const book = bookFor(mint);
        if (book.scaleIns >= MAX_SCALE_INS) continue;
        if (hasPendingOrder(state, mint, 'buy') || hasPendingOrder(state, mint, 'sell')) continue;
        if (price < entry * (1 + SCALE_TRIGGER)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const size = SCALE_BUY_LAMPORTS < cap ? SCALE_BUY_LAMPORTS : cap;
        const free = state.freeCashLamports();
        if (free < size + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        book.scaleIns += 1;
      }
    }

    // Entries: a new 60-minute high with the 4-hour trend filter green.
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
        // Breakout: the price is at (or above) its trailing 60-minute high, and the
        // high is not just the price itself from this very batch's first sighting:
        // require the high to have been set at an earlier slot.
        const high = trailingHigh(h);
        if (high <= 0 || price < high) continue;
        if (h.highDeque.length > 0 && h.highDeque[0].slot >= slot) continue;
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
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        const b = bookFor(mint);
        b.scaleIns = 0;
        b.peakReturn = 0;
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
