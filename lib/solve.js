'use strict';
// 核心：给定棋子/羁绊数据与人口 N，求"羁绊档位总和"最大的阵容（整数规划，精确最优）
//
// 评分口径：一个羁绊每踩到一个断点算 1 档，第 2 档就计 2 分；总和 = Σ各激活羁绊的档位数。
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

/** 计算一组棋子的羁绊明细：counts(加权计数)、tier(激活档位数，含档位激活条件)、waste(超出最高已激活断点的计数) */
function computeBreakdown(data, unitKeys) {
  const byKey = new Map(data.champions.map(c => [c.key, c]));
  const counts = new Map();
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
    t.breakpoints.forEach((b, i) => {
      const r = ruleFor(i);
      if (count >= b && (!r || count === r.exactCount)) { tier++; highestActive = i; }
    });
    const waste = highestActive >= 0 ? count - t.breakpoints[highestActive] : count;
    rows.push({ trait: t.key, name: t.name, count, tier, breakpoints: t.breakpoints, waste, active: tier > 0 });
  }
  rows.sort((a, b) => b.tier - a.tier || b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return rows;
}

function signature(rows) {
  return rows.filter(r => r.active).map(r => `${r.trait}:${r.tier}`).sort().join(',');
}

/**
 * 求某人口档的 Top-K 阵容（按羁绊档位总和降序；同分给不同羁绊构成的并列解）。
 * 通过"禁止重复解"约束（no-good cut）迭代枚举，去重维度是羁绊档位构成。
 */
async function solveLevel(data, level, topk = 3, maxIter = 120) {
  const glpk = await getGlpk();
  const U = data.champions;
  const x = i => `x${i}`;
  const y = (ti, bi) => `y${ti}_${bi}`;

  const binaries = U.map((_, i) => x(i));
  const objVars = [];
  const subjectTo = [];

  // 人口：栏位占用合计恰好为 N（远古巨龙等占多格的棋子按 slots 计）
  subjectTo.push({
    name: 'board',
    vars: U.map((c, i) => ({ name: x(i), coef: c.slots || 1 })),
    bnds: { type: glpk.GLP_FX, lb: level, ub: level },
  });

  // 互斥组：组内最多 1 个（如拉克丝各形态）
  (data.groups || []).forEach((g, gi) => {
    if (g.length < 2) return;
    subjectTo.push({
      name: `group${gi}`,
      vars: g.map(k => {
        const i = U.findIndex(c => c.key === k);
        if (i < 0) throw new Error(`互斥组里找不到棋子 ${k}`);
        return { name: x(i), coef: 1 };
      }),
      bnds: { type: glpk.GLP_UP, lb: 0, ub: 1 },
    });
  });

  // 档位激活：y[t,i]=1 蕴含 羁绊 t 的加权计数 >= 第 i 个断点
  data.traits.forEach((t, ti) => {
    const members = U.map((c, i) => ({ i, w: (c.weights || {})[t.key] || (c.traits.includes(t.key) ? 1 : 0) }))
      .filter(m => m.w > 0);
    if (members.length === 0) return;
    t.breakpoints.forEach((b, bi) => {
      const vars = members.map(m => ({ name: x(m.i), coef: m.w }));
      vars.push({ name: y(ti, bi), coef: -b });
      subjectTo.push({ name: `t${ti}_${bi}`, vars, bnds: { type: glpk.GLP_LO, lb: 0, ub: 0 } });
      // 档位激活条件（如宿敌第1档要求计数恰好为1）：count + M·y ≤ exactCount + M
      const rule = (t.tierRules || []).find(r => r.tier === bi + 1);
      if (rule) {
        const M = members.reduce((s, m) => s + m.w, 0); // 该羁绊计数上界
        const exVars = members.map(m => ({ name: x(m.i), coef: m.w }));
        exVars.push({ name: y(ti, bi), coef: M });
        subjectTo.push({ name: `t${ti}_${bi}_ex`, vars: exVars, bnds: { type: glpk.GLP_UP, lb: 0, ub: rule.exactCount + M } });
      }
      binaries.push(y(ti, bi));
      objVars.push({ name: y(ti, bi), coef: 1 });
    });
  });

  const base = {
    name: `set${data.set}_lv${level}`,
    objective: { direction: glpk.GLP_MAX, name: 'tiers', vars: objVars },
    subjectTo,
    binaries,
  };

  const results = [];
  const seen = new Set();
  const cuts = [];
  for (let iter = 0; iter < maxIter; iter++) {
    const lp = { ...base, subjectTo: base.subjectTo.concat(cuts) };
    const r = await glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });
    if (!r || !r.result) break; // 无可行解：枚举 exhausted
    const chosen = [];
    U.forEach((c, i) => { if (r.result.vars[x(i)] > 0.5) chosen.push(c.key); });
    const rows = computeBreakdown(data, chosen);
    const score = rows.reduce((s, r2) => s + r2.tier, 0);
    const sig = signature(rows);
    if (!seen.has(sig)) {
      seen.add(sig);
      results.push({ level, score, unitKeys: chosen, breakdown: rows });
      if (results.length >= topk) break;
    }
    cuts.push({
      name: `ng${iter}`,
      vars: chosen.map(k => ({ name: x(U.findIndex(c => c.key === k)), coef: 1 })),
      bnds: { type: glpk.GLP_UP, lb: 0, ub: level - 1 },
    });
  }
  return results;
}

module.exports = { solveLevel, computeBreakdown };
