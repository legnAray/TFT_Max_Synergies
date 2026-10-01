#!/usr/bin/env node
'use strict';
// Web UI 服务器：静态页面(web/) + JSON API，求解复用 lib/solve.js（与 CLI 同一核心，零额外依赖）
// 用法: node server.js [--port 8080]   （或环境变量 PORT）

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

// 棋子解析：先按 key、再按名字精确、最后名字包含（忽略空格），与 CLI --units 口径一致
const norm = s => String(s).replace(/\s+/g, '');
function resolveUnit(data, q) {
  return data.champions.find(c => c.key === q)
    || data.champions.find(c => c.name === q)
    || data.champions.find(c => norm(c.name).includes(norm(q)));
}

function champInfo(c, locked) {
  return { key: c.key, name: c.name, cost: c.cost, slots: c.slots || 1, locked: !!locked };
}

async function handleApi(res, url) {
  if (url.pathname === '/api/data') {
    const set = Number(url.searchParams.get('set') || 18);
    const data = loadData(set);
    if (!data) return sendJson(res, 404, { error: `找不到 S${set} 数据文件，先运行: node scripts/extract.js ${set}` });
    return sendJson(res, 200, data);
  }
  if (url.pathname === '/api/solve') {
    const set = Number(url.searchParams.get('set') || 18);
    const level = Number(url.searchParams.get('level'));
    const topk = Math.min(Math.max(Number(url.searchParams.get('topk')) || 3, 1), 10);
    const data = loadData(set);
    if (!data) return sendJson(res, 404, { error: `找不到 S${set} 数据文件` });
    if (!Number.isInteger(level) || level < 1 || level > 15) {
      return sendJson(res, 400, { error: 'level 需为 1-15 的整数' });
    }

    const lockedKeys = [];
    const unitsParam = url.searchParams.get('units');
    if (unitsParam) {
      for (const q of unitsParam.split(',').map(s => s.trim()).filter(Boolean)) {
        const hit = resolveUnit(data, q);
        if (!hit) return sendJson(res, 400, { error: `棋子不存在: ${q}` });
        if (!lockedKeys.includes(hit.key)) lockedKeys.push(hit.key);
      }
    }

    const byKey = new Map(data.champions.map(c => [c.key, c]));
    const lockedSet = new Set(lockedKeys);
    const out = await enqueue(async () => {
      const t0 = Date.now();
      const results = lockedKeys.length
        ? await solveWithLocked(data, lockedKeys, level, topk)
        : await solveLevel(data, level, topk);
      return {
        set, level, topk,
        locked: lockedKeys.map(k => champInfo(byKey.get(k), true)),
        results: results.map(r => ({
          level: r.level,
          score: r.score,
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
    handleApi(res, url).catch(e => sendJson(res, 500, { error: e.message }));
  } else {
    serveStatic(res, url);
  }
});

server.listen(port, () => {
  console.log(`TFT 最大羁绊计算器 Web UI: http://localhost:${port}/`);
});
