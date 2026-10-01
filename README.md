# TFT Max-Synergies Calculator

[English](README.md) | [简体中文](README.zh-CN.md)

Given a board size (levels 6–10), find the composition that **maximizes the total number of active trait tiers** from the current set's unit pool. Zero waste is *not* required — trait counts may overflow breakpoints. Scoring: every breakpoint a trait reaches counts as one tier (a trait at its 2nd tier scores 2), and the objective is the sum across all traits. Same idea as [tactics.tools' perfect-synergies](https://tactics.tools/zh/perfect-synergies), but with the tier-sum metric and no perfection requirement.

Current data: **Set 18 "Enchanted Wilds"** (source: [CommunityDragon](https://raw.communitydragon.org/latest/cdragon/tft/zh_cn.json), zh_CN locale names). Solving is an exact integer program (glpk.js — a WASM build of GLPK); results are provably optimal, not heuristic.

## Usage

```bash
npm install

node cli.js                       # Set 18, levels 6-10, 5 comps per level (score desc, then cost desc)
node cli.js --levels 8-10         # only levels 8, 9, 10
node cli.js --levels 7,9 --topk 5 # specific levels, fewer/more comps
node cli.js --units 卡兹克 --level 7        # lock must-include units, optimize the rest
node cli.js --mode count          # scoring: count distinct active traits (default: tier sum)
node cli.js --emblem 地狱火,地狱火 --level 8 # emblems (max 10) add fixed trait counts
node cli.js --ban-5cost --ban-unit 远古巨龙  # ban all 5-costs / any units
node cli.js --ban-trait 法师 --level 8      # hard-ban a trait (must not activate)
node cli.js --pin 月蚀骑士=3,宿敌 --level 8 # pin traits to at least N tiers (default 1)
node cli.js --json                # machine-readable output
```

`--units` takes unit names as they appear in `data/s18_summary.md` (Chinese names).

Reference results for Set 18 (patch 18.3 data, Kha'Zix fully evolved): **level 6 → 13 tiers ·
7 → 14 · 8 → 16 · 9 → 18 · 10 → 19** (unevolved boards score about 2 tiers lower).

## Web UI

```bash
npm run serve            # or: node server.js [--port 8080]  (PORT env var also works)
```

Open http://localhost:8080 — pick the set (a dropdown that auto-discovers every `data/s{N}.json`,
so newly extracted sets show up without code changes), levels (multi-select), comps per level
(5 or 10), the scoring mode (tier sum vs distinct-trait count), must-include units, emblems
(up to 10, stacked per trait), pinned traits with a tier stepper, and banned units/traits
(including a one-click ban-all-5-cost). Every picker opens as a full dropdown on click — no typing needed, though
typing still filters. Results render as cost-colored unit chips plus a per-trait tier breakdown
with hit breakpoints highlighted, sorted by score then total cost (expensive first). `server.js`
is a zero-dependency Node HTTP server whose `/api/solve` reuses `lib/solve.js`, so results are
identical to the CLI. Heads-up: higher levels solve slower (level 10 takes ~30s+ on S18 data);
the page fires one request per selected level and renders each as it returns.

## Updating data (once per set)

```bash
node scripts/extract.js 19        # auto-downloads latest CommunityDragon data -> data/s19.json
node scripts/extract.js 19 --refresh  # force re-download of the raw file
node cli.js --set 19
```

Set data is organized as **regular units + special units**. Regular units need no declaration —
they follow the default rules (occupy 1 slot, +1 count to each of their traits; breakpoints come
straight from trait data). Special units are declared one by one in `sets/s{N}.rules.js`
(`specialUnits`: exclusive groups, count weights, slot counts, tier activation conditions); the
extraction script compiles them into generic fields in the data JSON, keeping the solver
season-agnostic. The extractor also generates `data/s{N}_summary.md` (a manual checklist); after
switching sets, review it and run a with-rules vs. without-rules diff to confirm the rules only
affect the intended units.

## Set 18 special units (declared in `sets/s18.rules.js`)

- **Lux (Elementalist / Avatar)**: 10 forms (including the form-less Base) form an exclusive
  group — at most one on the board. In-game description: once you own one, every other Lux in
  your shop converts to the same trait. Her form trait counts **+2**.
- **Rivals (Kha'Zix / Rengar)**: breakpoints 1/1/2, and **tier 1 only activates with exactly one
  Rival on the board**: solo = tiers 1+2, both = tiers 2+3 — 2 tiers either way.
- **Kha'Zix evolution**: takedowns let him permanently gain one trait chosen from
  Executioner / Quickshot / Berserker / Spellweaver (up to 3 times, no repeats). Modeled as
  15 mutually exclusive variant units (evolve 0–3; same 3-cost, same Rivals count) declared in
  the rules file — the solver picks the best evolution path automatically, and mid-game boards
  can lock a specific evolution via `--units`. Rengar's gold/AD rewards are combat effects and
  are not modeled.
- **Elder Dragon**: **occupies 2 board slots** and provides **+2 Riftbeasts count** (verbatim
  from the Apex Predator trait description). 5-cost. Empirical result: despite the double count,
  no optimal level 6–10 board contains Elder Dragon — 2 slots for 1 guaranteed tier plus Riftbeast
  progress loses to two regular units each hitting a 2-breakpoint.
- Unique traits (Gem Knight, The Green Father, Bounty Hunter, etc. — 9 traits whose only
  breakpoint is 1) are **regular mechanics** handled automatically by the breakpoint data; no
  declaration needed.
- Riftbeasts tier 10 grants +team size; ignored under the fixed-level model (that tier needs 10
  counts, only reachable by an all-Riftbeast board).

## Scoring & model

- Regular unit: 1 slot, +1 count to each of its traits. Special units are handled through generic
  data-JSON fields: `slots` (board slots), `weights` (trait count weights), `tierRules` (tier
  activation conditions), `groups` (exclusive groups).
- Trait tier = number of its breakpoints reached (duplicates allowed, e.g. Rivals 1/1/2).
- Two scoring modes: **tiers** (default) maximizes Σ tiers; **count** maximizes the number of
  distinct active traits (`z[trait]` indicators with `y ≤ z ≤ Σy`).
- Integer program: `x[unit] ∈ {0,1}`; board constraint `Σ slots·x = N`; exclusive groups
  `Σx ≤ 1`; tier variables `y[trait, breakpoint]` with `weighted count ≥ breakpoint·y` (tiers
  with activation conditions additionally get `count + M·y ≤ required + M` to force the exact
  count); emblems add fixed counts `E` to their trait (rows become `Σw·x ≥ b·y − E`);
  banned traits forbid activation (`weighted count ≤ first breakpoint − 1`); pinned traits
  require `Σ_b y ≥ N`.
- Top-K tied solutions: enumerated iteratively with no-good cuts, deduplicated by trait-tier
  signature; final order is score desc, then total unit cost desc.

## Project layout

```
cli.js              CLI entry
server.js           web UI server (static files + /api/data, /api/solve)
web/                web UI frontend (vanilla HTML/CSS/JS, no build step)
lib/solve.js        solver (ILP model + Top-K enumeration + trait breakdown)
scripts/extract.js  CommunityDragon data extraction (interprets sets/s{N}.rules.js)
sets/s18.rules.js   Set 18 special-unit rules, one rules file per set
data/s18.json       Set 18 structured data (units / traits / groups / weights)
data/s18_summary.md Set 18 manual checklist
raw/                raw downloads (.gitignored)
```

## Cross-platform (Windows / Ubuntu)

- Pure JavaScript + WebAssembly, **zero native dependencies**: the glpk.js solver only depends on
  pure-JS pako and ships as js + wasm; nothing platform-specific lands in node_modules — the
  `npm install` result is identical on Windows and Ubuntu (the project folder can even be copied
  across as-is).
- All file paths go through `path.join` / `__dirname`; no drive letters, no hardcoded separators,
  no `process.platform` branches.
- Requires **Node ≥ 18** (uses global fetch; developed and verified on Windows + Node 24).
- On Ubuntu:
  ```bash
  sudo apt install nodejs npm   # or install Node 18+ via nvm
  npm install && node cli.js
  ```
- Output is UTF-8: Ubuntu terminals are UTF-8 by default; on Windows prefer Windows Terminal /
  Git Bash — legacy cmd code pages (cp936) may garble Chinese display (display-only; `--json`
  output is unaffected).

## Known limitations / roadmap

- Emblems are modeled as fixed team-level trait counts (up to 10, no carrier); a
  solver-optimized emblem mode and Augments are not modeled.
- No general cost cap yet (only ban-5cost / ban-unit); a `--max-cost` flag is a natural next
  step.
- The Riftbeasts tier-10 +team-size reward is not modeled.
