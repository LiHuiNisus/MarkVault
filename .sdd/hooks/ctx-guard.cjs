#!/usr/bin/env node
/*
 * ctx-guard — 上下文预算守护
 *
 * 三个事件共用这一个脚本，按 stdin 里的 hook_event_name 分流：
 *   UserPromptSubmit  → 每轮开头播报剩余预算；越过阈值就要求先落盘再继续
 *   PreCompact        → 把「必须保留什么」写成自定义压缩指令；同时落一份确定性快照
 *   SessionStart      → source=compact 时把快照喂回去，压缩后不用靠人回忆
 *
 * 设计约束：
 *   - 永不阻断。任何异常都吞掉并 exit 0，hook 挂掉不能拖垮会话。
 *   - 快照由脚本自己写，不依赖模型记得写：模型忘了也有兜底。
 *   - 阈值可按模型窗口配置，见 .sdd/hooks/ctx-guard.json。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* 项目根：优先环境变量；否则按脚本自身位置推（本文件在 <根>/.sdd/hooks/ 下），
   这样即使 hook 的 cwd 不是项目根也能找到 .sdd/progress.md 等文件。 */
const ROOT = process.env.CLAUDE_PROJECT_DIR
  || (fs.existsSync(path.join(__dirname, '..', '..', 'ui')) ? path.resolve(__dirname, '..', '..') : process.cwd());
const CFG_PATH = path.join(ROOT, '.sdd', 'hooks', 'ctx-guard.json');
const HANDOFF = path.join(ROOT, '.sdd', 'context-handoff.md');
const STATE = path.join(ROOT, '.sdd', '.ctx-guard-state.json');

const DEFAULTS = {
  // 0 = 自动探测。取 transcript 里历次压缩的 preTokens 最大值，它约等于真实可用窗口，
  // 比按模型名猜可靠（不同模型窗口不同，配错会让所有阈值同时失准）。
  windowTokens: 0,
  fallbackWindowTokens: 1000000,
  warnAt: 0.55,
  urgentAt: 0.70,
  criticalAt: 0.82,
  handoffEveryTokens: 60000,
};

function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }; }
  catch { return DEFAULTS; }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function k(n) { return Math.round(n / 1000) + 'k'; }

/* 上下文大小 = 最后一次 assistant 响应的 input + cache_read + cache_creation。
   实测与 compactMetadata.preTokens 相差 < 0.1%，可直接当作当前占用。
   顺便收集历次压缩的 preTokens，用于自动探测真实窗口大小。 */
function readUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n');
  let usage = null, lastUser = '', lastAssistantText = '', edited = [], commands = [];
  let observedCeiling = 0;
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && o.message) {
      const u = o.message.usage;
      if (u) {
        usage = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
      const content = o.message.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text) lastAssistantText = c.text;
          if (c.type === 'tool_use') {
            const inp = c.input || {};
            if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit') && inp.file_path) {
              edited.push(inp.file_path);
            }
            if (c.name === 'Bash' && inp.command) commands.push(inp.command);
          }
        }
      }
    }
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
      // 过滤掉工具结果与系统注入，只留真人输入
      if (text && !text.startsWith('<') && !text.includes('<system-reminder>')) lastUser = text;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const pre = o.compactMetadata && o.compactMetadata.preTokens;
      if (pre > observedCeiling) observedCeiling = pre;
    }
  }
  return {
    tokens: usage || 0,
    observedCeiling,
    lastUser: lastUser.slice(0, 1500),
    lastAssistantText: lastAssistantText.slice(-1200),
    edited: [...new Set(edited)].slice(-30),
    commands: commands.slice(-12),
  };
}

function gitSummary() {
  const run = cmd => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim(); }
    catch { return ''; }
  };
  return {
    branch: run('git rev-parse --abbrev-ref HEAD'),
    head: run('git log --oneline -1'),
    status: run('git status --short').split('\n').filter(Boolean).slice(0, 40),
    diffstat: run('git diff --stat').split('\n').filter(Boolean).slice(-12),
  };
}

function rel(p) {
  try { return path.relative(ROOT, p).replace(/\\/g, '/'); } catch { return p; }
}

/* 真实窗口大小：显式配置优先；否则用 transcript 里观察到的压缩顶点；
   两者都没有（全新会话）才退回默认值。 */
function resolveWindow(cfg, usage) {
  if (cfg.windowTokens > 0) return cfg.windowTokens;
  if (usage && usage.observedCeiling > 0) return usage.observedCeiling;
  return cfg.fallbackWindowTokens;
}

function writeHandoff(usage, reason, cfg) {
  const g = gitSummary();
  const win = resolveWindow(cfg, usage);
  const pct = Math.round((usage.tokens / win) * 100);
  const parts = [];
  parts.push('# 上下文交接快照');
  parts.push('');
  parts.push(`> 由 ctx-guard 在 ${new Date().toISOString()} 自动生成（${reason}，占用约 ${k(usage.tokens)} / ${k(win)}，${pct}%）。`);
  parts.push('> 这份文件的作用：上下文被压缩或会话重开后，据此恢复工作状态。每次触发会整份重写，不会无限变长。');
  parts.push('');
  parts.push('## 最近一次用户指令');
  parts.push('```');
  parts.push(usage.lastUser || '(未捕获)');
  parts.push('```');
  parts.push('');
  parts.push('## 最近一次助手回复（截尾）');
  parts.push('```');
  parts.push(usage.lastAssistantText || '(未捕获)');
  parts.push('```');
  parts.push('');
  parts.push('## 本轮改动过的文件');
  if (usage.edited.length) usage.edited.forEach(f => parts.push('- `' + rel(f) + '`'));
  else parts.push('(无)');
  parts.push('');
  parts.push('## 最近执行过的命令');
  if (usage.commands.length) usage.commands.forEach(c => parts.push('- `' + c.replace(/\s+/g, ' ').slice(0, 160) + '`'));
  else parts.push('(无)');
  parts.push('');
  parts.push('## 仓库状态');
  parts.push('- 分支：`' + (g.branch || '?') + '`');
  parts.push('- HEAD：`' + (g.head || '?') + '`');
  if (g.status.length) {
    parts.push('- 工作区：');
    g.status.forEach(s => parts.push('  - `' + s + '`'));
  } else {
    parts.push('- 工作区：干净');
  }
  if (g.diffstat.length) {
    parts.push('- 改动统计：');
    parts.push('```');
    g.diffstat.forEach(s => parts.push(s));
    parts.push('```');
  }
  parts.push('');
  parts.push('## 恢复步骤');
  parts.push('1. 读 `.sdd/progress.md` 的最近一节，确认整体进度。');
  parts.push('2. 读本文件「最近一次用户指令」，确认当前要做什么。');
  parts.push('3. 读本文件「本轮改动过的文件」，只重读这些文件的相关片段，不要全量重读。');
  parts.push('4. `git status` 确认改动仍在，再继续。');
  parts.push('');
  fs.mkdirSync(path.dirname(HANDOFF), { recursive: true });
  fs.writeFileSync(HANDOFF, parts.join('\n'), 'utf8');
  return HANDOFF;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s), 'utf8'); } catch { }
}

/* ---- UserPromptSubmit：播报预算 + 按阈值下达动作指令 ---- */
function onPrompt(cfg, usage) {
  if (!usage || !usage.tokens) {
    return '[ctx-guard] 读不到当前上下文用量（transcript 未就绪）。继续工作即可。';
  }
  const win = resolveWindow(cfg, usage);
  const ratio = usage.tokens / win;
  const state = loadState();
  const pct = Math.round(ratio * 100);

  if (ratio >= cfg.warnAt) {
    // 越阈值后按增量重写快照，既保证新鲜，又不会每轮都写
    if (!state.lastHandoffTokens || usage.tokens - state.lastHandoffTokens >= cfg.handoffEveryTokens || ratio >= cfg.criticalAt) {
      try {
        writeHandoff(usage, '上下文 ' + pct + '%', cfg);
        state.lastHandoffTokens = usage.tokens;
        saveState(state);
      } catch { }
    }
  }

  const head = `[ctx-guard] 上下文 ${pct}%（${k(usage.tokens)} / ${k(win)}）`;
  if (ratio >= cfg.criticalAt) {
    return [
      head + ' — 临界。',
      '立即执行，不要先做别的：',
      '1. 把当前进度追加到 `.sdd/progress.md`（改了哪些文件、还剩什么、怎么验证）。',
      '2. 不要开新的任务、不要做大规模重构、不要全量重读大文件。',
      '3. 手上这步做完就停，回复末尾写明「建议 /compact」。',
      '快照已自动写到 `.sdd/context-handoff.md`。',
    ].join('\n');
  }
  if (ratio >= cfg.urgentAt) {
    return [
      head + ' — 高。',
      '本轮按收尾节奏走：先把手上这一步做完并验证，再决定要不要开新一步。',
      '不要新增探索性的大范围搜索或全量读文件；需要新信息时只读目标片段（offset/limit）。',
      '做完这一步就把结论追加到 `.sdd/progress.md`，然后建议用户 /compact。',
    ].join('\n');
  }
  if (ratio >= cfg.warnAt) {
    return [
      head + ' — 过半。',
      '照常工作，但遵守三条：读大文件用 offset/limit 只取需要的片段；长输出先管道过滤再读；',
      '每完成一个可验证的小步就把结论写进 `.sdd/progress.md`（而不是攒到最后）。',
    ].join('\n');
  }
  return head + ' — 充裕，正常节奏。';
}

/* ---- PreCompact：写自定义压缩指令，告诉摘要器必须保住什么 ---- */
function onPreCompact(cfg, input, usage) {
  let handoffNote = '';
  if (usage && usage.tokens) {
    try { writeHandoff(usage, '压缩前', cfg); handoffNote = '已自动写入 `.sdd/context-handoff.md`。'; } catch { }
  }
  const lines = [
    '压缩时必须保留以下内容，其余可自由概括：',
    '1. 用户当前尚未完成的指令原文，以及任何明确的约束（例如「不要提交」「只改某个文件」「用中文」）。',
    '2. 本次改动涉及的文件的完整路径，以及每个文件改了什么、为什么改。',
    '3. 已验证通过的检查项与对应的验证命令；失败的检查项与失败现象原文（错误串必须原样保留）。',
    '4. 尚未完成的事项清单，以及下一步要做的具体动作。',
    '5. 已经排除的方案与排除理由，避免重走后路。',
    '不要保留：冗长的工具输出、重复的文件内容、已完成的探索过程细节。',
    handoffNote,
    '如果上述信息已写在 `.sdd/progress.md` 或 `.sdd/context-handoff.md`，摘要里注明「详见该文件」即可，不要重复抄写。',
  ];
  return lines.join('\n');
}

/* ---- SessionStart(compact)：把快照喂回去 ---- */
function onSessionStart(cfg, input) {
  if (input.source !== 'compact') return '';
  let text = '';
  try { text = fs.readFileSync(HANDOFF, 'utf8'); } catch { return ''; }
  // 快照可能很长，截到关键节，避免压缩后立刻又吃满
  const cut = text.slice(0, 6000);
  return [
    '[ctx-guard] 上下文刚刚压缩。下面是压缩前自动落盘的交接快照，据此恢复状态，不要再全量重读项目文件。',
    '',
    cut,
  ].join('\n');
}

function main() {
  const cfg = loadCfg();
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { }
  const event = input.hook_event_name || process.env.CTX_GUARD_EVENT || '';
  const usage = readUsage(input.transcript_path);

  let out = '';
  if (event === 'UserPromptSubmit') out = onPrompt(cfg, usage);
  else if (event === 'PreCompact') out = onPreCompact(cfg, input, usage);
  else if (event === 'SessionStart') out = onSessionStart(cfg, input);

  if (out) process.stdout.write(out + '\n');
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
