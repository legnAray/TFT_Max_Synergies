'use strict';
// Web UI 前端：纯原生 JS，无构建步骤。数据来自 /api/data，求解来自 /api/solve（server.js）。

const LEVELS = [6, 7, 8, 9, 10];
const TOPKS = [1, 3, 5];
const state = { levels: new Set([8]), topk: 3, locked: [], data: null };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

init();

async function init() {
  renderLevelChips();
  renderTopkChips();
  renderLocked();
  $('solveBtn').addEventListener('click', solve);
  const input = $('unitInput');
  input.addEventListener('input', () => renderSuggest(input.value.trim()));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = $('unitSuggest').querySelector('.opt');
      if (first) addLocked(first.dataset.key);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.picker')) hideSuggest(); });

  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    state.data = await res.json();
    $('subtitle').textContent =
      `S${state.data.set} · ${state.data.champions.length} 棋子 / ${state.data.traits.length} 羁绊 · ` +
      '整数规划精确最优（每踩一个断点记 1 档，档位总和最大）';
  } catch (e) {
    setStatus(`数据加载失败: ${e.message}`, true);
  }
}

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isErr ? ' err' : '');
}

/* ---- 选项 chips ---- */

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

/* ---- 必带棋子选择器 ---- */

function renderSuggest(q) {
  const box = $('unitSuggest');
  if (!q || !state.data) return hideSuggest();
  const lockedSet = new Set(state.locked);
  const hits = state.data.champions
    .filter(c => !lockedSet.has(c.key) && c.name.includes(q))
    .sort((a, b) => (a.name === q ? -1 : 0) - (b.name === q ? -1 : 0) || b.cost - a.cost)
    .slice(0, 12);
  if (!hits.length) return hideSuggest();
  const traitName = key => (state.data.traits.find(t => t.key === key) || {}).name || key;
  box.innerHTML = hits.map(c =>
    `<div class="opt" data-key="${esc(c.key)}"><span class="unit c${c.cost}">${esc(c.name)}</span>` +
    `<span class="t">${c.cost}费 · ${c.traits.map(t => esc(traitName(t))).join(' / ')}</span></div>`
  ).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.opt').forEach(o => o.addEventListener('mousedown', () => addLocked(o.dataset.key)));
}

function hideSuggest() { $('unitSuggest').classList.add('hidden'); }

function addLocked(key) {
  if (!state.locked.includes(key)) state.locked.push(key);
  $('unitInput').value = '';
  hideSuggest();
  renderLocked();
  $('unitInput').focus();
}

function renderLocked() {
  const box = $('lockedList');
  box.innerHTML = '';
  const byKey = new Map((state.data ? state.data.champions : []).map(c => [c.key, c]));
  for (const key of state.locked) {
    const c = byKey.get(key);
    const chip = document.createElement('span');
    chip.className = `chip on unit-lock c${c ? c.cost : 1}`;
    chip.textContent = c ? c.name : key;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.onclick = () => { state.locked = state.locked.filter(k => k !== key); renderLocked(); };
    chip.appendChild(x);
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
    const params = new URLSearchParams({ level: lv, topk: state.topk });
    if (state.locked.length) params.set('units', state.locked.join(','));
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
    head.innerHTML = `<h2>${json.level} 人口</h2><span class="err">无可行解</span>`;
    sec.appendChild(head);
    return;
  }
  head.innerHTML = `<h2>${json.level} 人口</h2>` +
    `<span class="best">最大羁绊 <b>${best.score}</b> 档</span>` +
    `<span class="ms">${best.ms}ms</span>`;
  if (json.locked.length) {
    head.innerHTML += `<span class="ms">必带: ${json.locked.map(u => esc(u.name)).join('、')}</span>`;
  }
  sec.appendChild(head);
  const bestScore = best.score;
  json.results.forEach((r, i) => sec.appendChild(renderComp(r, i, bestScore)));
}

function renderComp(r, i, bestScore) {
  const art = document.createElement('article');
  art.className = 'comp';
  const tag = i === 0 ? '<b>最优方案</b>' : (r.score === bestScore ? `<b>并列最优</b>（${r.score}档）` : `<b>次优</b>（${r.score}档）`);
  const units = [...r.units].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name, 'zh'));
  const totalCost = units.reduce((s, u) => s + u.cost, 0);
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
    return `<div class="trait"><span class="name">${esc(t.name)}</span><span class="cnt">×${t.count}</span>` +
      `<span class="pips">${pips}</span><span class="tier-badge">${t.tier}档</span>` +
      (note ? `<span class="note">${esc(note)}</span>` : '') + `</div>`;
  }).join('');
  const inactiveHtml = inactive.length
    ? `<div class="inactive">（未激活: ${inactive.map(t => `${esc(t.name)}×${t.count}`).join('、')}）</div>` : '';
  art.innerHTML =
    `<div class="tag">${tag} · ${units.length} 个棋子${totalSlots !== units.length ? `（占${totalSlots}格）` : ''} · ${totalCost} 费</div>` +
    `<div class="units">${unitsHtml}</div>` +
    `<div class="traits">${traitsHtml}</div>` + inactiveHtml;
  return art;
}
