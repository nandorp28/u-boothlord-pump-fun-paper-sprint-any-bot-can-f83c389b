# Breakout Scalper — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nandorp28/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nandorp28/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic pump.fun paper-trading bot for the [make.fun bounty](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) **"Pump.fun Paper Sprint: Any Bot Can Win"**. The house replays it on 6 hours of real pump.fun market data; the highest net PnL wins. No real money, no runtime AI model — just the rules below, fitted to the kit's dev window.

## How it trades

The dev window (1,222 coins, 24h) taught four things, and the bot is built around them:

1. **Completers never dip.** Every one of the 35 completers runs 14.7x from launch to completion without ever trading below its launch price — so waiting for a dip below launch never meets one.
2. **The pump is front-loaded.** 642 of the 676 coins that break 1.15x above launch do so in the first 60 slots. The fill lands ~14% above the breakout price (two slots of latency) while the median price is already falling 10 slots after the fill, and the median max after the fill is only 1.17x. So the bot **scalps**: a small take-profit fast, a hard stop, and a short maximum hold. Riding loses money here — the median price 300 slots after entry is 0.82x of the fill.
3. **Pyramiding loses.** A parameter sweep on the dev window: no adds −0.50 SOL, 2 tranches −0.96, 4 tranches −1.57. Each position is a single buy.
4. **The final window is short.** It is 6 hours — about a quarter of the dev window's coins — and the guardrail needs 20 distinct mints with round trips of at least 0.01 SOL. Entries stay loose enough to trade ~15% of coins, accepting a small expected loss on a dev-like window rather than risking the guardrail.

Entry: a coin that climbs ≥15% above its launch price, with ≥1 SOL of real reserves, net buying ≥0.5 SOL and ≥4 distinct buyers over the last 40 slots, its price within 15% of the window high, and no creator sale in the last 600 slots. One buy per position (capped at 1% of real SOL per reply by the harness), at most 5 positions open, at most 3 new entries per batch.

Exits (whole position): hard stop at −10%, take-profit at +12%, trailing stop of 15% once the position is +15% up, a fade exit when net flow over 40 slots falls below −0.5 SOL, an immediate exit on a creator sale or a single sell ≥1 SOL, and a 20-slot maximum hold. A 300-slot cooldown follows every exit.

## Local results (dev window, kit simulator)

- Net PnL **−0.255 SOL** on 10 SOL capital (223 round trips, 183 coins, 29 wins, max drawdown 2.6%)
- Guardrails met: 183 distinct mints, all round trips ≥0.01 SOL, drawdown well under 50%
- For comparison, the kit's own pilots on the same window: sniper −0.42 SOL, momentum −9.45 SOL, reversion −4.37 SOL

The dev window is a hard, negative-sum tape for momentum — every configuration tested loses a little, and this one loses the least per coin traded while keeping enough entries to clear the guardrail on the shorter final window. If the final window runs hotter, the same entries catch the runners instead.

## Layout

- `main.ts` — entrypoint: wires the strategy to the SDK shim.
- `strategy.ts` — the bot. All trading logic, parameters, and the evidence for them live here.
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.

## Run it locally

```sh
# from the kit directory, against the dev dataset:
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```

Node 22, standard library only. No dependencies, no network, no clock, no randomness — the bot is a pure function of the batches it is fed, so two runs on the same replay match byte for byte.

## License

MIT — see [LICENSE](LICENSE).
