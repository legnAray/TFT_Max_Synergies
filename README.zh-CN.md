# 云顶之弈 / 金铲铲之战 · 最大羁绊计算器

[English](README.md) | [简体中文](README.zh-CN.md)

给定人口（6~10），从当前赛季棋子池中找出**羁绊档位总和最大**的阵容。不要求"零浪费"，
允许羁绊计数溢出断点；每有一个羁绊的第 N 档就计 N 分（如一个羁绊踩到第 2 档算 2），
求所有羁绊的档位之和最大。思路同 [tactics.tools 的 perfect-synergies](https://tactics.tools/zh/perfect-synergies)，
但评分口径为上述档位总和，且不追求完美无缺。

当前数据：**S18「Enchanted Wilds / 魔法荒野」**（来源 [CommunityDragon](https://raw.communitydragon.org/latest/cdragon/tft/zh_cn.json)，
中文国服命名）。求解采用整数规划（glpk.js / GLPK WASM），结果为**精确最优**，非启发式。

## 用法

```bash
npm install

node cli.js                       # S18，6-10人口，每档输出 3 套最优/并列阵容
node cli.js --levels 8-10         # 只算 8、9、10 人口
node cli.js --levels 7,9 --topk 5 # 指定人口档、多要几套并列解
node cli.js --units 卡兹克 --level 7   # 必带某些棋子，剩余位置求最优
node cli.js --json                # 输出 JSON（机器可读）
```

S18 结果参考（18.3 版本数据）：6人口 11 档 · 7人口 12 档 · 8人口 14 档 · 9人口 16 档 · 10人口 17 档。

## Web 版

```bash
npm run serve            # 或 node server.js [--port 8080]（也支持 PORT 环境变量）
```

打开 http://localhost:8080 —— 选择人口档（可多选）、每档并列解数、可选必带棋子；结果渲染为
按费用配色的棋子标签 + 逐羁绊档位明细（断点命中高亮）。`server.js` 是零依赖的 Node HTTP
服务，`/api/solve` 直接复用 `lib/solve.js`，结果与 CLI 完全一致。注意：人口越高求解越慢
（S18 数据下 10 人口约 30 秒），页面按所选人口并行请求、逐档渲染。

## 数据更新（每个新赛季一次）

```bash
node scripts/extract.js 19        # 自动下载 CommunityDragon 最新数据并生成 data/s19.json
node scripts/extract.js 19 --refresh  # 强制重新下载原始文件
node cli.js --set 19
```

**赛季数据按"常规棋子 + 特殊棋子"组织**。常规棋子零声明、走默认规则（占 1 格、对自身每个
羁绊 +1 计数，断点由羁绊数据决定）；特殊棋子在 `sets/s{N}.rules.js` 的 `specialUnits` 里逐个
声明（互斥组、计数权重、占用格数、档位激活条件），由提取脚本解释后编译成数据 JSON 里的通用
字段，求解器与赛季无关。提取脚本会同时生成 `data/s{N}_summary.md`（人肉核对清单），换赛季后
建议过一遍，并做一次"有规则 vs 无规则"的对比确认规则只影响预期的棋子。

## S18 特殊棋子（均在 `sets/s18.rules.js` 声明）

- **拉克丝（大元素使）**：10 个形态（含无形态羁绊的 Base）互为互斥组，最多上场 1 个——
  游戏内描述：拥有 1 个后商店中其余形态都转为同羁绊；形态羁绊 **+2 计数**。
- **宿敌（卡兹克 / 雷恩加尔）**：断点 1/1/2，且**第 1 档仅在恰好登场 1 个宿敌时激活**：
  单人 = 第 1+2 档，双人 = 第 2+3 档，两种情况都是 2 档。
- **远古巨龙**：**占用 2 个弈子栏位**，且提供 **+2 峡谷野怪** 计数（顶级掠食者羁绊描述原文）。
  5 费。实测结论：尽管有双计数，6-10 任何人口的最优解都不含远古巨龙（2 格换 1 个保底档位
  + 峡谷野怪进度，不如两个常规棋子各踩一个 2 断点羁绊）。
- 独有羁绊（宝石骑士、翠神、赏金猎人等 9 个断点为 1 的羁绊）属于**常规机制**，由断点数据
  自动处理，不需要声明。
- 峡谷野怪 10 档会给+人口，按固定人口建模忽略（该档位需要 10 计数，仅全峡谷野怪阵容可达）。

## 评分与建模

- 常规棋子：占 1 格，对自身每个羁绊 +1 计数；特殊棋子按数据 JSON 里的通用字段处理：
  `slots`（占格数）、`weights`（羁绊计数权重）、`tierRules`（某档的激活条件）、`groups`（互斥组）。
- 档位 = 该羁绊踩到的断点个数（断点允许重复，如宿敌 1/1/2）；总分 = Σ档位。
- 整数规划：`x[棋子]∈{0,1}`，人口约束 Σ slots·x = N，互斥组 Σx ≤ 1，
  档位变量 `y[羁绊,断点]` 满足 `加权计数 ≥ 断点·y`（有激活条件的档位再加
  `计数 + M·y ≤ 条件值 + M` 强制恰好计数），最大化 Σy。
- Top-K 并列解：用"禁止重复解"约束（no-good cut）迭代枚举，按羁绊档位构成去重。

## 目录结构

```
cli.js              命令行入口
server.js           Web 版服务器（静态页面 + /api/data、/api/solve）
web/                Web 前端（原生 HTML/CSS/JS，无构建步骤）
lib/solve.js        求解器（ILP 建模 + Top-K 枚举 + 羁绊明细计算）
scripts/extract.js  CommunityDragon 数据提取（解释 sets/s{N}.rules.js 里的赛季规则）
sets/s18.rules.js   S18 特殊规则（互斥组、计数权重），按赛季独立维护
data/s18.json       S18 结构化数据（棋子/羁绊/互斥组/权重）
data/s18_summary.md S18 人工核对清单
raw/                原始下载（.gitignore）
```

## 跨平台（Windows / Ubuntu）

- 纯 JavaScript + WebAssembly，**零原生依赖**：求解器 glpk.js 只依赖纯 JS 的 pako，
  分发物为 js + wasm，`node_modules` 里没有任何平台二进制包，Windows 和 Ubuntu 上
  `npm install` 的产物完全一致（项目目录直接拷过去也能跑）。
- 文件路径全部走 `path.join`/`__dirname`，无盘符、无反斜杠硬编码、无 `process.platform` 分支。
- 环境要求：**Node ≥ 18**（用到全局 fetch；已在 Windows + Node 24 开发验证）。
- Ubuntu 运行：
  ```bash
  sudo apt install nodejs npm   # 或用 nvm 装 18+
  npm install && node cli.js
  ```
- 中文输出为 UTF-8：Ubuntu 终端默认就是 UTF-8；Windows 建议用 Windows Terminal / Git Bash，
  老 cmd 代码页（cp936）下中文显示可能乱码（仅显示问题，`--json` 输出不受影响）。

## 已知边界 / 计划

- 不含转职纹章、海克斯、费用上限约束（可加 `--max-cost`，欢迎提需求）。
- 峡谷野怪 10 档的+人口奖励未建模。
