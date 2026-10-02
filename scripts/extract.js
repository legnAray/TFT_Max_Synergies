// 从 CommunityDragon 的 tft json 提取指定赛季数据 -> data/s{N}.json
// 用法: node scripts/extract.js [赛季编号，默认18] [--patch 14.14 指定历史补丁] [--refresh 强制重新下载]
//   最新赛季用 latest；已下线的老赛季（如 S11 画之灵）用该赛季存活期内最后 一个补丁号 --patch 14.14
const fs = require('fs');
const path = require('path');

const rawArgs = process.argv.slice(2);
const patchIdx = rawArgs.indexOf('--patch');
const patch = patchIdx >= 0 ? rawArgs[patchIdx + 1] : null; // 如 '14.14'，注意不带结尾的 .1
const args = rawArgs.filter((a, i) => a !== '--refresh' && a !== '--patch' && i !== patchIdx + 1);
const setNumber = Number(args[0] || 18);
const rawName = patch ? `cd_tft_zh_cn_${patch}.json` : 'cd_tft_zh_cn.json';
const rawFile = path.join(__dirname, '..', 'raw', rawName);

async function download() {
  const url = `https://raw.communitydragon.org/${patch || 'latest'}/cdragon/tft/zh_cn.json`;
  process.stderr.write(`下载 ${url} ...\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  fs.writeFileSync(rawFile, buf);
  process.stderr.write(`已保存 ${rawFile} (${(buf.length / 1e6).toFixed(1)}MB)\n`);
}

async function main() {
  if (!fs.existsSync(rawFile) || process.argv.includes('--refresh')) await download();
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));

const entries = raw.setData.filter(s => Number(s.number) === setNumber);
if (entries.length === 0) throw new Error(`找不到 setData number=${setNumber}`);
// 同一编号可能有多条（标准 / TURBO / PAIRS / 活动改编等）：优先标准 mutator TFTSet{N}，
// 没有才退回"棋子最多"启发式（S11 的 14.14 快照里棋子最多的其实是五周年 remix 活动集）
const standard = entries.filter(s => s.mutator === `TFTSet${setNumber}`);
const pool = standard.length ? standard : entries;
pool.sort((a, b) => (b.champions?.length || 0) - (a.champions?.length || 0));
const set = pool[0];
console.log(`setData number=${setNumber}: ${entries.length} 条，取 ${standard.length ? '标准 mutator' : '棋子最多'}的一条（mutator=${set.mutator || '无'}），champions=${set.champions.length}, traits=${set.traits.length}`);

// ---- 羁绊表 ----
// 注意：断点保留重复（如 S18 宿敌真实断点是 1/1/2，第1、2档都在1个单位时激活）
const traits = {}; // apiName -> { key, name, breakpoints }
for (const t of set.traits) {
  const breakpoints = (t.effects || []).map(e => e.minUnits).filter(n => Number.isFinite(n));
  if (breakpoints.length === 0) continue;
  traits[t.apiName] = {
    key: t.apiName,
    name: t.name,
    breakpoints: breakpoints.sort((a, b) => a - b),
  };
}

// 赛季特殊规则：sets/s{N}.rules.js 存在才加载（字段含义见该文件注释），没有就按无特殊规则处理
// 常规棋子零声明走默认规则；特殊棋子在 specialUnits 里逐个声明，下面在棋子表建好后统一解释
const rulesFile = path.join(__dirname, '..', 'sets', `s${setNumber}.rules.js`);
const rules = fs.existsSync(rulesFile) ? require(rulesFile) : {};

// ---- 棋子表 ----
// setData 里棋子的 traits 为空，真正的羁绊映射在顶层 sets['<编号>'] 里（存的是中文名），两边按 apiName 对齐
const byNameTrait = {}; // 中文羁绊名 -> apiName
for (const t of Object.values(traits)) byNameTrait[t.name] = t.key;
const dupNames = Object.values(traits).map(t => t.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupNames.length) throw new Error(`羁绊中文名重复，无法按名映射: ${dupNames.join(',')}`);

const legacy = (raw.sets || {})[String(setNumber)];
if (!legacy || !legacy.champions) throw new Error(`sets['${setNumber}'] 里没有棋子数据`);
const legacyByApi = new Map(legacy.champions.map(c => [c.apiName, c]));

const champions = [];
const dropped = [];
for (const c of set.champions) {
  const lc = legacyByApi.get(c.apiName);
  const traitNames = lc?.traits || [];
  if (traitNames.length === 0) { dropped.push(`${c.name}(${c.apiName}) 无羁绊`); continue; }
  const keys = traitNames.map(n => byNameTrait[n]).filter(Boolean);
  if (keys.length !== traitNames.length) {
    dropped.push(`${c.name}(${c.apiName}) 羁绊缺失: ${traitNames.filter(n => !byNameTrait[n]).join(',')}`);
    continue;
  }
  champions.push({ key: c.apiName, name: c.name, cost: c.cost, traits: keys });
}

// ---- 解释特殊棋子规则（sets/s{N}.rules.js 的 specialUnits）----
const byName = new Map(champions.map(c => [c.name, c]));
const resolveUnits = names => {
  const us = [];
  for (const n of names || []) {
    const hit = byName.get(n);
    if (!hit) throw new Error(`sets/s${setNumber}.rules.js 声明的棋子不存在: ${n}`);
    us.push(hit);
  }
  return us;
};
const groups = []; // [{ name, units: [key] }]（同组最多上场1个；名字供前端"特殊机制"区展示）
const specialNotes = [];
for (const sp of rules.specialUnits || []) {
  const us = resolveUnits(sp.units);
  if (us.length === 0 && !sp.note) continue;
  if (sp.exclusive && us.length > 1) groups.push({ name: sp.name, units: us.map(c => c.key) });
  if (sp.slots && sp.slots !== 1) us.forEach(c => { c.slots = sp.slots; });
  if (sp.traitWeights) {
    for (const [tName, w] of Object.entries(sp.traitWeights)) {
      const tKey = byNameTrait[tName];
      if (!tKey) throw new Error(`traitWeights 里的羁绊不存在: ${tName}`);
      us.forEach(c => { if (c.traits.includes(tKey)) (c.weights ||= {})[tKey] = w; });
    }
  }
  if (sp.formTraitWeight) {
    // 组内公共羁绊（如拉克丝的"自然之力！大元素使"）不加权，其余形态羁绊加权
    const common = us[0].traits.filter(k => us.every(c => c.traits.includes(k)));
    us.forEach(c => { for (const k of c.traits) if (!common.includes(k)) (c.weights ||= {})[k] = sp.formTraitWeight; });
  }
  if (sp.trait && sp.tierExactCount) {
    const t = Object.values(traits).find(v => v.name === sp.trait);
    if (!t) throw new Error(`tierExactCount 指向的羁绊不存在: ${sp.trait}`);
    t.tierRules = Object.entries(sp.tierExactCount).map(([tier, cnt]) => ({ tier: Number(tier), exactCount: cnt }));
  }
  if (sp.removeUnits) {
    // 把棋子移出池子（如雷恩加尔：除宿敌外无羁绊、上场从不增加档位，没有建模价值）
    for (const c of resolveUnits(sp.removeUnits)) {
      const idx = champions.indexOf(c);
      if (idx >= 0) champions.splice(idx, 1);
      dropped.push(`${c.name}(${c.apiName}) 规则移除（${sp.name}）`);
    }
  }
  if (sp.removeTraits) {
    // 把羁绊整个删除（如 S11 合体假人专属的"迅捷射手/武仙子"组合羁绊，移除假人后无人持有）
    for (const tName of sp.removeTraits) {
      const t = Object.values(traits).find(v => v.name === tName);
      if (!t) throw new Error(`removeTraits 里的羁绊不存在: ${tName}`);
      const holders = champions.filter(c => c.traits.includes(t.key));
      if (holders.length) throw new Error(`removeTraits 的羁绊 ${tName} 仍被棋子引用: ${holders.map(c => c.name).join(',')}`);
      delete traits[t.key];
    }
  }
  if (sp.traitBreakpoints) {
    // 覆盖羁绊断点（如宿敌 1/1/2 → [1]）；超出新断点数的档位规则一并清除
    for (const [tName, bps] of Object.entries(sp.traitBreakpoints)) {
      const t = Object.values(traits).find(v => v.name === tName);
      if (!t) throw new Error(`traitBreakpoints 里的羁绊不存在: ${tName}`);
      t.breakpoints = bps;
      if (t.tierRules) t.tierRules = t.tierRules.filter(r => r.tier <= bps.length);
    }
  }
  if (sp.evolutions) {
    // 进化机制：为基座棋子合成"进化 k 次、各选一个候选羁绊"的全部变体棋子，
    // 与基座一起加入互斥组（同拉克丝形态的处理方式），求解器自动选最优进化路线
    const [base] = us;
    const evo = sp.evolutions;
    const choiceKeys = (evo.choices || []).map(n => {
      const k = byNameTrait[n];
      if (!k) throw new Error(`evolutions.choices 里的羁绊不存在: ${n}`);
      return k;
    });
    const maxK = Math.min(evo.maxEvolve || 1, choiceKeys.length);
    // distinct=true（默认）：不重复选 → 组合 C(n,k)；false：可重复选 → 计数可叠加
    const picks = (arr, k, prefix = []) => {
      if (k === 0) return [prefix];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = evo.distinct === false ? arr.slice(i) : arr.slice(i + 1);
        for (const p of picks(rest, k - 1, [...prefix, arr[i]])) out.push(p);
      }
      return out;
    };
    const family = [base.key];
    for (let k = 1; k <= maxK; k++) {
      for (const combo of picks(choiceKeys, k)) {
        const variant = {
          key: `${base.key}::${combo.join('+')}`,
          name: `${base.name} (进化${k}·${combo.map(k2 => traits[k2].name).join('+')})`,
          cost: base.cost,
          traits: [...base.traits, ...combo],
          evo: k,           // 进化次数（前端"特殊机制"区按此过滤）
          variantOf: base.key, // 基座棋子
        };
        if (base.slots && base.slots !== 1) variant.slots = base.slots;
        champions.push(variant);
        family.push(variant.key);
      }
    }
    if (family.length > 1) groups.push({ name: sp.name, units: family });
  }
  if (sp.note) specialNotes.push(`${sp.name}: ${sp.note}`);
}
champions.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));

// ---- 尊者机制（rules.exalted）：每局一组不同单位持有该羁绊，编译成通用机制数据 ----
// Web"特殊机制"区/CLI --exalted 选择本局持有者，求解前用 grantTrait 授予对应棋子
let exalted = null;
if (rules.exalted) {
  const tKey = byNameTrait[rules.exalted.trait];
  if (!tKey) throw new Error(`exalted.trait 指向的羁绊不存在: ${rules.exalted.trait}`);
  exalted = {
    trait: tKey, name: rules.exalted.trait,
    maxPicks: rules.exalted.maxPicks || 10,
    maxTraits: rules.exalted.maxTraits || 3, // 羁绊条数达到上限的棋子不可能成为尊者
  };
  if (rules.exalted.note) specialNotes.push(`尊者: ${rules.exalted.note}`);
}

// ---- 校验：羁绊被多少棋子引用 ----
const traitUnits = {};
for (const t of Object.keys(traits)) traitUnits[t] = [];
for (const c of champions) for (const t of c.traits) traitUnits[t].push(c.name);

// 断点为 [1] 的“独有羁绊”（单人自动激活，如特殊单位羁绊）单独标记
for (const t of Object.values(traits)) {
  t.unique = t.breakpoints.length === 1 && t.breakpoints[0] === 1;
}

const out = {
  set: setNumber,
  name: rules.setName || null, // 赛季显示名（CD 的 set.name 是内部代号如 "Set10"，故取人工维护的 rules.setName）
  source: `raw/${rawName} (CommunityDragon${patch ? ' ' + patch : ' latest'})`,
  rules: { notes: specialNotes },
  exalted, // 尊者机制声明（S11 画之灵）：{ trait, name, maxPicks }，无则 null
  groups,
  champions,
  traits: Object.values(traits),
};
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'data', `s${setNumber}.json`), JSON.stringify(out, null, 2));

// ---- 人类可读核对清单 ----
const lines = [];
lines.push(`# S${setNumber} 数据提取核对清单`);
lines.push('');
lines.push(`棋子共 ${champions.length} 个（已丢弃 ${dropped.length} 条：${dropped.join('；')}）`);
if (groups.length) lines.push(`互斥组（同组最多上场1个）：${groups.length} 组`);
for (const note of specialNotes) lines.push(`> 特殊规则 · ${note}`);
lines.push('');
const byCost = {};
for (const c of champions) (byCost[c.cost] ||= []).push(c);
for (const cost of Object.keys(byCost).sort()) {
  lines.push(`## ${cost} 费（${byCost[cost].length}个）`);
  for (const c of byCost[cost]) {
    lines.push(`- ${c.name}: ${c.traits.map(t => traits[t].name + ((c.weights || {})[t] ? '(+2)' : '')).join(' / ')}`);
  }
  lines.push('');
}
lines.push(`## 羁绊断点（共 ${Object.keys(traits).length} 个）`);
const traitList = Object.values(traits).sort((a, b) => traitUnits[b.key].length - traitUnits[a.key].length);
for (const t of traitList) {
  lines.push(`- ${t.name}: 断点 ${t.breakpoints.join('/')}，棋子 ${traitUnits[t.key].length} 个${t.unique ? '（独有羁绊，单人激活）' : ''}${traitUnits[t.key].length === 0 ? '（无棋子引用——可能只能靠纹章）' : ''}`);
}
fs.writeFileSync(path.join(__dirname, '..', 'data', `s${setNumber}_summary.md`), lines.join('\n'));
console.log(`棋子: ${champions.length}，羁绊: ${Object.keys(traits).length}`);
console.log(`费用分布: ${Object.entries(byCost).map(([k, v]) => `${k}费x${v.length}`).join(', ')}`);
console.log(`无棋子引用的羁绊: ${Object.values(traits).filter(t => traitUnits[t.key].length === 0).map(t => t.name).join(', ') || '无'}`);
console.log(`已写入 data/s${setNumber}.json 和 data/s${setNumber}_summary.md`);
}

main().catch(e => { console.error(e); process.exit(1); });
