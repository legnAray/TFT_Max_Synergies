'use strict';
// Web UI 前端：纯原生 JS，无构建步骤。数据来自 /api/data，求解来自 /api/solve（server.js）。

const LEVELS = [6, 7, 8, 9, 10];
const TOPKS = [5, 10];
const EMBLEM_MAX = 10;
const state = {
  set: 18,
  levels: new Set([8]),
  topk: 5,
  mode: 'tiers',          // tiers 羁绊质量 | count 羁绊数量
  locked: [],             // 必带棋子 key
  emblems: {},            // 羁绊 key -> 纹章数
  pins: {},               // 羁绊 key -> 至少档位
  banUnits: [],           // 屏蔽棋子 key
  banTraits: [],          // 屏蔽羁绊 key
  ban5cost: false,
  data: null,
};
const $ = id => document.getElementById(id);
const $picker = name => document.querySelector(`.picker[data-picker="${name}"]`);
const $list = name => document.querySelector(`.chips[data-list="${name}"]`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

init();

async function init() {
  renderLevelChips();
  renderTopkChips();
  renderModeChips();
  $('ban5costChip').onclick = () => {
    state.ban5cost = !state.ban5cost;
    $('ban5costChip').classList.toggle('on', state.ban5cost);
  };
  $('solveBtn').addEventListener('click', solve);
  document.addEventListener('click', e => {
    // 点击其他选择器时收起已展开的下拉（避免遮挡），点击选择器外部则全部收起
    const picker = e.target.closest('.picker');
    document.querySelectorAll('.suggest').forEach(s => {
      if (!picker || !picker.contains(s)) s.classList.add('hidden');
    });
  });

  // 赛季下拉：/api/sets 动态发现 data/ 里的赛季，默认取最新
  try {
    const res = await fetch('/api/sets');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { sets } = await res.json();
    const sel = $('setSelect');
    sel.innerHTML = sets.map(s =>
      `<option value="${s.set}">S${s.set}${s.name ? ' · ' + esc(s.name) : ''}（${s.champions}棋子）</option>`).join('');
    sel.onchange = () => switchSet(Number(sel.value));
    if (sets.length) await switchSet(sets[0].set);
  } catch (e) {
    setStatus(`赛季列表加载失败: ${e.message}`, true);
  }
  setupPickers();
  renderAll();
}

/** 切换赛季：重置与赛季数据绑定的选择状态，重新加载棋子/羁绊 */
async function switchSet(n) {
  state.set = n;
  state.locked = [];
  state.emblems = {};
  state.pins = {};
  state.banUnits = [];
  state.banTraits = [];
  state.ban5cost = false;
  $('ban5costChip').classList.remove('on');
  $('results').innerHTML = '';
  try {
    const res = await fetch('/api/data?set=' + n);
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    state.data = await res.json();
    const label = `S${state.data.set}${state.data.name ? ' ' + state.data.name : ''}`;
    $('subtitle').textContent =
      `${label} · ${state.data.champions.length} 棋子 / ${state.data.traits.length} 羁绊 · ` +
      '整数规划精确最优（羁绊质量=档位总和 / 羁绊数量=不同名计数）';
    setStatus('');
  } catch (e) {
    setStatus(`数据加载失败: ${e.message}`, true);
  }
  renderAll();
}

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isErr ? ' err' : '');
}

/* ---- 基础 chips ---- */

function renderLevelChips() {
  const box = $('levelChips');
  box.innerHTML = '';
  for (const lv of LEVELS) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.levels.has(lv) ? ' on' : '');
    b.textContent = `${lv} 人口`;
    b.onclick = () => { state.levels.has(lv) ? state.levels.delete(lv) : state.levels.add(lv); renderLevelChips(); };
    box.appendChild(b);
  }
}

function renderTopkChips() {
  const box = $('topkChips');
  box.innerHTML = '';
  for (const k of TOPKS) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.topk === k ? ' on' : '');
    b.textContent = `${k} 套`;
    b.onclick = () => { state.topk = k; renderTopkChips(); };
    box.appendChild(b);
  }
}

function renderModeChips() {
  const box = $('modeChips');
  box.innerHTML = '';
  for (const [mode, label] of [['tiers', '羁绊质量'], ['count', '羁绊数量']]) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.mode === mode ? ' on' : '');
    b.textContent = label;
    b.title = mode === 'tiers' ? '每踩一个断点记 1 档，档位总和最大' : '不同名激活羁绊计数最多';
    b.onclick = () => { state.mode = mode; renderModeChips(); };
    box.appendChild(b);
  }
}

/* ---- 数据查询辅助 ---- */

const traitByKey = key => (state.data?.traits || []).find(t => t.key === key);
const traitName = key => traitByKey(key)?.name || key;
const champByKey = key => (state.data?.champions || []).find(c => c.key === key);
const emblemTotal = () => Object.values(state.emblems).reduce((s, n) => s + n, 0);

/* ---- 通用选择器（必带/纹章/固定/屏蔽棋子/屏蔽羁绊 共用） ---- */

function pickerItems(name) {
  if (!state.data) return [];
  const traitNameOf = key => (state.data.traits.find(t => t.key === key) || {}).name || key;
  if (name === 'locked' || name === 'banUnit') {
    return state.data.champions.map(c => ({
      key: c.key, name: c.name, cls: `c${c.cost}`, cost: c.cost,
      sub: `${c.cost}费 · ${c.traits.map(traitNameOf).join(' / ')}`,
    }));
  }
  return state.data.traits.map(t => ({
    key: t.key, name: t.name, cls: '', cost: 0,
    sub: `断点 ${t.breakpoints.join('/')}${t.unique ? ' · 独有' : ''}`,
    trait: t,
  }));
}

// 各选择器的"选中/排除"规则：已选的不出现在候选里；冲突项自动解除
function pickerFilter(name, item) {
  if (name === 'locked') return !state.locked.includes(item.key) && !state.banUnits.includes(item.key);
  if (name === 'banUnit') return !state.banUnits.includes(item.key) && !state.locked.includes(item.key);
  if (name === 'emblem') {
    return !state.emblems[item.key] && !item.trait.unique && !state.banTraits.includes(item.key);
  }
  if (name === 'pin') return state.pins[item.key] == null && !state.banTraits.includes(item.key);
  if (name === 'banTrait') return !state.banTraits.includes(item.key) && state.pins[item.key] == null && !state.emblems[item.key];
  return true;
}

function pickerPick(name, key) {
  if (name === 'locked') {
    state.locked.push(key);
  } else if (name === 'banUnit') {
    state.banUnits.push(key);
  } else if (name === 'emblem') {
    if (emblemTotal() >= EMBLEM_MAX) return setStatus(`纹章最多 ${EMBLEM_MAX} 个`, true);
    state.emblems[key] = (state.emblems[key] || 0) + 1;
  } else if (name === 'pin') {
    state.pins[key] = 1;
  } else if (name === 'banTrait') {
    state.banTraits.push(key);
  }
  setStatus('');
  renderAll(); // 选完收起下拉（展开的下拉会遮挡下方选择器），点击输入框可再次展开
}

function setupPickers() {
  for (const name of ['locked', 'emblem', 'pin', 'banUnit', 'banTrait']) {
    const box = $picker(name);
    const input = box.querySelector('input');
    const suggest = box.querySelector('.suggest');
    const open = () => renderSuggest(name, input.value.trim(), suggest);
    input.addEventListener('input', open);
    // 聚焦/点击即展开完整列表：不打字也能直接选（聚焦后再次点击不会重发 focus，故挂两个事件）
    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    // 失焦收起（mousedown 选项先于 blur 触发，不影响点选）；点击下拉空白区也收起
    input.addEventListener('blur', () => setTimeout(() => suggest.classList.add('hidden'), 0));
    suggest.addEventListener('mousedown', e => { if (e.target === suggest) suggest.classList.add('hidden'); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const first = suggest.querySelector('.opt');
        if (first) pickerPick(name, first.dataset.key);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        suggest.classList.add('hidden');
      }
    });
  }
}

function renderSuggest(name, q, suggest) {
  if (!state.data) return suggest.classList.add('hidden');
  const isUnit = name === 'locked' || name === 'banUnit';
  let items = pickerItems(name).filter(it => pickerFilter(name, it));
  if (q) items = items.filter(it => it.name.includes(q));
  items.sort((a, b) => {
    if (q && (a.name === q) !== (b.name === q)) return a.name === q ? -1 : 1; // 精确命中优先
    if (isUnit) return b.cost - a.cost || a.name.localeCompare(b.name, 'zh'); // 棋子按费用降序
    return a.name.localeCompare(b.name, 'zh');
  });
  const hits = q ? items.slice(0, 12) : items; // 输入时取前12；空输入展示全部（可滚动）
  if (!hits.length) return suggest.classList.add('hidden');
  suggest.innerHTML = hits.map(it =>
    `<div class="opt" data-key="${esc(it.key)}">` +
    `<span class="pick-name ${it.cls}">${esc(it.name)}</span><span class="t">${esc(it.sub)}</span></div>`
  ).join('');
  suggest.classList.remove('hidden');
  suggest.querySelectorAll('.opt').forEach(o =>
    o.addEventListener('mousedown', () => pickerPick(name, o.dataset.key)));
}

/* ---- 已选项 chips 渲染 ---- */

function chipX(onclick) {
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  x.onclick = onclick;
  return x;
}

function renderAll() {
  renderListLocked();
  renderListEmblem();
  renderListPin();
  renderListBanUnit();
  renderListBanTrait();
  $('emblemCount').textContent = `${emblemTotal()}/${EMBLEM_MAX}`;
  document.querySelectorAll('.suggest').forEach(s => s.classList.add('hidden'));
  for (const name of ['locked', 'emblem', 'pin', 'banUnit', 'banTrait']) {
    $picker(name).querySelector('input').value = '';
  }
}

function baseChip(cls, text) {
  const chip = document.createElement('span');
  chip.className = 'chip on' + (cls ? ' ' + cls : '');
  chip.appendChild(document.createTextNode(text));
  return chip;
}

function renderListLocked() {
  const box = $list('locked');
  box.innerHTML = '';
  for (const key of state.locked) {
    const c = champByKey(key);
    const chip = baseChip(c ? `c${c.cost}` : '', c ? c.name : key);
    chip.appendChild(chipX(() => { state.locked = state.locked.filter(k => k !== key); renderAll(); }));
    box.appendChild(chip);
  }
}

function renderListEmblem() {
  const box = $list('emblem');
  box.innerHTML = '';
  for (const [key, n] of Object.entries(state.emblems)) {
    if (n <= 0) continue;
    const chip = baseChip('emblem', `${traitName(key)} ×${n}`);
    const minus = document.createElement('span');
    minus.className = 'x';
    minus.textContent = '−';
    minus.onclick = () => { state.emblems[key] = Math.max(0, n - 1); renderAll(); };
    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '+';
    plus.onclick = () => {
      if (emblemTotal() >= EMBLEM_MAX) return setStatus(`纹章最多 ${EMBLEM_MAX} 个`, true);
      state.emblems[key] = n + 1; renderAll();
    };
    chip.appendChild(minus);
    chip.appendChild(plus);
    chip.appendChild(chipX(() => { delete state.emblems[key]; renderAll(); }));
    box.appendChild(chip);
  }
}

function renderListPin() {
  const box = $list('pin');
  box.innerHTML = '';
  for (const [key, tier] of Object.entries(state.pins)) {
    const t = traitByKey(key);
    const chip = baseChip('pin', `${traitName(key)} ≥`);
    const sel = document.createElement('select');
    sel.className = 'tier-select';
    for (let i = 1; i <= (t ? t.breakpoints.length : 1); i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = `${i}档`;
      if (i === tier) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { state.pins[key] = Number(sel.value); };
    chip.appendChild(sel);
    chip.appendChild(chipX(() => { delete state.pins[key]; renderAll(); }));
    box.appendChild(chip);
  }
}

function renderListBanUnit() {
  const box = $list('banUnit');
  box.innerHTML = '';
  for (const key of state.banUnits) {
    const c = champByKey(key);
    const chip = baseChip(c ? `c${c.cost}` : '', `禁 ${c ? c.name : key}`);
    chip.appendChild(chipX(() => { state.banUnits = state.banUnits.filter(k => k !== key); renderAll(); }));
    box.appendChild(chip);
  }
}

function renderListBanTrait() {
  const box = $list('banTrait');
  box.innerHTML = '';
  for (const key of state.banTraits) {
    const chip = baseChip('ban', '禁 ' + traitName(key));
    chip.appendChild(chipX(() => { state.banTraits = state.banTraits.filter(k => k !== key); renderAll(); }));
    box.appendChild(chip);
  }
}

/* ---- 求解与结果渲染 ---- */

async function solve() {
  const levels = [...state.levels].sort((a, b) => a - b);
  if (!levels.length) return setStatus('请至少选择一个人口档位', true);
  const btn = $('solveBtn');
  btn.disabled = true;
  const box = $('results');
  box.innerHTML = '';
  const sections = new Map();
  for (const lv of levels) {
    const sec = document.createElement('section');
    sec.className = 'panel result';
    sec.innerHTML = `<div class="lv-head"><h2>${lv} 人口</h2></div><p class="wait">计算中…</p>`;
    box.appendChild(sec);
    sections.set(lv, sec);
  }
  let done = 0;
  await Promise.all(levels.map(async lv => {
    const params = new URLSearchParams({ set: state.set, level: lv, topk: state.topk, mode: state.mode });
    if (state.locked.length) params.set('units', state.locked.join(','));
    const em = Object.entries(state.emblems).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',');
    if (em) params.set('emblems', em);
    if (state.banUnits.length) params.set('banUnits', state.banUnits.join(','));
    if (state.ban5cost) params.set('ban5cost', '1');
    if (state.banTraits.length) params.set('banTraits', state.banTraits.join(','));
    const pins = Object.entries(state.pins).map(([k, n]) => `${k}=${n}`).join(',');
    if (pins) params.set('pins', pins);
    const sec = sections.get(lv);
    try {
      const res = await fetch('/api/solve?' + params);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      renderLevel(sec, json);
    } catch (e) {
      sec.innerHTML = `<div class="lv-head"><h2>${lv} 人口</h2></div><p class="err">出错了：${esc(e.message)}</p>`;
    }
    done += 1;
    setStatus(done < levels.length ? `计算中… ${done}/${levels.length}` : '计算完成');
  }));
  btn.disabled = false;
}

function renderLevel(sec, json) {
  sec.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'lv-head';
  const best = json.results[0];
  if (!best) {
    head.innerHTML = `<h2>${json.level} 人口</h2><span class="err">无可行解（约束过强，试试放宽屏蔽/固定）</span>`;
    sec.appendChild(head);
    return;
  }
  const isCount = json.constraints.mode === 'count';
  head.innerHTML = `<h2>${json.level} 人口</h2>` +
    `<span class="best">${isCount ? '最多羁绊' : '最大羁绊'} <b>${best.score}</b> ${isCount ? '种' : '档'}</span>` +
    `<span class="ms">${best.ms}ms</span>`;
  const c = json.constraints;
  const notes = [];
  if (c.emblems.length) notes.push(`纹章: ${c.emblems.map(e => `${e.name}×${e.count}`).join('、')}`);
  if (json.locked.length) notes.push(`必带: ${json.locked.map(u => u.name).join('、')}`);
  if (c.pins.length) notes.push(`固定: ${c.pins.map(p => `${p.name}≥${p.tier}档`).join('、')}`);
  if (c.banTraits.length) notes.push(`屏蔽羁绊: ${c.banTraits.map(t => t.name).join('、')}`);
  if (c.ban5cost) notes.push('已屏蔽5费');
  if (notes.length) {
    const p = document.createElement('p');
    p.className = 'constraint-note';
    p.textContent = notes.join(' · ');
    head.appendChild(p);
  }
  sec.appendChild(head);
  const bestScore = best.score;
  json.results.forEach((r, i) => sec.appendChild(renderComp(r, i, bestScore, isCount)));
}

function renderComp(r, i, bestScore, isCount) {
  const art = document.createElement('article');
  art.className = 'comp';
  const scoreTxt = isCount ? `${r.score}种` : `${r.score}档`;
  const tag = i === 0 ? `<b>最优方案</b>` : (r.score === bestScore ? `<b>并列最优</b>（${scoreTxt}）` : `<b>次优</b>（${scoreTxt}）`);
  const units = [...r.units].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'zh'));
  const totalSlots = units.reduce((s, u) => s + (u.slots || 1), 0);
  const unitsHtml = units.map(u =>
    `<span class="unit c${u.cost}">${esc(u.name)}` +
    (u.locked ? '<span class="lock">必带</span>' : '') +
    ((u.slots || 1) > 1 ? `<span class="slots">占${u.slots}格</span>` : '') +
    `<span class="cost">${u.cost}费</span></span>`
  ).join('');
  const active = r.breakdown.filter(t => t.active);
  const inactive = r.breakdown.filter(t => !t.active);
  const traitByKey = new Map((state.data ? state.data.traits : []).map(t => [t.key, t]));
  const traitsHtml = active.map(t => {
    const rules = (traitByKey.get(t.trait).tierRules || [])
      .map(rr => `第${rr.tier}档需计数=${rr.exactCount}`).join('，');
    const pips = t.breakpoints.map((b, idx) =>
      `<span class="pip${t.reached[idx] ? ' hit' : ''}">${b}</span>`).join('');
    const note = [rules, t.waste > 0 ? `浪费 +${t.waste}` : ''].filter(Boolean).join(' · ');
    return `<div class="trait"><span class="name">${esc(t.name)}</span>` +
      `<span class="cnt">×${t.count}${t.emblem > 0 ? `<i class="emb">纹章+${t.emblem}</i>` : ''}</span>` +
      `<span class="pips">${pips}</span><span class="tier-badge">${t.tier}档</span>` +
      (note ? `<span class="note">${esc(note)}</span>` : '') + `</div>`;
  }).join('');
  const inactiveHtml = inactive.length
    ? `<div class="inactive">（未激活: ${inactive.map(t => `${esc(t.name)}×${t.count}`).join('、')}）</div>` : '';
  art.innerHTML =
    `<div class="tag">${tag} · ${units.length} 个棋子${totalSlots !== units.length ? `（占${totalSlots}格）` : ''} · <b class="cost-tag">${r.cost}费</b></div>` +
    `<div class="units">${unitsHtml}</div>` +
    `<div class="traits">${traitsHtml}</div>` + inactiveHtml;
  return art;
}
