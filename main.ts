// Breakout scalper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts
// (a deterministic breakout scalper tuned on the kit's dev window; see its
// header for the evidence), and the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte. main.ts wires the two
// together and nothing else: every trading decision is made in
// strategy.ts, so the entrypoint stays small and the strategy stays the
// unit under test.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
