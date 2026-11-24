// Breakout scalper for the pump.fun bonding-curve replay.
//
// What the dev window teaches, in order. (1) Every completer runs 14.7x
// from launch to completion without ever trading below launch, so waiting
// for a dip never meets one. (2) The pump is front-loaded: 642 of the 676
// coins that break 1.15x above launch do so in the first 60 slots, and
// the fill lands about 14% above the breakout price (two slots of
// latency) while the median price is already falling 10 slots after the
// fill — so the bot banks a small take-profit fast, cuts losers on a
// hard stop, and never holds past a short maximum hold. (3) Pyramiding
// into strength loses monotonically (a sweep: no adds -0.50, 2 tranches
// -0.96, 4 tranches -1.57), so each position is a single buy. (4) The
// final window is 6 hours, about a quarter of the dev window's coins,
// and the guardrail needs 20 distinct mints — so entries stay loose
// enough to trade ~15% of coins, accepting a small expected loss on a
// dev-like window rather than risking the guardrail. Buys carry no
// slippage cap: during a pump the fill price moves in two slots, and a
// rejected buy misses the move entirely. A creator sale only counts
// within a short window; a stale one is not a signal.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface Params {
  /** Lookback (slots) for the flow window. */
  window: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Breakout: price above launch by at least this (fraction). */
  climbMin: number;
  /** Never buy a coin that already ran this far above launch (fraction). */
  maxRunup: number;
  /** Real SOL a curve must hold at entry (lamports). */
  minRealSol: bigint;
  /** Net SOL bought over the flow window at entry. */
  minNetFlowSol: number;
  /** Distinct buying wallets in the flow window at entry. */
  minBuyers: number;
  /** Price now at least this share of the flow window's high. */
  nearHigh: number;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this far above the position's average entry (fraction). */
  addStep: number;
  /** Add only while net SOL over the flow window is at least this. */
  addNetSol: number;
  /** Most tranches per position. */
  maxTranches: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell the whole position when its value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell the whole position when its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop from the position's peak value (fraction). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit if the creator sold within this many slots (a stale creator sale is not a signal). */
  creatorSoldWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most round trips per curve over the run. */
  maxEntries: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** SOL kept unspent so a batch never runs dry on fees. */
  reserveSol: number;
  /** Most orders in one reply (below the harness cap). */
  maxOrdersPerBatch: number;
}

// The settings main.ts trades with. Chosen by hand, then checked on the dev
// window with the local simulator; prefer flat regions over single best cells.
export const DEFAULT_PARAMS: Params = {
  window: 40,
  minAge: 0,
  climbMin: 0.15,
  maxRunup: 2.0,
  minRealSol: 1_000_000_000n,
  minNetFlowSol: 0.5,
  minBuyers: 4,
  nearHigh: 0.85,
  stakeSol: 0.6,
  firstSol: 0.05,
  addSol: 0.08,
  addStep: 0.01,
  addNetSol: 0.2,
  maxTranches: 1,
  minBuySol: 0.006,
  buySlipBps: 10000,
  stopLoss: 0.1,
  takeProfit: 0.12,
  trail: 0.15,
  trailArm: 0.15,
  creatorSoldWindow: 600,
  fadeWindow: 40,
  fadeNetSol: 0.5,
  bigSellSol: 1.0,
  maxHold: 20,
  cooldown: 300,
  maxEntries: 2,
  maxEntriesPerBatch: 3,
  reserveSol: 0.5,
  maxOrdersPerBatch: 12,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface CurveNote {
  mint: Pubkey;
  createdSlot: number | null;
  creator: Pubkey | null;
  launchPrice: number;
  tape: TapeTrade[];
  /** Slot of the creator's most recent sell, or -1. */
  creatorSoldSlot: number;
  bigSellSeen: boolean;
  entriesUsed: number;
  cooldownUntil: number;
  complete: boolean;
}

interface Held {
  mint: Pubkey;
  entrySlot: number;
  peakRatio: number;
  tranches: number;
}

const SOL = (lamports: bigint): number => Number(lamports) / 1e9;
const LAMPORTS = (sol: number): bigint => BigInt(Math.round(sol * 1e9));

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params): Bot {
  const notes = new Map<Pubkey, CurveNote>();
  const held = new Map<Pubkey, Held>();

  function noteFor(mint: Pubkey): CurveNote {
    let n = notes.get(mint);
    if (n === undefined) {
      n = {
        mint,
        createdSlot: null,
        creator: null,
        launchPrice: 0,
        tape: [],
        creatorSoldSlot: -1,
        bigSellSeen: false,
        entriesUsed: 0,
        cooldownUntil: -1,
        complete: false,
      };
      notes.set(mint, n);
    }
    return n;
  }

  function windowStats(n: CurveNote, slot: number, window: number): {
    net: number;
    buyers: number;
    high: number;
  } {
    let net = 0;
    const buyers = new Set<Pubkey>();
    let high = 0;
    for (let i = n.tape.length - 1; i >= 0; i--) {
      const t = n.tape[i]!;
      if (t.slot <= slot - window) break;
      if (t.buy) {
        net += t.sol;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
      if (t.price > high) high = t.price;
    }
    return { net, buyers: buyers.size, high };
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // --- Fold this batch's events into the per-curve notes. ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const n = noteFor(e.mint);
        n.createdSlot = e.slot;
        n.creator = e.creator;
        if (n.launchPrice === 0) {
          n.launchPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
      } else if (e.event === 'TradeEvent') {
        const n = noteFor(e.mint);
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (n.launchPrice === 0) n.launchPrice = price;
        const sol = SOL(BigInt(e.sol_amount));
        n.tape.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
        if (n.tape.length > 500) n.tape.splice(0, n.tape.length - 500);
        if (n.creator !== null && e.user === n.creator && !e.is_buy) n.creatorSoldSlot = e.slot;
        if (!e.is_buy && sol >= p.bigSellSol) n.bigSellSeen = true;
      } else {
        const n = noteFor(e.mint);
        n.complete = true;
      }
    }

    // --- Reconcile held positions with the account; closed ones cool down.
    // A position with a sell still pending is not a fresh holding: the
    // pending map is the ground truth, so a rejected sell lets the
    // position be picked up again instead of orphaning it.
    const pendingSell = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') pendingSell.add(po.order.mint);
    }
    for (const [mint] of held) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        const n = notes.get(mint);
        if (n !== undefined) n.cooldownUntil = slot + p.cooldown;
      }
    }
    for (const mint of state.positions.keys()) {
      if (!held.has(mint) && !pendingSell.has(mint)) {
        held.set(mint, { mint, entrySlot: slot, peakRatio: 1, tranches: 1 });
      }
    }

    // --- Exits first: a position that must go, goes whole. ---
    for (const [mint, h] of held) {
      if (pendingSell.has(mint)) continue;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const valueSol = Number(pos.token_amount) * price;
      const costSol = SOL(pos.cost_lamports);
      if (costSol <= 0) continue;
      const ratio = valueSol / costSol;
      if (ratio > h.peakRatio) h.peakRatio = ratio;

      const n = notes.get(mint);
      let reason = '';
      if (ratio <= 1 - p.stopLoss) reason = 'stop';
      else if (ratio >= 1 + p.takeProfit) reason = 'take-profit';
      else if (h.peakRatio >= 1 + p.trailArm && ratio <= h.peakRatio * (1 - p.trail)) reason = 'trail';
      else if (slot - h.entrySlot >= p.maxHold) reason = 'max-hold';
      else if (n !== undefined && n.creatorSoldSlot >= 0 && slot - n.creatorSoldSlot <= p.creatorSoldWindow) reason = 'creator-sold';
      else if (n !== undefined && n.bigSellSeen) reason = 'big-sell';
      else if (n !== undefined) {
        const fade = windowStats(n, slot, p.fadeWindow);
        if (fade.net <= -p.fadeNetSol) reason = 'fade';
      }
      if (reason === '') continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      if (n !== undefined) {
        n.bigSellSeen = false;
        n.cooldownUntil = slot + p.cooldown;
      }
      held.delete(mint);
      if (orders.length >= p.maxOrdersPerBatch) return orders;
    }

    // --- Entries: breakouts only, tranched across batches. ---
    const free = state.freeCashLamports();
    const reserve = LAMPORTS(p.reserveSol);
    let cashLeft = free - reserve;
    const openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (openSlots <= 0 || cashLeft < LAMPORTS(p.minBuySol) + txFee) return orders;
    let entriesLeft = p.maxEntriesPerBatch;

    const pendingBuy = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
    }

    for (const [mint, curve] of state.curves) {
      if (entriesLeft <= 0 || orders.length >= p.maxOrdersPerBatch) break;
      if (curve.complete) continue;
      if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
      const n = notes.get(mint);
      if (n === undefined) continue;
      if (n.createdSlot === null || slot - n.createdSlot < p.minAge) continue;
      if (slot < n.cooldownUntil) continue;
      if (n.entriesUsed >= p.maxEntries) continue;
      if (n.creatorSoldSlot >= 0 && slot - n.creatorSoldSlot <= p.creatorSoldWindow) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || n.launchPrice <= 0) continue;
      if (price < n.launchPrice * (1 + p.climbMin)) continue;
      if (price >= n.launchPrice * (1 + p.maxRunup)) continue;
      if (curve.real_quote_reserves < p.minRealSol) continue;

      const stats = windowStats(n, slot, p.window);
      if (stats.net < p.minNetFlowSol) continue;
      if (stats.buyers < p.minBuyers) continue;
      if (stats.high > 0 && price < stats.high * p.nearHigh) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < LAMPORTS(p.minBuySol)) continue;
      let amount = cap < LAMPORTS(p.firstSol) ? cap : LAMPORTS(p.firstSol);
      if (amount > cashLeft - txFee) amount = cashLeft - txFee;
      if (amount < LAMPORTS(p.minBuySol)) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
      cashLeft -= amount + txFee;
      entriesLeft -= 1;
      n.entriesUsed += 1;
    }

    // --- Add-on tranches for open positions still showing strength. ---
    for (const [mint, h] of held) {
      if (orders.length >= p.maxOrdersPerBatch) break;
      if (pendingBuy.has(mint)) continue;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      const n = notes.get(mint);
      if (pos === undefined || curve === undefined || n === undefined) continue;
      if (curve.complete) continue;
      if (n.creatorSoldSlot >= 0 && slot - n.creatorSoldSlot <= p.creatorSoldWindow) continue;
      if (h.tranches >= p.maxTranches) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const spentSol = SOL(pos.cost_lamports);
      if (spentSol >= p.stakeSol) continue;
      const avgEntry = spentSol / Number(pos.token_amount);
      if (avgEntry <= 0 || price < avgEntry * (1 + p.addStep)) continue;
      const stats = windowStats(n, slot, p.window);
      if (stats.net < p.addNetSol) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < LAMPORTS(p.minBuySol)) continue;
      let amount = cap < LAMPORTS(p.addSol) ? cap : LAMPORTS(p.addSol);
      const remaining = LAMPORTS(p.stakeSol) - pos.cost_lamports;
      if (amount > remaining) amount = remaining;
      if (amount > cashLeft - txFee) amount = cashLeft - txFee;
      if (amount < LAMPORTS(p.minBuySol)) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
      cashLeft -= amount + txFee;
      h.tranches += 1;
    }

    return orders;
  }

  return { onBatch };
}
