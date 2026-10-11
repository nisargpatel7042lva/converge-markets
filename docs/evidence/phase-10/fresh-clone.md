# Fresh-clone test

Run on 2026-10-11 from a real `git clone https://github.com/nisargpatel7042lva/converge-markets.git` into an empty directory, following the README step by step. Machine: WSL2 Linux, Node 24.10, pnpm 11.0.8, Foundry 1.8.4 (all named in the README's prerequisites). The pnpm store was warm, so the install time is not a cold-cache time.

## Result: PASS, after one documentation fix

| Step | Command | Result |
|---|---|---|
| 1 | `git clone …` | exit 0, anonymous clone works, commit `fa77616` |
| 2 | `pnpm install --frozen-lockfile` | exit 0, 5 s (warm store) |
| 3 | `make check-docs-10` | exit 0, 11 s: demo script 127 s of 180 s, thread posts within 280 characters, 0 figures missing from the ledger, 99 links resolve |
| 4 | `.demo/start.sh` | **FAILED the first time**: `contracts/out/MockERC20.sol/MockERC20.json` missing. **Doc drift:** the README did not say to build the contracts. Fixed in commit `15456cf`: the README now has `(cd contracts && forge build)` (21 s) before it. |
| 4b | `.demo/start.sh` after the fix | READY in 48 s; chain, contracts, keeper, scheduler and the app up on http://localhost:3100 |
| 5 | `curl` of `/`, `/markets`, `/stats`, `/api/status`, `/api/stats` | all HTTP 200; `/api/stats` on the local chain: vault $1,000, 0 rounds, $0 volume; the landing page contains "Call the next 15 minutes" |
| 6 | `cd apps/web && pnpm exec playwright test` (on this machine the browser needs `LD_LIBRARY_PATH=$HOME/.local/pwlibs/root/usr/lib/x86_64-linux-gnu`) | **10 passed** in 1.6 min |

## Raw log

```
[04:38:59] STEP 1: git clone https://github.com/nisargpatel7042lva/converge-markets.git
Cloning into 'converge-markets'...
exit 0
fa77616 phase 10: README, submission answers, demo script, pitch outline, launch thread and outreach, numbers ledger with a coverage check, chain-derived stats page for judges (volume, TVL, rounds, uptime), cost comparison and block-time evidence, hostile review
[04:39:45] STEP 2: pnpm install --frozen-lockfile
Scope: all 15 workspace projects
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +581
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 581, reused 580, downloaded 0, added 272
Progress: resolved 581, reused 580, downloaded 0, added 581, done

devDependencies:
+ @eslint/js 9.39.5
+ @types/node 22.20.5
+ eslint 9.39.5
+ prettier 3.9.9
+ typescript 5.9.3
+ typescript-eslint 8.71.0
+ vitest 2.1.9

Done in 4.6s using pnpm v11.0.8
[04:39:50] exit 0 after 5 s
[04:39:55] STEP 3: make check-docs-10
node scripts/docs/check-demo-script.mjs
0:00-0:20   42 words / budget 50  speaks in 16.8 s of 20 s  OK
0:20-1:00   67 words / budget 100  speaks in 26.8 s of 40 s  OK
1:00-1:40   70 words / budget 100  speaks in 28.0 s of 40 s  OK
1:40-2:20   68 words / budget 100  speaks in 27.2 s of 40 s  OK
2:20-2:45   45 words / budget 62  speaks in 18.0 s of 25 s  OK
2:45-3:00   26 words / budget 37  speaks in 10.4 s of 15 s  OK
total 318 words = 127.2 s at 150 wpm (limit 180 s, 450 words)
node scripts/docs/check-thread.mjs
 1/ 236 chars OK
 2/ 250 chars OK
 3/ 211 chars OK
 4/ 234 chars OK
 5/ 229 chars OK
 6/ 218 chars OK
 7/ 240 chars OK
 8/ 217 chars OK
 9/ 275 chars OK
10/ 230 chars OK
node scripts/docs/check-numbers.mjs
ledger: 44 rows; documents checked: 5; figures not in the ledger: 0
node scripts/docs/check-links.mjs
checked 99 links in 9 files (3 transactions, 8 addresses, 8 external)
warning  docs/submission.md: https://converge-markets-app.vercel.app answered 451 (reachable, but blocks automated checks or our region)
warning  docs/numbers.md: https://www.theblock.co/post/383733/prediction-markets-kalshi-polymarket-duopoly-2025 answered 403 (reachable, but blocks automated checks or our region)
[04:40:06] exit 0 after 11 s
[04:40:14] STEP 4: .demo/start.sh
[04:40:24] after 10 s
Error: ENOENT: no such file or directory, open '/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/contracts/ou
    at readFileSync (node:fs:440:20)
    at artifact (/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/services/keeper/test/support/stack.ts:56:24
    at deploy (/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/services/keeper/test/support/stack.ts:158:31)
    at deployStack (/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/services/keeper/test/support/stack.ts:16
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async main (/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/services/keeper/scripts/demo-stack.ts:42:
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/tmp/claude-1000/-home-mysterioxplorer/36709940-9cdf-4a54-a867-7d1ce9d3ff6f/scratchpad/fresh/converge-markets/contracts/out/MockERC20.sol/MockERC20.json'
}
[04:40:31] STEP 4a (found missing): cd contracts && forge build
Warning (2018): Function state mutability can be restricted to pure
   --> test/QuoteMath.t.sol:223:5:
    |
223 |     function testFuzz_quoteInvariants(
    |     ^ (Relevant source part starts here and spans across multiple lines).

[04:40:52] after 21 s
[04:41:07] pulled the README fix: 15456cf README: the demo needs forge build first (found by t
[04:41:09] STEP 4b: .demo/start.sh (contracts now built)
[04:41:57] after 48 s
[demo 04:41:35] building the app (about a minute)…
[demo 04:41:52] 
[demo 04:41:52] READY  open  http://localhost:3100  (a phone-sized window looks best)
[demo 04:41:52]        chain http://127.0.0.1:46637   vault 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853
[demo 04:41:52]        current round tradable right now: false
[demo 04:41:52]        Create an account (passkey), tap 'add money' for test USDC, place a bet, watch the keeper fill it, collect after the round.
[04:42:05] STEP 5: check the running demo
/ -> 200
/markets -> 200
/stats -> 200
/api/status -> 200
/api/stats -> 200
stats on the local chain: vault $ 1000 | rounds 0 | volume $ 0
Call the next 15 minutes
stopped
[04:42:16] STEP 6: end-to-end tests from the clone (cd apps/web && pnpm exec playwright test)
  ✓   1 e2e/first-trade.spec.ts:8:1 › landing to a confirmed first trade in under 60 seconds (8.9s)
  ✓   2 e2e/flows.spec.ts:35:3 › static pages and the edge › landing, legal, stats and the PWA files load with no console errors (952ms)
  ✓   3 e2e/flows.spec.ts:60:3 › static pages and the edge › a restricted region gets the explanation page (HTTP 451) for pages and the API (1.3
  ✓   4 e2e/flows.spec.ts:100:3 › exit path › a restricted region can still reach collect, withdraw and export, but not new bets (710ms)
  ✓   5 e2e/flows.spec.ts:120:3 › account › restoring with no passkey explains what to do; creating works; the recovery phrase is shown after a 
  ✓   6 e2e/flows.spec.ts:147:3 › trading states › no money: the trade sheet sends you to add money instead of failing (1.2s)
  ✓   7 e2e/flows.spec.ts:162:3 › trading states › a paused market shows a calm paused state and comes back (8.9s)
  ✓   8 e2e/flows.spec.ts:212:3 › vault › an LP can read the risk text, must tick the box, and requests a deposit (3.5s)
  ✓   9 e2e/flows.spec.ts:235:3 › a bet nobody fills › is shown as waiting, never offers a second bet, and can be cancelled for a full refund (1
  ✓  10 e2e/flows.spec.ts:276:3 › settlement › a winning bet is collected in one tap after the round resolves (15.2s)
  10 passed (1.6m)
[04:43:51] after 95 s
```
