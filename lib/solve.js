'use strict';
// 核心：给定棋子/羁绊数据与人口 N，求目标最大的阵容（整数规划，精确最优）
//
// 评分口径（--mode / mode）：
//   tiers（默认，羁绊质量）：一个羁绊每踩到一个断点算 1 档，第 2 档计 2 分；总分 = Σ档位
//   count（羁绊数量）：不同名激活羁绊各计 1 分（几档都只算 1 个）；总分 = 激活羁绊数
//
// 求解约束（opts，全部可选）：
//   topk      每个人口保留的解数（按 分数降序、同分费用降序 排序）
//   mode      'tiers' | 'count'
//   emblems   { 羁绊key: 纹章数 }：固定计入羁绊计数（不指定携带者），总数 ≤10 由调用方校验
//   banUnits  [棋子key]：从棋子池剔除
//   banTraits [羁绊key]：硬屏蔽——该羁绊不许激活（加权计数 ≤ 首断点-1）
//   pins      { 羁绊key: 至少档位数 }：固定羁绊至少激活 N 档（不指定则 1）
//
// 数据里的通用字段（与赛季无关）：
//   棋子 slots   占用栏位数（默认 1，如 S18 远古巨龙占 2）
//   棋子 weights 对某羁绊的计数权重（默认 1，如 S18 拉克丝形态羁绊 +2）
//   羁绊 tierRules 某档的激活条件（如 S18 宿敌第 1 档要求计数恰好为 1）
//   groups       互斥组（同组最多上场 1 个，如 S18 拉克丝各形态）

const glpkFactory = require('glpk.js/node').default;

// WASM 实例初始化约需 1 秒，全局只建一次
let _glpk = null;
async function getGlpk() {
  if (!_glpk) _glpk = glpkFactory();
  return _glpk;
}

/**
 * 计算一组棋子（+纹章）的羁绊明细：
 * counts(加权计数，含纹章)、tier(激活档位数，含档位激活条件)、reached(各断点是否命中)、
 * waste(超出最高已激活断点的计数)、emblem(纹章贡献的计数)
 */
function computeBreakdown(data, unitKeys, emblems = {}) {
  const byKey = new Map(data.champions.map(c => [c.key, c]));
  const counts = new Map();
  for (const [t, e] of Object.entries(emblems)) {
    if (e > 0) counts.set(t, (counts.get(t) || 0) + e);
  }
  for (const k of unitKeys) {
    const c = byKey.get(k);
    if (!c) throw new Error(`未知棋子: ${k}`);
    for (const t of c.traits) counts.set(t, (counts.get(t) || 0) + ((c.weights || {})[t] || 1));
  }
  const rows = [];
  for (const t of data.traits) {
    const count = counts.get(t.key) || 0;
    if (count === 0) continue;
    const ruleFor = i => (t.tierRules || []).find(r => r.tier === i + 1);
    let tier = 0;
    let highestActive = -1;
    const reached = t.breakpoints.map((b, i) => {
      const r = ruleFor(i);
      const ok = count >= b && (!r || count === r.exactCount);
      if (ok) { tier++; highestActive = i; }
      return ok;
    });
    const waste = highestActive >= 0 ? count - t.breakpoints[highestActive] : count;
    rows.push({
      trait: t.key, name: t.name, count, tier,
      breakpoints: t.breakpoints, reached, waste,
      emblem: emblems[t.key] || 0, active: tier > 0,
    });
  }
  rows.sort((a, b) => b.tier - a.tier || b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return rows;
}

function signature(rows) {
  return rows.filter(r => r.active).map(r => `${r.trait}:${r.tier}`).sort().join(',');
}

/** 按分数降序、同分按队伍总费用降序（贵的排前）排序结果 */
function sortResults(byKey, results) {
  const cost = r => r.unitKeys.reduce((s, k) => s + (byKey.get(k)?.cost || 0), 0);
  return [...results].sort((a, b) => b.score - a.score || cost(b) - cost(a));
}

// 互斥组统一取成员列表：兼容旧版纯数组 [{key}...] 与新版 {name, units} 两种结构
const groupUnits = data => (data.groups || [])
  .map(g => (Array.isArray(g) ? g : g.units))
  .filter(u => Array.isArray(u) && u.length > 0);

const normOpts = (data, level, opts) => {
  if (typeof opts === 'number') opts = { topk: opts };
  const o = {
    topk: opts.topk ?? 3,
    mode: opts.mode === 'count' ? 'count' : 'tiers',
    emblems: opts.emblems || {},
    banUnits: new Set(opts.banUnits || []),
    banTraits: new Set(opts.banTraits || []),
    pins: opts.pins || {},
    maxIter: opts.maxIter || 120,
  };
  const traitByKey = new Map(data.traits.map(t => [t.key, t]));
  for (const k of o.banTraits) {
    if (!traitByKey.has(k)) throw new Error(`未知羁绊: ${k}`);
    if (o.pins[k] != null) throw new Error(`羁绊不能既屏蔽又固定`);
    if ((o.emblems[k] || 0) > 0) throw new Error(`被屏蔽的羁绊不能上纹章`);
  }
  for (const [k, n] of Object.entries(o.pins)) {
    const t = traitByKey.get(k);
    if (!t) throw new Error(`未知羁绊: ${k}`);
    if (!Number.isInteger(n) || n < 1) throw new Error(`固定档位需为正整数: ${t.name}=${n}`);
    if (n > t.breakpoints.length) throw new Error(`${t.name} 只有 ${t.breakpoints.length} 档，无法固定到第 ${n} 档`);
  }
  if (!Number.isInteger(level) || level < 0) throw new Error(`人口需为非负整数: ${level}`);
  return o;
};

/**
 * 求某人口档的 Top-K 阵容（按 分数降序、同分费用降序；同分给不同羁绊构成的并列解）。
 * 通过"禁止重复解"约束（no-good cut）迭代枚举，去重维度是羁绊档位构成。
 */
async function solveLevel(data, level, opts = {}) {
  const glpk = await getGlpk();
  const o = normOpts(data, level, opts);
  const emblems = o.emblems;
  const U = data.champions.filter(c => !o.banUnits.has(c.key));
  const byKey = new Map(U.map(c => [c.key, c]));
  const x = i => `x${i}`;
  const y = (ti, bi) => `y${ti}_${bi}`;
  const z = ti => `z${ti}`;

  const binaries = U.map((_, i) => x(i));
  const objVars = [];
  const subjectTo = [];

  // 人口：栏位占用合计恰好为 N（远古巨龙等占多格的棋子按 slots 计）
  subjectTo.push({
    name: 'board',
    vars: U.map((c, i) => ({ name: x(i), coef: c.slots || 1 })),
    bnds: { type: glpk.GLP_FX, lb: level, ub: level },
  });

  // 互斥组：组内最多 1 个（如拉克丝各形态）；只约束在当前棋子池里的成员，不足 2 个则无需约束
  // （带必带棋子的子问题会从池中移除组员，这里必须容忍缺员而不是报错）
  groupUnits(data).forEach((g, gi) => {
    const idxs = g.map(k => U.findIndex(c => c.key === k)).filter(i => i >= 0);
    if (idxs.length < 2) return;
    subjectTo.push({
      name: `group${gi}`,
      vars: idxs.map(i => ({ name: x(i), coef: 1 })),
      bnds: { type: glpk.GLP_UP, lb: 0, ub: 1 },
    });
  });

  data.traits.forEach((t, ti) => {
    const E = emblems[t.key] || 0;
    const members = U.map((c, i) => ({ i, w: (c.weights || {})[t.key] || (c.traits.includes(t.key) ? 1 : 0) }))
      .filter(m => m.w > 0);

    if (o.banTraits.has(t.key)) {
      // 硬屏蔽：该羁绊不许激活 —— 加权计数(含纹章，但纹章与屏蔽互斥已在前面校验) ≤ 首断点 - 1
      if (members.length === 0) return;
      subjectTo.push({
        name: `ban_t${ti}`,
        vars: members.map(m => ({ name: x(m.i), coef: m.w })),
        bnds: { type: glpk.GLP_UP, lb: 0, ub: t.breakpoints[0] - 1 },
      });
      return;
    }

    if (members.length === 0 && E === 0) return;
    const ys = [];
    t.breakpoints.forEach((b, bi) => {
      const yName = y(ti, bi);
      // 档位激活：y[t,i]=1 蕴含 加权计数(棋子+纹章) >= 第 i 个断点
      const vars = members.map(m => ({ name: x(m.i), coef: m.w }));
      vars.push({ name: yName, coef: -b });
      subjectTo.push({ name: `t${ti}_${bi}`, vars, bnds: { type: glpk.GLP_LO, lb: -E, ub: 0 } });
      // 档位激活条件（如宿敌第1档要求计数恰好为1）：count + M·y ≤ exactCount + M（count 含纹章）
      const rule = (t.tierRules || []).find(r => r.tier === bi + 1);
      if (rule) {
        const M = members.reduce((s, m) => s + m.w, 0) + E; // 该羁绊计数上界
        const exVars = members.map(m => ({ name: x(m.i), coef: m.w }));
        exVars.push({ name: yName, coef: M });
        subjectTo.push({ name: `t${ti}_${bi}_ex`, vars: exVars, bnds: { type: glpk.GLP_UP, lb: 0, ub: rule.exactCount + M - E } });
      }
      binaries.push(yName);
      ys.push(yName);
      objVars.push({ name: yName, coef: o.mode === 'count' ? 0 : 1 });
    });

    // 固定羁绊：至少 N 档被激活
    const pin = o.pins[t.key];
    if (pin != null) {
      if (ys.length === 0) throw new Error(`羁绊 ${t.name} 无法固定（无棋子且无纹章）`);
      subjectTo.push({
        name: `pin_t${ti}`,
        vars: ys.map(n => ({ name: n, coef: 1 })),
        bnds: { type: glpk.GLP_LO, lb: pin, ub: 0 },
      });
    }

    // 羁绊数量模式：z[t]=1 表示该羁绊激活（踩到任一断点），目标 max Σz
    // 双向约束：y ≤ z（有档位激活则 z 必为 1）；Σy ≥ z（z 为 1 必须真的激活了至少一档）
    if (o.mode === 'count' && ys.length > 0) {
      const zName = z(ti);
      binaries.push(zName);
      ys.forEach((yn, bi) => {
        subjectTo.push({
          name: `z${ti}_${bi}`,
          vars: [{ name: yn, coef: 1 }, { name: zName, coef: -1 }],
          bnds: { type: glpk.GLP_UP, lb: 0, ub: 0 },
        });
      });
      subjectTo.push({
        name: `zs${ti}`,
        vars: ys.map(n => ({ name: n, coef: 1 })).concat([{ name: zName, coef: -1 }]),
        bnds: { type: glpk.GLP_LO, lb: 0, ub: 0 },
      });
      objVars.push({ name: zName, coef: 1 });
    }
  });

  const base = {
    name: `set${data.set}_lv${level}_${o.mode}`,
    objective: { direction: glpk.GLP_MAX, name: o.mode === 'count' ? 'traits' : 'tiers', vars: objVars },
    subjectTo,
    binaries,
  };

  const scoreOf = rows => o.mode === 'count'
    ? rows.filter(r => r.active).length
    : rows.reduce((s, r) => s + r.tier, 0);

  const results = [];
  const seen = new Set();
  const cuts = [];
  for (let iter = 0; iter < o.maxIter; iter++) {
    const lp = { ...base, subjectTo: base.subjectTo.concat(cuts) };
    const r = await glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });
    // 无可行解时 glpk.js 仍会返回 result（status=GLP_NOFEAS，vars 全零），必须按状态判断
    if (!r || !r.result || r.result.status !== glpk.GLP_OPT) break; // 无可行解：枚举 exhausted
    const chosen = [];
    U.forEach((c, i) => { if (r.result.vars[x(i)] > 0.5) chosen.push(c.key); });
    const rows = computeBreakdown({ ...data, champions: U }, chosen, emblems);
    const score = scoreOf(rows);
    const sig = signature(rows);
    if (!seen.has(sig)) {
      seen.add(sig);
      results.push({ level, score, unitKeys: chosen, breakdown: rows });
      if (results.length >= o.topk) break;
    }
    // no-good cut：排除与本解完全相同的棋子组合（按棋子个数-1，兼容多格棋子）
    cuts.push({
      name: `ng${iter}`,
      vars: chosen.map(k => ({ name: x(U.findIndex(c => c.key === k)), coef: 1 })),
      bnds: { type: glpk.GLP_UP, lb: 0, ub: chosen.length - 1 },
    });
  }
  return sortResults(byKey, results);
}

/**
 * 带必带棋子的单人口求解：锁定 lockedKeys，在剩余栏位里求最优，再把羁绊明细拼回完整阵容。
 * 不修改传入的 data；人口装不下必带棋子时抛错。供 CLI（--units）与 Web API 共用。
 */
async function solveWithLocked(data, lockedKeys, level, opts = {}) {
  const o = normOpts(data, level, opts);
  const byKeyAll = new Map(data.champions.map(c => [c.key, c]));
  for (const k of lockedKeys) {
    if (!byKeyAll.has(k)) throw new Error(`未知棋子: ${k}`);
    if (o.banUnits.has(k)) throw new Error(`棋子不能既必带又屏蔽: ${byKeyAll.get(k).name}`);
  }
  const locked = new Set(lockedKeys);
  // 互斥组：必带棋子所在组的其他成员禁用（如已带一种拉克丝形态，其余形态不可再上场）
  const banned = new Set();
  for (const g of groupUnits(data)) {
    if (g.some(k => locked.has(k))) g.forEach(k => { if (!locked.has(k)) banned.add(k); });
  }
  const usable = data.champions.filter(c => !banned.has(c.key) && !o.banUnits.has(c.key)); // 含必带棋子
  const byKey = new Map(usable.map(c => [c.key, c]));
  const lockedSlots = lockedKeys.reduce((s, k) => s + (byKey.get(k)?.slots || 1), 0);
  const remain = level - lockedSlots;
  if (remain < 0) throw new Error(`人口${level}装不下必带棋子（必带共占 ${lockedSlots} 格）`);
  const sub = { ...data, champions: usable.filter(c => !locked.has(c.key)) };
  const subResults = await solveLevel(sub, remain, opts);
  const fullData = { ...data, champions: usable };
  const scoreOf = rows => o.mode === 'count'
    ? rows.filter(r => r.active).length
    : rows.reduce((s, x) => s + x.tier, 0);
  return sortResults(byKey, subResults.map(r => {
    const unitKeys = lockedKeys.concat(r.unitKeys);
    const breakdown = computeBreakdown(fullData, unitKeys, o.emblems);
    const score = scoreOf(breakdown);
    return { level, score, unitKeys, breakdown };
  }));
}

module.exports = { solveLevel, solveWithLocked, computeBreakdown };
