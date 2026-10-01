#!/usr/bin/env node
'use strict';
// 云顶之弈/金铲铲 最大羁绊计算器（CLI）
// 用法:
//   node cli.js                                   # S18, 6-10人口, 每档8套（分数降序、同分费用降序）
//   node cli.js --levels 8-10 --topk 5
//   node cli.js --units 拉克丝(地狱火),墨菲特 --level 9     # 固定必带棋子，算剩余最优补法
//   node cli.js --mode count                      # 羁绊数量模式（默认 tiers 羁绊质量/档位总和）
//   node cli.js --emblem 地狱火,地狱火,法师 --level 8      # 纹章（≤10个）直接计入羁绊计数
//   node cli.js --ban-5cost --ban-unit 远古巨龙 --level 8  # 屏蔽5费/任意棋子
//   node cli.js --ban-trait 法师,护卫 --level 8            # 硬屏蔽羁绊（不许激活）
//   node cli.js --pin 月蚀骑士=3,宿敌 --level 8            # 固定羁绊至少 N 档（省略 =1）

const fs = require('fs');
const path = require('path');
const { solveLevel, solveWithLocked, computeBreakdown } = require('./lib/solve');

function parseArgs(argv) {
  const args = {
    set: 18, levels: null, topk: 8, json: false, units: null, level: null, data: null,
    mode: 'tiers', emblem: null, banUnit: null, ban5cost: false, banTrait: null, pin: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--set') args.set = Number(next());
    else if (a === '--levels') args.levels = next();
    else if (a === '--level') args.level = Number(next());
    else if (a === '--topk') args.topk = Number(next());
    else if (a === '--units') args.units = next();
    else if (a === '--mode') args.mode = next();
    else if (a === '--emblem') args.emblem = next();
    else if (a === '--ban-unit') args.banUnit = next();
    else if (a === '--ban-5cost') args.ban5cost = true;
    else if (a === '--ban-trait') args.banTrait = next();
    else if (a === '--pin') args.pin = next();
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

// 名字解析：先精确匹配，再忽略空格包含匹配（"拉克丝(地狱火)" 也能匹配 "拉克丝 (地狱火)"）
const norm = s => String(s).replace(/\s+/g, '');
const resolveUnit = (data, q) =>
  data.champions.find(c => c.name === q) || data.champions.find(c => norm(c.name).includes(norm(q)));
const resolveTrait = (data, q) =>
  data.traits.find(t => t.name === q) || data.traits.find(t => norm(t.name).includes(norm(q)));

/** 把 CLI 参数编译成求解器 opts（含名字→key 解析与前置校验），出错时打印并退出 */
function buildOpts(data, args) {
  const opts = { topk: args.topk, mode: args.mode === 'count' ? 'count' : 'tiers', emblems: {}, banUnits: [], banTraits: [], pins: {} };

  if (args.ban5cost) opts.banUnits.push(...data.champions.filter(c => c.cost === 5).map(c => c.key));

  for (const n of (args.banUnit || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const hit = resolveUnit(data, n);
    if (!hit) { console.error(`棋子不存在: ${n}（用 data/s${args.set}_summary.md 里的名字）`); process.exit(1); }
    opts.banUnits.push(hit.key);
  }

  const emblemNames = (args.emblem || '').split(',').map(s => s.trim()).filter(Boolean);
  if (emblemNames.length > 10) { console.error(`纹章最多 10 个，给了 ${emblemNames.length} 个`); process.exit(1); }
  for (const n of emblemNames) {
    const hit = resolveTrait(data, n);
    if (!hit) { console.error(`羁绊不存在: ${n}`); process.exit(1); }
    if (hit.unique) { console.error(`独有羁绊没有纹章: ${hit.name}`); process.exit(1); }
    opts.emblems[hit.key] = (opts.emblems[hit.key] || 0) + 1;
  }

  for (const n of (args.banTrait || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const hit = resolveTrait(data, n);
    if (!hit) { console.error(`羁绊不存在: ${n}`); process.exit(1); }
    opts.banTraits.push(hit.key);
  }

  for (const item of (args.pin || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [n, tierStr] = item.split('=');
    const hit = resolveTrait(data, n.trim());
    if (!hit) { console.error(`羁绊不存在: ${n}`); process.exit(1); }
    const tier = tierStr == null ? 1 : Number(tierStr);
    if (!Number.isInteger(tier) || tier < 1 || tier > hit.breakpoints.length) {
      console.error(`固定档位无效: ${hit.name}=${tier}（该羁绊共 ${hit.breakpoints.length} 档）`); process.exit(1);
    }
    opts.pins[hit.key] = tier;
  }
  return opts;
}

function printResult(data, res, opts) {
  const byKey = new Map(data.champions.map(c => [c.key, c]));
  const traitByKey = new Map(data.traits.map(t => [t.key, t]));
  const units = res.unitKeys.map(k => byKey.get(k)).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'zh'));
  const cost = units.reduce((s, c) => s + c.cost, 0);
  const slots = units.reduce((s, c) => s + (c.slots || 1), 0);
  const slotNote = slots !== units.length ? `, 占${slots}格` : '';
  console.log(`  阵容(${units.length}个${slotNote}, ${cost}费): ${units.map(c => c.name + ((c.slots || 1) > 1 ? `(占${c.slots}格)` : '')).join(' · ')}`);
  const emblemEntries = Object.entries(opts.emblems || {}).filter(([, n]) => n > 0);
  if (emblemEntries.length) {
    console.log(`  纹章: ${emblemEntries.map(([k, n]) => `${traitByKey.get(k)?.name || k}×${n}`).join(', ')}`);
  }
  const active = res.breakdown.filter(r => r.active);
  const inactive = res.breakdown.filter(r => !r.active);
  for (const r of active) {
    const em = r.emblem > 0 ? `(纹章+${r.emblem})` : '';
    const waste = r.waste > 0 ? ` 浪费+${r.waste}` : '';
    const rules = (traitByKey.get(r.trait).tierRules || []).map(rr => `, 第${rr.tier}档需计数=${rr.exactCount}`).join('');
    console.log(`    ${r.name} ${r.count}${em} → ${r.tier}档 (断点${r.breakpoints.join('/')}${rules}${waste})`);
  }
  if (inactive.length) console.log(`    （未激活: ${inactive.map(r => `${r.name}x${r.count}`).join(', ')}）`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node cli.js [--set 18] [--levels 6-10|6,7,8] [--topk 8] [--json] [--mode tiers|count]');
    console.log('            [--units 名1,名2 --level 9] [--emblem 羁绊,羁绊(≤10)] [--ban-unit 名1,名2] [--ban-5cost]');
    console.log('            [--ban-trait 羁绊1,羁绊2] [--pin 羁绊1=档位,羁绊2]');
    return;
  }
  const dataDir = args.data || path.join(__dirname, 'data');
  const file = path.join(dataDir, `s${args.set}.json`);
  if (!fs.existsSync(file)) {
    console.error(`找不到数据文件 ${file}，先运行: node scripts/extract.js ${args.set}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const opts = buildOpts(data, args);
  const scoreLabel = opts.mode === 'count' ? '羁绊数量' : '羁绊档位';

  // --units: 必带棋子（先从数据里锁定，再在剩余人口里求最优）
  let lockedKeys = [];
  if (args.units) {
    const names = args.units.split(',').map(s => s.trim()).filter(Boolean);
    for (const n of names) {
      const hit = resolveUnit(data, n);
      if (!hit) { console.error(`棋子不存在: ${n}（用 data/s${args.set}_summary.md 里的名字）`); process.exit(1); }
      lockedKeys.push(hit.key);
    }
    if (lockedKeys.length && args.level == null) { console.error('--units 需要配合 --level 使用'); process.exit(1); }
    for (const lv of args.levels) {
      console.log(`══ ${lv}人口（必带: ${lockedKeys.map(k => data.champions.find(c => c.key === k).name).join(', ')}）`);
      let results;
      try { results = await solveWithLocked(data, lockedKeys, lv, opts); }
      catch (e) { console.error(e.message); process.exit(1); }
      for (const r of results) printResult(data, r, opts);
    }
    return;
  }

  const jsonOut = [];
  for (const lv of args.levels) {
    const t0 = Date.now();
    let results;
    try { results = await solveLevel(data, lv, opts); }
    catch (e) { console.error(e.message); process.exit(1); }
    const ms = Date.now() - t0;
    if (args.json) { jsonOut.push(...results.map(r => ({ ...r, ms }))); continue; }
    const best = results[0];
    if (!best) { console.log(`══ ${lv}人口: 无可行解`); continue; }
    console.log(`══ ${lv}人口 · 最大${scoreLabel}: ${best.score} · ${ms}ms`);
    results.forEach((r, i) => {
      if (i > 0) console.log(`  -- 并列/次优 (${r.score}${opts.mode === 'count' ? '个' : '档'}) --`);
      printResult(data, r, opts);
    });
  }
  if (args.json) console.log(JSON.stringify(jsonOut, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
