#!/usr/bin/env node
'use strict';
// 云顶之弈/金铲铲 最大羁绊计算器（CLI）
// 用法:
//   node cli.js                        # S18, 6-10人口, 每档3套阵容
//   node cli.js --levels 8-10 --topk 5
//   node cli.js --set 18 --levels 7,9 --json
//   node cli.js --units 拉克丝(地狱火),墨菲特 --level 9   # 固定必带棋子，算剩余最优补法

const fs = require('fs');
const path = require('path');
const { solveLevel, solveWithLocked } = require('./lib/solve');

function parseArgs(argv) {
  const args = { set: 18, levels: null, topk: 3, json: false, units: null, level: null, data: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--set') args.set = Number(next());
    else if (a === '--levels') args.levels = next();
    else if (a === '--level') args.level = Number(next());
    else if (a === '--topk') args.topk = Number(next());
    else if (a === '--units') args.units = next();
    else if (a === '--json') args.json = true;
    else if (a === '--data') args.data = next();
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  if (args.levels) {
    args.levels = args.levels.includes('-')
      ? range(...args.levels.split('-').map(Number))
      : args.levels.split(',').map(Number);
  } else if (args.level != null) {
    args.levels = [args.level];
  } else {
    args.levels = range(6, 10);
  }
  return args;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function printResult(data, res) {
  const byKey = new Map(data.champions.map(c => [c.key, c]));
  const traitByKey = new Map(data.traits.map(t => [t.key, t]));
  const units = res.unitKeys.map(k => byKey.get(k)).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'zh'));
  const cost = units.reduce((s, c) => s + c.cost, 0);
  const slots = units.reduce((s, c) => s + (c.slots || 1), 0);
  const slotNote = slots !== units.length ? `, 占${slots}格` : '';
  console.log(`  阵容(${units.length}个${slotNote}, ${cost}费): ${units.map(c => c.name + ((c.slots || 1) > 1 ? `(占${c.slots}格)` : '')).join(' · ')}`);
  const active = res.breakdown.filter(r => r.active);
  const inactive = res.breakdown.filter(r => !r.active);
  for (const r of active) {
    const waste = r.waste > 0 ? ` 浪费+${r.waste}` : '';
    const rules = (traitByKey.get(r.trait).tierRules || []).map(rr => `, 第${rr.tier}档需计数=${rr.exactCount}`).join('');
    console.log(`    ${r.name} ${r.count} → ${r.tier}档 (断点${r.breakpoints.join('/')}${rules}${waste})`);
  }
  if (inactive.length) console.log(`    （未激活: ${inactive.map(r => `${r.name}x${r.count}`).join(', ')}）`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node cli.js [--set 18] [--levels 6-10|6,7,8] [--topk 3] [--json] [--units 名1,名2 --level 9]');
    return;
  }
  const dataDir = args.data || path.join(__dirname, 'data');
  const file = path.join(dataDir, `s${args.set}.json`);
  if (!fs.existsSync(file)) {
    console.error(`找不到数据文件 ${file}，先运行: node scripts/extract.js ${args.set}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // --units: 必带棋子（先从数据里锁定，再在剩余人口里求最优）
  let lockedKeys = [];
  if (args.units) {
    const norm = s => s.replace(/\s+/g, ''); // 名字匹配忽略空格（如 "拉克丝(地狱火)" 也能匹配 "拉克丝 (地狱火)"）
    const names = args.units.split(',').map(s => s.trim()).filter(Boolean);
    for (const n of names) {
      const hit = data.champions.find(c => c.name === n) || data.champions.find(c => norm(c.name).includes(norm(n)));
      if (!hit) { console.error(`棋子不存在: ${n}（用 data/s${args.set}_summary.md 里的名字）`); process.exit(1); }
      lockedKeys.push(hit.key);
    }
    if (lockedKeys.length && args.level == null) { console.error('--units 需要配合 --level 使用'); process.exit(1); }
    for (const lv of args.levels) {
      console.log(`══ ${lv}人口（必带: ${lockedKeys.map(k => data.champions.find(c => c.key === k).name).join(', ')}）`);
      let results;
      try { results = await solveWithLocked(data, lockedKeys, lv, args.topk); }
      catch (e) { console.error(e.message); process.exit(1); }
      for (const r of results) printResult(data, r);
    }
    return;
  }

  const jsonOut = [];
  for (const lv of args.levels) {
    const t0 = Date.now();
    const results = await solveLevel(data, lv, args.topk);
    const ms = Date.now() - t0;
    if (args.json) { jsonOut.push(...results.map(r => ({ ...r, ms }))); continue; }
    const best = results[0];
    if (!best) { console.log(`══ ${lv}人口: 无可行解`); continue; }
    console.log(`══ ${lv}人口 · 最大羁绊档位: ${best.score} · ${ms}ms`);
    results.forEach((r, i) => {
      if (i > 0) console.log(`  -- 并列/次优 (${r.score}档) --`);
      printResult(data, r);
    });
  }
  if (args.json) console.log(JSON.stringify(jsonOut, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
