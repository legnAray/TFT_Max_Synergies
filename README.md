# TFT Max-Synergies Calculator

[English](README.md) | [简体中文](README.zh-CN.md)

Given a board size (levels 6–10), find the composition that **maximizes the total number of active trait tiers** from the current set's unit pool. Zero waste is *not* required — trait counts may overflow breakpoints. Scoring: every breakpoint a trait reaches counts as one tier (a trait at its 2nd tier scores 2), and the objective is the sum across all traits. Same idea as [tactics.tools' perfect-synergies](https://tactics.tools/zh/perfect-synergies), but with the tier-sum metric and no perfection requirement.

Current data: **Set 18 "Enchanted Wilds"** (source: [CommunityDragon](https://raw.communitydragon.org/latest/cdragon/tft/zh_cn.json), zh_CN locale names). Solving is an exact integer program (glpk.js — a WASM build of GLPK); results are provably optimal, not heuristic.

## Usage

```bash
npm install

node cli.js                       # Set 18, levels 6-10, 3 optimal/tied comps per level
node cli.js --levels 8-10         # only levels 8, 9, 10
node cli.js --levels 7,9 --topk 5 # specific levels, more tied solutions
node cli.js --units 卡兹克 --level 7   # lock must-include units, optimize the rest
node cli.js --json                # machine-readable output (for the future web UI)
```

`--units` takes unit names as they appear in `data/s18_summary.md` (Chinese names).

Reference results for Set 18 (patch 18.3 data): **level 6 → 11 tiers · 7 → 12 · 8 → 14 · 9 → 16 · 10 → 17**.

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
- Trait tier = number of its breakpoints reached (duplicates allowed, e.g. Rivals 1/1/2);
  total score = Σ tiers.
- Integer program: `x[unit] ∈ {0,1}`; board constraint `Σ slots·x = N`; exclusive groups
  `Σx ≤ 1`; tier variables `y[trait, breakpoint]` with `weighted count ≥ breakpoint·y` (tiers
  with activation conditions additionally get `count + M·y ≤ required + M` to force the exact
  count); maximize `Σy`.
- Top-K tied solutions: enumerated iteratively with no-good cuts, deduplicated by trait-tier
  signature.

## Project layout

```
cli.js              CLI entry
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

- No emblem (trait spatula), Augment/hex, or cost-cap constraints yet (a `--max-cost` flag is a
  natural next step).
- The Riftbeasts tier-10 +team-size reward is not modeled.
- Next up: a web UI (reusing `lib/solve.js` and the `--json` output).
