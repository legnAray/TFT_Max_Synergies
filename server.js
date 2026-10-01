#!/usr/bin/env node
'use strict';
// Web UI 服务器：静态页面(web/) + JSON API，求解复用 lib/solve.js（与 CLI 同一核心，零额外依赖）
// 用法: node server.js [--port 8080]   （或环境变量 PORT）
//
// /api/solve 参数（棋子/羁绊均支持 key 或名字，名字匹配忽略空格，与 CLI 同口径）：
//   set, level, topk(默认5), mode(tiers|count)
//   units      必带棋子: 名1,名2
//   emblems    纹章(总数≤10): 地狱火,地狱火,法师 或 key:2 形式
//   banUnits   屏蔽棋子: 名1,名2
//   ban5cost   屏蔽全部5费: 1
//   banTraits  硬屏蔽羁绊(不许激活): 法师,护卫
//   pins       固定羁绊至少N档: 月蚀骑士=3,宿敌（省略=1档）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { solveLevel, solveWithLocked } = require('./lib/solve');

const portArgIdx = process.argv.indexOf('--port');
const port = portArgIdx > 0 ? Number(process.argv[portArgIdx + 1]) : Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('无效端口'); process.exit(1);
}

const webDir = path.join(__dirname, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const dataCache = new Map();
function loadData(set) {
  if (!dataCache.has(set)) {
    const file = path.join(__dirname, 'data', `s${set}.json`);
    if (!fs.existsSync(file)) return null;
    dataCache.set(set, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return dataCache.get(set);
}

// glpk 是单实例 WASM：请求串行排队求解，避免交叉
let queue = Promise.resolve();
function enqueue(job) {
  const p = queue.then(job);
  queue = p.catch(() => {});
  return p;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const norm = s => String(s).replace(/\s+/g, '');
const resolveUnit = (data, q) =>
  data.champions.find(c => c.key === q) || data.champions.find(c => c.name === q)
  || data.champions.find(c => norm(c.name).includes(norm(q)));
const resolveTrait = (data, q) =>
  data.traits.find(t => t.key === q) || data.traits.find(t => t.name === q)
  || data.traits.find(t => norm(t.name).includes(norm(q)));

class BadRequest extends Error {}
const bad = msg => { throw new BadRequest(msg); };

/** 解析 /api/solve 查询参数为求解器 opts（含全部前置校验），出错抛 BadRequest */
function buildSolveOpts(data, sp) {
  const opts = {
    topk: Math.min(Math.max(Number(sp.get('topk')) || 5, 1), 10),
    mode: sp.get('mode') === 'count' ? 'count' : 'tiers',
    emblems: {}, banUnits: [], banTraits: [], pins: {},
  };
  const traitByKey = new Map(data.traits.map(t => [t.key, t]));

  if (sp.get('ban5cost') === '1' || sp.get('ban5cost') === 'true') {
    opts.banUnits.push(...data.champions.filter(c => c.cost === 5).map(c => c.key));
  }
  for (const q of (sp.get('banUnits') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const hit = resolveUnit(data, q);
    if (!hit) bad(`棋子不存在: ${q}`);
    opts.banUnits.push(hit.key);
  }

  const emblemEntries = (sp.get('emblems') || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of emblemEntries) {
    const m = entry.match(/^(.+):(\d+)$/); // 支持 "key:2" 形式
    const q = m ? m[1] : entry;
    const n = m ? Number(m[2]) : 1;
    if (!Number.isInteger(n) || n < 1) bad(`纹章数量无效: ${entry}`);
    const hit = resolveTrait(data, q);
    if (!hit) bad(`羁绊不存在: ${q}`);
    if (hit.unique) bad(`独有羁绊没有纹章: ${hit.name}`);
    opts.emblems[hit.key] = (opts.emblems[hit.key] || 0) + n;
  }
  const emblemTotal = Object.values(opts.emblems).reduce((s, n) => s + n, 0);
  if (emblemTotal > 10) bad(`纹章最多 10 个，给了 ${emblemTotal} 个`);

  for (const q of (sp.get('banTraits') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const hit = resolveTrait(data, q);
    if (!hit) bad(`羁绊不存在: ${q}`);
    if (opts.pins[hit.key] != null) bad(`羁绊不能既屏蔽又固定: ${hit.name}`);
    if ((opts.emblems[hit.key] || 0) > 0) bad(`被屏蔽的羁绊不能上纹章: ${hit.name}`);
    opts.banTraits.push(hit.key);
  }

  for (const item of (sp.get('pins') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = item.indexOf('=');
    const q = (eq < 0 ? item : item.slice(0, eq)).trim();
    const tier = eq < 0 ? 1 : Number(item.slice(eq + 1));
    const hit = resolveTrait(data, q);
    if (!hit) bad(`羁绊不存在: ${q}`);
    if (opts.banTraits.includes(hit.key)) bad(`羁绊不能既屏蔽又固定: ${hit.name}`);
    if (!Number.isInteger(tier) || tier < 1 || tier > hit.breakpoints.length) {
      bad(`固定档位无效: ${hit.name}=${eq < 0 ? '' : item.slice(eq + 1)}（该羁绊共 ${hit.breakpoints.length} 档）`);
    }
    opts.pins[hit.key] = tier;
  }
  return opts;
}

function champInfo(c, locked) {
  return { key: c.key, name: c.name, cost: c.cost, slots: c.slots || 1, locked: !!locked };
}

async function handleApi(res, url) {
  if (url.pathname === '/api/sets') {
    // 扫描 data/s{N}.json 动态发现赛季：跑过 extract.js 的新赛季自动出现在下拉里
    const dir = path.join(__dirname, 'data');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return sendJson(res, 200, { sets: [] }); }
    const sets = [];
    for (const f of files) {
      const m = /^s(\d+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        sets.push({
          set: Number(m[1]),
          name: d.name || null,
          champions: (d.champions || []).length,
          traits: (d.traits || []).length,
        });
      } catch { /* 跳过坏文件 */ }
    }
    sets.sort((a, b) => b.set - a.set); // 最新赛季在前
    return sendJson(res, 200, { sets });
  }
  if (url.pathname === '/api/data') {
    const set = Number(url.searchParams.get('set') || 18);
    const data = loadData(set);
    if (!data) return sendJson(res, 404, { error: `找不到 S${set} 数据文件，先运行: node scripts/extract.js ${set}` });
    return sendJson(res, 200, data);
  }
  if (url.pathname === '/api/solve') {
    const set = Number(url.searchParams.get('set') || 18);
    const level = Number(url.searchParams.get('level'));
    const data = loadData(set);
    if (!data) return sendJson(res, 404, { error: `找不到 S${set} 数据文件` });
    if (!Number.isInteger(level) || level < 1 || level > 15) {
      return sendJson(res, 400, { error: 'level 需为 1-15 的整数' });
    }

    let opts;
    try { opts = buildSolveOpts(data, url.searchParams); }
    catch (e) {
      if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
      throw e;
    }

    const lockedKeys = [];
    const unitsParam = url.searchParams.get('units');
    if (unitsParam) {
      for (const q of unitsParam.split(',').map(s => s.trim()).filter(Boolean)) {
        const hit = resolveUnit(data, q);
        if (!hit) return sendJson(res, 400, { error: `棋子不存在: ${q}` });
        if (opts.banUnits.includes(hit.key)) return sendJson(res, 400, { error: `棋子不能既必带又屏蔽: ${hit.name}` });
        if (!lockedKeys.includes(hit.key)) lockedKeys.push(hit.key);
      }
    }

    const byKey = new Map(data.champions.map(c => [c.key, c]));
    const traitByKey = new Map(data.traits.map(t => [t.key, t]));
    const lockedSet = new Set(lockedKeys);
    const out = await enqueue(async () => {
      const t0 = Date.now();
      const results = lockedKeys.length
        ? await solveWithLocked(data, lockedKeys, level, opts)
        : await solveLevel(data, level, opts);
      return {
        set, level,
        constraints: {
          mode: opts.mode,
          emblems: Object.entries(opts.emblems)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => ({ key: k, name: traitByKey.get(k)?.name || k, count: n })),
          pins: Object.entries(opts.pins)
            .map(([k, n]) => ({ key: k, name: traitByKey.get(k)?.name || k, tier: n })),
          banTraits: opts.banTraits.map(k => ({ key: k, name: traitByKey.get(k)?.name || k })),
          ban5cost: opts.banUnits.filter(k => byKey.get(k)?.cost === 5).length > 0,
        },
        locked: lockedKeys.map(k => champInfo(byKey.get(k), true)),
        results: results.map(r => ({
          level: r.level,
          score: r.score,
          cost: r.unitKeys.reduce((s, k) => s + (byKey.get(k)?.cost || 0), 0),
          ms: Date.now() - t0,
          unitKeys: r.unitKeys,
          units: r.unitKeys.map(k => champInfo(byKey.get(k), lockedSet.has(k))),
          breakdown: r.breakdown,
        })),
      };
    });
    return sendJson(res, 200, out);
  }
  return sendJson(res, 404, { error: '未知接口' });
}

function serveStatic(res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(webDir, rel));
  if (!file.startsWith(webDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: '只支持 GET' });
  }
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(res, url).catch(e => sendJson(res, e instanceof BadRequest ? 400 : 500, { error: e.message }));
  } else {
    serveStatic(res, url);
  }
});

server.listen(port, () => {
  console.log(`TFT 最大羁绊计算器 Web UI: http://localhost:${port}/`);
});
