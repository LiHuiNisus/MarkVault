const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);

const state = {
  notes: [], current: null, dirty: false, config: null,
  layout: 'both', outlineOpen: false, sidebarOpen: true,
  folders: [], activeFolder: '',
  // 结构化筛选：tags 走 frontmatter 精确匹配，folderFilter 为 null 表示不限、'' 表示只看根目录
  tagFilter: [], folderFilter: null,
  // 多选集合：存 file_name。用于批量移动。
  selected: new Set(),
  allTags: [],
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem('mv_' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mv_' + k, v); } catch { } },
};

/* ---------- 配置 ---------- */
async function ensureConfig() {
  if (state.config) return state.config;
  let cfg = await invoke('get_config');
  if (!cfg) {
    const dir = await invoke('pick_vault_dir');
    if (!dir) return null;
    cfg = await invoke('set_config', { dir });
  }
  state.config = cfg;
  return cfg;
}

/* ---------- 编辑器高亮（逐行，对齐 MarkPane：定界符保留着色，覆盖层与 textarea 严格对齐） ---------- */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* 行内高亮：先标签、再链接/代码、后强调；定界符一并包进 span，字符数不变 */
function applyInlineHl(s) {
  s = s.replace(/&lt;(\/?)([\w-]+)([\s\S]*?)&gt;/g, '<span class="hl-tag">&lt;$1$2$3&gt;</span>');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="hl-link">![$1]($2)</span>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="hl-link">[$1]($2)</span>');
  s = s.replace(/`([^`\n]+?)`/g, '<span class="hl-code">`$1`</span>');
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<span class="hl-bold">**$1**</span>');
  s = s.replace(/__([^_\n]+?)__/g, '<span class="hl-bold">__$1__</span>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<span class="hl-strike">~~$1~~</span>');
  s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '<span class="hl-italic">*$1*</span>');
  s = s.replace(/(?<!_)_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, '<span class="hl-italic">_$1_</span>');
  return s;
}

let inCode = false;
function hlLine(raw) {
  const line = esc(raw);
  if (/^```/.test(raw.trim())) {
    inCode = !inCode;
    return `<span class="hl-fence">${line}</span>`;
  }
  if (inCode) return `<span class="hl-codeblock">${line}</span>`;
  if (/^>\s?/.test(raw)) return `<span class="hl-quote">${applyInlineHl(line)}</span>`;
  if (/^#{1,6}\s/.test(raw)) {
    const h = line.match(/^(#{1,6})(\s+)([\s\S]*)$/);
    if (h) return `<span class="hl-heading-mark">${h[1]}</span>${h[2]}<span class="hl-heading">${applyInlineHl(h[3])}</span>`;
  }
  if (/^(\*{3,}|-{3,}|_{3,})$/.test(raw.trim())) return `<span class="hl-hr">${line}</span>`;
  // 表格：整行以 | 开头结尾；分隔行（|---|）与普通行区分着色
  if (/^\s*\|.*\|\s*$/.test(raw)) {
    const cls = /^\s*\|[\s:|-]+\|\s*$/.test(raw) ? 'hl-table-sep' : 'hl-table';
    return `<span class="${cls}">${line}</span>`;
  }
  let chunk = line;
  chunk = chunk.replace(/^(\s*)(\d+\.)(\s)/, '$1<span class="hl-meta">$2</span>$3');
  chunk = chunk.replace(/^(\s*)([-*+])(\s)/, '$1<span class="hl-meta">$2</span>$3');
  return applyInlineHl(chunk);
}

function renderHighlight() {
  const val = $('editor').value;
  const lines = val.split('\n');
  inCode = false;
  $('editor-highlight').innerHTML = lines.map(l => `<div class="hl-line">${hlLine(l) || '​'}</div>`).join('');
  const hlLines = $('editor-highlight').querySelectorAll('.hl-line');
  const gutter = $('editor-gutter');
  gutter.innerHTML = lines.map((_, i) => `<div class="line-num">${i + 1}</div>`).join('');
  // 按高亮层每行实际高度（含自动换行）拉伸行号，长行下方行号不错位。
  // 用 getBoundingClientRect 保留小数：offsetHeight 取整会在几百行后累积明显漂移。
  const nums = gutter.querySelectorAll('.line-num');
  hlLines.forEach((el, i) => {
    const h = el.getBoundingClientRect().height;
    if (h > 0 && nums[i]) nums[i].style.height = h + 'px';
  });
}

/* ---------- 预览渲染 ---------- */
function render(md) {
  const html = marked.parse(md || '');
  $('preview').innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['badges', 'u'], ADD_ATTR: ['tone'] });
  enhancePreviewHtml();
  // 正文为空时给预览区块一个空态覆盖层，避免新用户对着白框（不写进 #preview，免得被导出带走）
  renderPreviewEmptyState(!(md || '').trim());
  renderOutline();
  renderWordCount(md || '');
}

function renderWordCount(md) {
  // 统计口径：剥掉代码块/行内代码/图片/URL，再数中文字与英文词，避免把代码和链接算进正文
  const stripped = (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
  const cjk = (stripped.match(/[一-鿿]/g) || []).length;
  // 中文标点也算"字"（与常见写作工具口径一致），但不计空白与 markdown 符号
  const cjkPunct = (stripped.match(/[　-〿＀-￯]/g) || []).length;
  const words = (stripped.replace(/[一-鿿　-〿＀-￯]/g, ' ')
    .match(/[A-Za-z0-9_]+/g) || []).length;
  const text = (cjk + cjkPunct) + ' 字 · ' + words + ' 词';
  $('word-count').textContent = text;
  // 顶栏也放一份：仅编辑模式下预览工具条整体隐藏，字数不能跟着消失
  const hdr = $('header-word-count');
  if (hdr) hdr.textContent = (cjk + cjkPunct) + ' 字';
}

/* ---------- 目录 ----------
   大纲从**源码**解析（不依赖预览 DOM），因此「仅编辑」模式下也能用、也能跳。
   每条记录源码行号，点击滚动编辑区到该行，并同步把预览带到对应标题。 */
let outlineTimer = null;
let outlineShowAll = false;
// 标题解析结果缓存：滚动同步与大纲刷新都在热路径上，正文没变时不重复扫全文
let headingCache = { src: null, out: [] };
function parseHeadings(md) {
  const src = md || '';
  if (headingCache.src === src) return headingCache.out;
  const out = [];
  const lines = src.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m) { out.push({ level: m[1].length, text: m[2].replace(/\s*#+\s*$/, '').trim(), line: i }); continue; }
    // setext 标题：下一行是 === 或 --- 时，当前非空行成为 H1/H2（marked 也这么渲染）
    const next = lines[i + 1];
    if (l.trim() && next && /^\s*(=+|-+)\s*$/.test(next) && !/^\s*\|/.test(l)) {
      const setextLevel = next.trim()[0] === '=' ? 1 : 2;
      out.push({ level: setextLevel, text: l.trim(), line: i });
      i++; // 跳过下划线行，避免它被当成别的结构
    }
  }
  headingCache = { src, out };
  return out;
}
function renderOutline() {
  const list = $('outline-list');
  list.innerHTML = '';
  const all = parseHeadings($('editor').value);
  const hs = outlineShowAll ? all : all.filter(h => h.level <= 3);
  if (!all.length) {
    list.innerHTML = '<div class="outline-empty">暂无标题，使用 # 添加章节</div>';
    return;
  }
  if (!hs.length) {
    list.innerHTML = '<div class="outline-empty">只有 H4 以下标题</div>';
  }
  hs.forEach((h, i) => {
    const btn = document.createElement('button');
    btn.className = 'outline-item level-' + h.level;
    btn.innerHTML = '<span class="outline-item-dot"></span>';
    const txt = document.createElement('span');
    txt.className = 'outline-item-text';
    txt.textContent = h.text;
    btn.appendChild(txt);
    btn.onclick = () => {
      const ta = $('editor');
      const idx = ta.value.split('\n').slice(0, h.line).join('\n').length + (h.line ? 1 : 0);
      const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      // 先定位预览（它会抢占同步锁），再滚编辑区，避免两侧锚点互相拉扯
      syncPreviewToLine(h.line);
      $('editor-scroll').scrollTop = Math.max(0, h.line * lineH - $('editor-scroll').clientHeight / 3);
      ta.focus();
      ta.setSelectionRange(idx, idx);
      setActiveOutline(i);
    };
    list.appendChild(btn);
  });
  // 「显示全部层级 / 只看 H1-H3」切换：长文里避免 H4-H6 把面板挤满
  const toggle = document.createElement('button');
  toggle.className = 'outline-item outline-toggle';
  toggle.innerHTML = '<span class="outline-item-text"></span>';
  toggle.querySelector('.outline-item-text').textContent = outlineShowAll ? '只看 H1–H3' : '显示全部层级';
  toggle.onclick = () => { outlineShowAll = !outlineShowAll; renderOutline(); };
  list.appendChild(toggle);
}

/* 把预览滚到源码第 line 行对应的那个标题（预览里 h1-h6 与源码标题顺序一一对应）。
   跳转期间屏蔽另一侧的锚点同步，否则 smooth 滚动会被 syncScroll 反复拉回。 */
function syncPreviewToLine(line) {
  const all = parseHeadings($('editor').value);
  const i = all.findIndex(h => h.line === line);
  if (i < 0) return;
  const hs = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  if (!hs[i]) return;
  const pv = $('preview');
  syncFrom = pv; // 抢占来源锁：期间编辑区的滚动同步直接 return
  clearTimeout(syncResetTimer);
  syncResetTimer = setTimeout(() => { syncFrom = null; }, 700);
  pv.scrollTop = Math.max(0, hs[i].offsetTop - 20);
}

function setActiveOutline(idx) {
  document.querySelectorAll('#outline-list .outline-item').forEach((el, i) => {
    el.classList.toggle('is-active', i === idx);
  });
}

/* 编辑区滚动时高亮当前章节：按"最后一个行号小于当前滚动行的标题"判定 */
function updateOutlineFromEditor() {
  if (!state.outlineOpen) return;
  const hs = parseHeadings($('editor').value).filter(h => outlineShowAll || h.level <= 3);
  if (!hs.length) return;
  const ta = $('editor');
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  const cur = ($('editor-scroll').scrollTop + 40) / lineH;
  let idx = 0;
  hs.forEach((h, i) => { if (h.line <= cur) idx = i; });
  setActiveOutline(idx);
}

/* ---------- 编辑/预览滚动同步 ----------
   纯百分比映射在长文里必然错位（预览有标题间距、代码块、图片，比例差异大）。
   改为标题锚点对齐：以两侧"最近的标题"为基准，把锚点标题的偏移对齐后再映射，
   没有标题可锚定时退回百分比。 */
let syncFrom = null, syncResetTimer = null;
function syncScroll(src, dst) {
  if (syncFrom && syncFrom !== src) return;
  syncFrom = src;
  clearTimeout(syncResetTimer);
  syncResetTimer = setTimeout(() => { syncFrom = null; }, 120);
  const srcMax = src.scrollHeight - src.clientHeight;
  if (srcMax <= 1) return;
  const toEditor = dst === $('editor-scroll');
  const hs = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  const srcLines = parseHeadings($('editor').value);
  if (hs.length && srcLines.length) {
    const ta = $('editor');
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    if (!toEditor) {
      // 编辑区 → 预览：找当前视口顶端的源码行，定位其上方最近标题
      const curLine = (src.scrollTop + 40) / lineH;
      let i = -1;
      srcLines.forEach((h, k) => { if (h.line <= curLine && k < hs.length) i = k; });
      if (i >= 0) {
        const anchorSrc = srcLines[i].line * lineH;
        const frac = Math.max(0, src.scrollTop - anchorSrc);
        dst.scrollTop = Math.max(0, hs[i].offsetTop + frac * (hs[i + 1] ? 0.9 : 1) - 40);
        return;
      }
    } else {
      // 预览 → 编辑区：找当前视口顶端上方最近的标题，滚到其源码行
      const top = src.scrollTop;
      let i = -1;
      hs.forEach((h, k) => { if (k < srcLines.length && h.offsetTop - 40 <= top) i = k; });
      if (i >= 0) {
        const frac = Math.max(0, top - hs[i].offsetTop);
        dst.scrollTop = Math.max(0, srcLines[i].line * lineH + frac * 0.9);
        return;
      }
    }
  }
  // 兜底：百分比映射
  const ratio = src.scrollTop / srcMax;
  dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
}
$('editor-scroll').addEventListener('scroll', () => {
  syncScroll($('editor-scroll'), $('preview'));
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(updateOutlineFromEditor, 80);
});
$('preview').addEventListener('scroll', () => {
  syncScroll($('preview'), $('editor-scroll'));
});

/* ---------- 保存 ---------- */
let saveTimer = null, saveMaxTimer = null;
/* 保存失败后进入持久错误态：后续成功保存前不清除，避免用户误以为一直在存 */
let saveError = '';
function setStatus(t, kind) {
  const el = $('save-status');
  el.textContent = t;
  el.classList.remove('error', 'ok');
  if (kind === 'error') el.classList.add('error');
  else if (kind === 'ok') el.classList.add('ok');
}
/* 防抖 + 最大等待：连续打字时最多 8 秒必落盘一次，避免长时间只存在于内存 */
function scheduleAutosave() {
  state.dirty = true;
  if (!saveError) setStatus('未保存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 2000);
  if (!saveMaxTimer) saveMaxTimer = setTimeout(doSave, 8000);
}

async function doSave() {
  // 返回是否已成功落盘。关窗前与换库前依赖该结果，失败时不得继续销毁页面。
  if (!state.current) return true;
  clearTimeout(saveTimer);
  clearTimeout(saveMaxTimer);
  saveMaxTimer = null;
  const title = $('doc-title').value.trim() || '无标题';
  const tags = $('tags-input').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const content = $('editor').value;
  // 新笔记落到当前选中的文件夹；已有笔记的路径以 state.current.file_name 为准。
  // 若正开着文件夹筛选，则新笔记直接落在该文件夹里（所见即所得）。
  const folder = state.current.file_name
    ? folderOfKey(state.current.file_name)
    : (state.folderFilter !== null ? state.folderFilter : state.activeFolder);
  try {
    const meta = await invoke('save_note', { fileName: state.current.file_name || '', title, tags, content, folder });
    state.current = meta;
    state.dirty = false;
    LS.set('last_open', meta.file_name);
    updateHeaderPath(meta);
    document.title = (title === '无标题' ? '未命名文档' : title) + ' - MarkVault';
    saveError = '';
    setStatus('已保存 ' + new Date().toLocaleTimeString(), 'ok');
    await refreshList();
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('未配置') || msg.includes('NotFound')) {
      saveError = '笔记文件夹不可用，请在顶栏更换文件夹';
      setStatus(saveError + '（保存失败）', 'error');
    } else {
      saveError = '保存失败：' + msg;
      setStatus(saveError, 'error');
    }
    return false;
  }
}

/* 原 setStatus 定义已上移到保存区，这里保留其行为供全局复用。 */

/* ---------- 列表 ---------- */
let searchTimer = null;
/* 搜索命中高亮：大小写不敏感，转义正则元字符后分词包裹 <mark> */
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightText(el, text, query) {
  el.textContent = '';
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!terms.length) { el.textContent = text; return; }
  const re = new RegExp('(' + terms.join('|') + ')', 'gi');
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    el.appendChild(mark);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
/* 笔记唯一键 = 相对路径。Rust 端 file_name 就存这个（"文件夹/笔记.md"，根目录为裸名），
   前端直接复用，不另造字段：传出去 invoke 的字符串与 Rust resolve 的完全一致。 */
function noteKey(n) {
  return n.file_name;
}
function folderOfKey(key) {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}
function baseNameOfKey(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

/* 折叠状态持久化：整表每次重建，所以必须在构建时套用，不能事后补 */
function loadCollapsed() {
  try { return new Set(JSON.parse(LS.get('folders_collapsed', '[]'))); } catch { return new Set(); }
}
let collapsedFolders = loadCollapsed();
function saveCollapsed() { LS.set('folders_collapsed', JSON.stringify([...collapsedFolders])); }

/* 多选：Ctrl/Cmd+点击切换单项，Shift+点击选到该行（含）的连续区间。
   右键落在已选中的行上时，菜单操作作用于整组选中项。 */
function toggleSelect(key) {
  if (state.selected.has(key)) state.selected.delete(key);
  else state.selected.add(key);
}
function selectRangeTo(key) {
  const keys = state.notes.map(noteKey);
  const end = keys.indexOf(key);
  if (end < 0) return;
  // 以最近一次选中的项为锚点，没锚点就选到该行本身
  const anchor = state.selected.size ? keys.findIndex(k => state.selected.has(k)) : end;
  const [a, b] = anchor <= end ? [anchor, end] : [end, anchor];
  for (let i = a; i <= b; i++) state.selected.add(keys[i]);
}
/* 批量移动：逐篇调 move_notes，成功后清空选择 */
async function moveSelected(toFolder) {
  const keys = [...state.selected];
  if (!keys.length) return;
  for (const k of keys) {
    if (state.current && noteKey(state.current) === k && state.dirty) await doSave();
  }
  try {
    const pairs = await invoke('move_notes', { fileNames: keys, targetFolder: toFolder || '' });
    const cur = state.current && pairs.find(([from]) => from === noteKey(state.current));
    if (cur) {
      state.current.file_name = cur[1];
      state.current.folder = folderOfKey(cur[1]);
      LS.set('last_open', cur[1]);
      updateHeaderPath(state.current);
    }
    state.selected.clear();
    collapsedFolders.delete(toFolder || '');
    saveCollapsed();
    setStatus(`已移动 ${pairs.length} 篇到「${toFolder || '根目录'}」`, 'ok');
  } catch (e) {
    setStatus('批量移动失败：' + e, 'error');
  }
  await refreshList();
}

/* 单条笔记行：抽出来供各分组复用，逻辑照搬原先平铺列表 */
function buildNoteItem(n, q) {
  const li = document.createElement('li');
  li.dataset.file = noteKey(n);
  li.title = '右键：复制 / 移动 / 复制路径；可直接拖到文件夹';
  li.draggable = true;
  // role=option + tabindex=-1：键盘导航用 roving focus（见 note-list keydown）
  li.setAttribute('role', 'option');
  li.tabIndex = -1;
  const info = document.createElement('div');
  info.className = 'nt-wrap';
  const nt = document.createElement('div');
  nt.className = 'nt';
  highlightText(nt, n.title, q);
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = (n.modified || '').replace('T', ' ');
  info.appendChild(nt);
  info.appendChild(nm);
  li.appendChild(info);
  // 悬停出现的操作按钮：编辑（重命名）/ 删除
  const ops = document.createElement('div');
  ops.className = 'nt-ops';
  const editBtn = document.createElement('button');
  editBtn.className = 'nt-op';
  editBtn.title = '编辑标题';
  editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
  editBtn.onclick = e => { e.stopPropagation(); startInlineRename(li, n); };
  const delBtn = document.createElement('button');
  delBtn.className = 'nt-op danger';
  delBtn.title = '删除笔记';
  delBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
  delBtn.onclick = e => { e.stopPropagation(); deleteNoteFlow(n); };
  ops.appendChild(editBtn);
  ops.appendChild(delBtn);
  li.appendChild(ops);
  if ((n.tags || []).length) {
    const lt = document.createElement('div');
    lt.className = 'lt';
    for (const t of n.tags) {
      const s = document.createElement('span');
      s.className = 'lt-tag';
      s.textContent = t;
      s.onclick = e => { e.stopPropagation(); $('search').value = t; refreshList(); };
      lt.appendChild(s);
    }
    li.appendChild(lt);
  }
  li.onclick = e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSelect(noteKey(n)); renderFilterBar(); syncSelectionDom(); return; }
    if (e.shiftKey) { e.preventDefault(); selectRangeTo(noteKey(n)); renderFilterBar(); syncSelectionDom(); return; }
    if (state.selected.size) { state.selected.clear(); syncSelectionDom(); renderFilterBar(); }
    openNote(noteKey(n));
  };
  if (state.current && noteKey(state.current) === noteKey(n)) li.classList.add('active');
  if (state.selected.has(noteKey(n))) li.classList.add('selected');
  // 拖拽移动：自定义 MIME 标记内部拖拽，避免把资源管理器拖入的文件误判成笔记移动
  li.addEventListener('dragstart', e => {
    // 拖已选中的行时整组带走，否则只带当前行
    if (!state.selected.has(noteKey(n))) state.selected = new Set([noteKey(n)]);
    e.dataTransfer.setData(NOTE_MIME, JSON.stringify([...state.selected]));
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  return li;
}

/* 同步 DOM 上的选中态（键盘/点击改完 state 后调用，避免整表重建） */
function syncSelectionDom() {
  document.querySelectorAll('#note-list li[data-file]').forEach(el => {
    el.classList.toggle('selected', state.selected.has(el.dataset.file));
  });
}

const NOTE_MIME = 'application/x-markvault-note';

/* 文件夹分组：扁平列表 + 轻量分组标头。
   根目录笔记直接平铺；文件夹只用一个标头行分隔，其笔记紧随其后并缩进。
   这样列表不会每篇笔记都被包一层容器，视觉重量最小。 */

/* 分组标头：点击折叠，拖拽落点 */
function buildFolderHeader(name, count, collapsed, selected) {
  const li = document.createElement('li');
  li.className = 'folder-header' + (collapsed ? ' collapsed' : '') + (selected ? ' selected' : '');
  li.dataset.folder = name;
  li.title = '点击折叠/展开；可把笔记拖到这里';
  li.tabIndex = -1;

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  li.appendChild(chev);
  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  li.appendChild(icon.firstChild);
  const nm = document.createElement('span');
  nm.className = 'folder-name';
  nm.textContent = name;
  li.appendChild(nm);
  const cnt = document.createElement('span');
  cnt.className = 'folder-count';
  cnt.textContent = String(count);
  li.appendChild(cnt);

  const ops = document.createElement('div');
  ops.className = 'folder-ops';
  const mkOp = (title, svg, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'nt-op' + (cls ? ' ' + cls : '');
    b.title = title;
    b.innerHTML = svg;
    b.onclick = e => { e.stopPropagation(); fn(); };
    return b;
  };
  ops.appendChild(mkOp('在此新建文档', '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>', '', () => newNoteInFolder(name)));
  ops.appendChild(mkOp('重命名文件夹', '<svg class="icon" viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>', '', () => renameFolderFlow(name)));
  ops.appendChild(mkOp('删除文件夹', '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>', 'danger', () => deleteFolderFlow(name)));
  li.appendChild(ops);

  li.onclick = () => {
    state.activeFolder = name;
    const isCollapsed = li.classList.toggle('collapsed');
    if (isCollapsed) collapsedFolders.add(name);
    else collapsedFolders.delete(name);
    saveCollapsed();
    // 折叠时把该文件夹的笔记行一并隐藏
    let sib = li.nextElementSibling;
    while (sib && sib.classList.contains('in-folder') && sib.dataset.folder === name) {
      sib.hidden = isCollapsed;
      sib = sib.nextElementSibling;
    }
    document.querySelectorAll('#note-list .folder-header').forEach(el => el.classList.toggle('selected', el.dataset.folder === state.activeFolder));
  };
  bindDropTarget(li, name);
  return li;
}

/* 空文件夹占位行：让折叠态之外也能看到「这里可以拖进来」 */
function buildFolderEmpty(name) {
  const li = document.createElement('li');
  li.className = 'folder-empty in-folder';
  li.dataset.folder = name;
  li.textContent = '空文件夹';
  return li;
}

/* 根目录标头：仅在存在文件夹时显示，兼作「拖出文件夹」的落点 */
function buildRootHeader(count) {
  const li = document.createElement('li');
  li.className = 'folder-header root-header' + (state.activeFolder === '' ? ' selected' : '');
  li.dataset.folder = '';
  li.title = '根目录：把笔记拖到这里可移出文件夹';
  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
  li.appendChild(icon.firstChild);
  const nm = document.createElement('span');
  nm.className = 'folder-name';
  nm.textContent = '根目录';
  li.appendChild(nm);
  const cnt = document.createElement('span');
  cnt.className = 'folder-count';
  cnt.textContent = String(count);
  li.appendChild(cnt);
  li.onclick = () => {
    state.activeFolder = '';
    document.querySelectorAll('#note-list .folder-header').forEach(el => el.classList.toggle('selected', el.dataset.folder === ''));
  };
  bindDropTarget(li, '');
  return li;
}

/* 空文件夹占位行 */
/* 落点：文件夹项整体（头部与其下笔记区都算），拖到根区块即移出 */
function bindDropTarget(el, folder) {
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes(NOTE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', e => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-target');
  });
  el.addEventListener('drop', async e => {
    if (!e.dataTransfer.types.includes(NOTE_MIME)) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    // payload 是 JSON 数组（多选拖拽）；兼容旧格式（单个相对路径字符串）
    let keys = [];
    try {
      const raw = e.dataTransfer.getData(NOTE_MIME);
      const parsed = JSON.parse(raw);
      keys = Array.isArray(parsed) ? parsed : [raw];
    } catch { keys = []; }
    keys = keys.filter(k => k && folderOfKey(k) !== folder);
    if (!keys.length) return;
    // 单篇与多篇走同一条批量路径，行为一致
    state.selected = new Set(keys);
    await moveSelected(folder);
  });
}

async function refreshList() {
  const q = $('search').value.trim();
  const sort = LS.get('sort', 'modified');
  // 结构化筛选与搜索叠加，后端统一过滤（标签只比 frontmatter，不搜正文）
  const args = { query: q, sort };
  if (state.tagFilter.length) args.tags = state.tagFilter;
  if (state.folderFilter !== null) args.folder = state.folderFilter;
  try {
    state.notes = await invoke('search_notes', args);
  } catch {
    state.notes = await invoke('list_notes', { sort });
  }
  try { state.folders = await invoke('list_folders'); } catch { state.folders = []; }
  try { state.allTags = await invoke('list_tags'); } catch { state.allTags = []; }
  // 多选状态与新列表求交，避免残留已不存在的选中项
  const alive = new Set(state.notes.map(n => noteKey(n)));
  [...state.selected].forEach(k => { if (!alive.has(k)) state.selected.delete(k); });
  renderFilterBar();
  const ul = $('note-list');
  ul.innerHTML = '';
  // 按 folder 分桶；空文件夹也要出现，否则没法往里拖
  const buckets = new Map();
  for (const n of state.notes) {
    const f = n.folder || '';
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f).push(n);
  }
  const names = new Set([...(state.folders || []), ...buckets.keys()]);
  names.delete('');
  const folderNames = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const rootNotes = buckets.get('') || [];
  // 正在编辑但尚未落盘的新笔记：先建好占位行，空列表/有列表都要显示
  const draftItem = state.current && !state.current.file_name ? buildDraftItem($('doc-title').value) : null;
  if (!state.notes.length && !folderNames.length) {
    if (draftItem) ul.appendChild(draftItem);
    else {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = q ? '没有匹配的笔记' : '点击「新建」写第一篇笔记';
      ul.appendChild(li);
    }
    renderTagBar();
    return;
  }
  // 扁平排列：根标头（有文件夹时才显示）→ 根笔记 → 各文件夹（标头 + 其笔记）
  // 同组内保持 Rust 给的 modified 倒序，不重排。
  const frag = document.createDocumentFragment();
  if (draftItem) frag.appendChild(draftItem);
  if (folderNames.length) frag.appendChild(buildRootHeader(rootNotes.length));
  for (const n of rootNotes) {
    const el = buildNoteItem(n, q);
    if (folderNames.length) el.classList.add('in-folder');
    frag.appendChild(el);
  }
  for (const name of folderNames) {
    const isCollapsed = collapsedFolders.has(name);
    frag.appendChild(buildFolderHeader(name, (buckets.get(name) || []).length, isCollapsed, state.activeFolder === name));
    const notes = buckets.get(name) || [];
    if (!notes.length) {
      const empty = buildFolderEmpty(name);
      empty.hidden = isCollapsed;
      frag.appendChild(empty);
    }
    for (const n of notes) {
      const el = buildNoteItem(n, q);
      el.classList.add('in-folder');
      el.dataset.folder = name;
      el.hidden = isCollapsed;
      // 落点覆盖整个文件夹区块：拖到该文件夹的笔记行上也等于是放进这个文件夹
      bindDropTarget(el, name);
      frag.appendChild(el);
    }
  }
  ul.appendChild(frag);
  renderTagBar();
}

/* 草稿占位行：点「新建」后立刻可见，不再等 2 秒自动保存才出现条目。 */
function buildDraftItem(title) {
  const li = document.createElement('li');
  li.className = 'draft';
  const nt = document.createElement('div');
  nt.className = 'nt';
  nt.textContent = title || '未命名文档';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = '编辑中…（自动保存后落到列表）';
  li.appendChild(nt);
  li.appendChild(nm);
  li.onclick = e => { e.stopPropagation(); $('doc-title').focus(); };
  return li;
}

/* 悬停编辑：列表项内联输入框替换标题，Enter/失焦提交，Esc 取消 */
/* 重命名：Enter 提交，Esc/失焦取消（失焦提交会静默写入半截标题，故改成取消）。 */
function startInlineRename(li, n) {
  if (li.querySelector('.rename-input')) return;
  const nt = li.querySelector('.nt');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = n.title;
  // 可拖拽祖先会吃掉输入框内的文本选择，重命名期间必须临时关掉
  li.draggable = false;
  nt.replaceWith(input);  input.focus();
  input.select();
  let done = false;
  const commit = async ok => {
    if (done) return;
    done = true;
    li.draggable = true;
    const title = input.value.trim();
    if (!ok || !title || title === n.title) { await refreshList(); return; }
    try {
      await invoke('rename_note', { fileName: n.file_name, title });
      if (state.current && state.current.file_name === n.file_name) {
        state.current.title = title;
        $('title-input').value = title;
        $('doc-title').value = title;
      }
      setStatus('已重命名', 'ok');
    } catch (e) {
      setStatus('重命名失败：' + e, 'error');
    }
    await refreshList();
  };
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(false);
}

/* 删除：系统原生确认弹窗，确认后删除并清空编辑区（若正打开该笔记） */
async function deleteNoteFlow(n) {
  const ok = await invoke('confirm_dialog', {
    title: '确认删除',
    message: `确定删除「${n.title}」？将移入系统回收站，可从回收站恢复。`,
    okLabel: '删除',
    cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    await invoke('delete_note', { fileName: n.file_name });
    if (state.current && state.current.file_name === n.file_name) {
      state.current = null;
      $('title-input').value = '';
      $('doc-title').value = '';
      $('tags-input').value = '';
      $('editor').value = '';
      $('header-path').hidden = true;
      $('header-path').textContent = '';
      renderHighlight();
      render('');
      state.dirty = false;
      document.title = 'MarkVault';
    }
    setStatus('已删除', 'ok');
  } catch (e) {
    setStatus('删除失败：' + e, 'error');
  }
  await refreshList();
}

/* ---------- 笔记列表右键菜单 ---------- */
/* 笔记项：复制文件到剪贴板 / 复制完整路径 / 移动到文件夹
   文件夹项：在此新建 / 重命名 / 删除。两套菜单项共用一个 #ctx-menu，靠分组显隐切换。 */
let ctxTarget = null;      // 笔记模式下的相对路径
let ctxFolder = null;      // 文件夹模式下的文件夹名（'' 表示根目录）

function showCtxMenu(x, y) {
  const m = $('ctx-menu');
  m.hidden = false;
  // 贴近光标显示，超出视口右/下边缘时回折，避免菜单被裁掉
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
}
function hideCtxMenu() {
  $('ctx-menu').hidden = true;
  $('move-submenu').classList.remove('show');
}

/* 「移动到…」二级菜单：列出根目录 + 所有文件夹，标出当前所在位置。
   多选时对整组生效。 */
function buildMoveSubmenu(currentKey) {
  const sub = $('move-submenu');
  sub.innerHTML = '';
  const cur = folderOfKey(currentKey);
  const multi = state.selected.size > 1;
  const mk = (label, to) => {
    const d = document.createElement('div');
    d.className = 'dropdown-item' + (!multi && to === cur ? ' is-current' : '');
    d.textContent = (!multi && to === cur) ? '✓ ' + label : label;
    d.onclick = async ev => {
      ev.stopPropagation();
      hideCtxMenu();
      if (!multi && to === cur) return;
      if (multi) await moveSelected(to);
      else await moveNote(currentKey, to);
    };
    return d;
  };
  sub.appendChild(mk('根目录', ''));
  for (const name of (state.folders || [])) sub.appendChild(mk(name, name));
}

$('note-list').addEventListener('contextmenu', e => {
  const noteLi = e.target.closest('li[data-file]');
  const folderHeader = e.target.closest('.folder-header');
  const noteGroup = document.querySelector('#ctx-menu .ctx-group[data-group="note"]');
  const folderGroup = document.querySelector('#ctx-menu .ctx-group[data-group="folder"]');
  if (noteLi) {
    ctxTarget = noteLi.dataset.file;
    ctxFolder = null;
    noteGroup.hidden = false;
    folderGroup.hidden = true;
    // 右键落在已选中的行上 → 菜单针对整组；否则先把选择收敛到这单独一行
    if (!state.selected.has(ctxTarget)) {
      state.selected = new Set([ctxTarget]);
      syncSelectionDom();
      renderFilterBar();
    }
    buildMoveSubmenu(ctxTarget);
  } else if (folderHeader) {
    ctxFolder = folderHeader.dataset.folder;
    ctxTarget = null;
    noteGroup.hidden = true;
    folderGroup.hidden = false;
  } else {
    return;
  }
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu')) hideCtxMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });
window.addEventListener('blur', () => hideCtxMenu());
window.addEventListener('resize', () => hideCtxMenu());

/* ---------- 笔记列表键盘导航 ----------
   上下移动 / Enter 打开 / F2 重命名 / Delete 删除 / 左右折叠文件夹。
   列表项本身不可聚焦，用 tabindex=-1 做 roving focus；Tab 进入时焦点先落在 ul 上。 */
$('note-list').addEventListener('keydown', e => {
  const box = $('note-list');
  // 只纳入当前可见行：被折叠的笔记行 focus() 无效，会把焦点卡死（offsetParent 为 null 即隐藏）
  const rows = [...box.querySelectorAll('li[data-file], .folder-header')].filter(el => el.offsetParent !== null);
  if (!rows.length) return;
  const idx = rows.indexOf(document.activeElement);
  const go = i => {
    const t = rows[(i + rows.length) % rows.length];
    t.setAttribute('tabindex', '-1');
    t.focus();
  };
  const noteAt = () => {
    const t = rows[idx];
    const key = t && t.dataset.file;
    return key ? state.notes.find(x => noteKey(x) === key) || null : null;
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(idx < 0 ? 0 : idx + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(idx <= 0 ? rows.length - 1 : idx - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
  else if (e.key === 'Enter' && idx >= 0) {
    e.preventDefault();
    if (rows[idx].dataset.file) openNote(rows[idx].dataset.file);
    else rows[idx].click();
  }
  else if (e.key === 'F2' && idx >= 0) {
    const n = noteAt();
    if (n) { e.preventDefault(); startInlineRename(rows[idx], n); }
  }
  else if (e.key === 'Delete' && idx >= 0) {
    const n = noteAt();
    if (n) { e.preventDefault(); deleteNoteFlow(n); }
  }
  else if (e.key === ' ' && idx >= 0 && rows[idx].dataset.file) {
    // 空格切换多选，配合 Ctrl+A 全选做纯键盘批量移动
    e.preventDefault();
    toggleSelect(rows[idx].dataset.file);
    renderFilterBar();
    syncSelectionDom();
  }
  else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    state.selected = new Set(state.notes.map(noteKey));
    renderFilterBar();
    syncSelectionDom();
  }
  else if (e.key === 'Escape' && state.selected.size) {
    e.preventDefault();
    state.selected.clear();
    renderFilterBar();
    syncSelectionDom();
  }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && idx >= 0 && rows[idx].classList.contains('folder-header')) {
    e.preventDefault();
    const collapsed = rows[idx].classList.contains('collapsed');
    if ((e.key === 'ArrowRight' && collapsed) || (e.key === 'ArrowLeft' && !collapsed)) rows[idx].click();
  }
});

/* 二级菜单定位：默认贴右侧，空间不足翻到左侧 */
document.querySelector('#ctx-menu .dropdown-item.has-sub').addEventListener('mouseenter', e => {
  const sub = $('move-submenu');
  sub.classList.add('show');
  const r = e.currentTarget.getBoundingClientRect();
  const w = sub.offsetWidth, h = sub.offsetHeight;
  let left = r.right + 2;
  if (left + w > window.innerWidth - 4) left = Math.max(4, r.left - w - 2);
  const top = Math.max(4, Math.min(r.top, window.innerHeight - h - 4));
  sub.style.left = left + 'px';
  sub.style.top = top + 'px';
});

document.querySelectorAll('#ctx-menu > .ctx-group > .dropdown-item').forEach(el => {
  el.onclick = async () => {
    const act = el.dataset.act;
    // 移动到… 由二级菜单承接，本项只负责展开
    if (act === 'move-file') {
      const sub = $('move-submenu');
      sub.classList.toggle('show');
      return;
    }
    const fileName = ctxTarget;
    const folder = ctxFolder;
    hideCtxMenu();
    try {
      if (act === 'copy-file') {
        if (!fileName) return;
        await invoke('copy_note_file', { fileName });
        showToast('已复制文件，可在任意文件夹粘贴出副本');
        setStatus('已复制文件', 'ok');
      } else if (act === 'copy-path') {
        if (!fileName) return;
        const path = await invoke('copy_note_path', { fileName });
        showToast('已复制路径：' + path);
        setStatus('已复制路径', 'ok');
      } else if (act === 'reveal') {
        if (!fileName) return;
        await invoke('reveal_note', { fileName });
      } else if (act === 'delete-note') {
        const n = state.notes.find(x => noteKey(x) === fileName);
        if (n) await deleteNoteFlow(n);
      } else if (act === 'filter-folder') {
        state.folderFilter = folder || '';
        state.selected.clear();
        refreshList();
      } else if (act === 'new-in-folder') {
        newNoteInFolder(folder);
      } else if (act === 'rename-folder') {
        await renameFolderFlow(folder);
      } else if (act === 'delete-folder') {
        await deleteFolderFlow(folder);
      }
    } catch (e) {
      setStatus('操作失败：' + e, 'error');
    }
  };
});

async function moveNote(key, toFolder) {
  // 先落盘：否则移动后自动保存仍会按旧路径写回，看起来像复制/复活
  if (state.current && noteKey(state.current) === key && state.dirty) await doSave();
  try {
    const newKey = await invoke('move_note', { fileName: key, targetFolder: toFolder || '' });
    if (state.current && noteKey(state.current) === key) {
      // move_note 返回的是新相对路径字符串（不是 meta），只改路径字段，其余元数据保持
      state.current.file_name = newKey;
      state.current.folder = folderOfKey(newKey);
      LS.set('last_open', newKey);
      updateHeaderPath(state.current);
    }
    collapsedFolders.delete(toFolder || '');
    saveCollapsed();
    setStatus('已移动到「' + (toFolder || '根目录') + '」', 'ok');
  } catch (e) {
    setStatus('移动失败：' + e, 'error');
  }
  await refreshList();
}

/* 新建文件夹：列表顶部内联输入，Enter 提交、Esc 取消 */
function newFolderFlow() {
  const ul = $('note-list');
  if (ul.querySelector('.folder-new')) return;
  const li = document.createElement('li');
  li.className = 'folder-new';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '文件夹名称（仅一层，不支持 / 嵌套）';
  li.appendChild(input);
  ul.insertBefore(li, ul.firstChild);
  input.focus();
  let done = false;
  const finish = async ok => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    li.remove();
    if (!ok || !name) return;
    try {
      await invoke('create_folder', { name });
      setStatus('已创建文件夹「' + name + '」', 'ok');
    } catch (e) {
      // 后端只回"非法名称"，这里补上具体原因，用户才知道下一步怎么改
      const hint = /[/\\]/.test(name) ? '文件夹不支持嵌套，名称里不能有 / 或 \\'
        : /[:*?"<>|]/.test(name) ? '名称含 Windows 不允许的字符：: * ? " < > |'
        : String(e);
      setStatus('创建失败：' + hint, 'error');
    }
    await refreshList();
  };
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

/* 在指定文件夹下新建：先记目标文件夹，再走常规新建流程 */
function newNoteInFolder(folder) {
  state.activeFolder = folder || '';
  refreshList();
  newNote();
}

async function renameFolderFlow(oldName) {
  const name = await promptInline('重命名文件夹', oldName);
  if (!name || name === oldName) return;
  try {
    await invoke('rename_folder', { oldName, newName: name });
    if (state.activeFolder === oldName) state.activeFolder = name;
    // 筛选中的文件夹改名：筛选条件跟着换，否则列表会空掉
    if (state.folderFilter === oldName) state.folderFilter = name;
    // 正在编辑的笔记路径前缀必须跟着改，否则下次自动保存会按旧路径写回，
    // 把已改名的旧文件夹重新建出来（笔记分裂成新旧两份）。
    if (state.current && folderOfKey(state.current.file_name) === oldName) {
      state.current.file_name = name + '/' + baseNameOfKey(state.current.file_name);
      LS.set('last_open', state.current.file_name);
    }
    collapsedFolders.delete(oldName);
    saveCollapsed();
    setStatus('已重命名', 'ok');
  } catch (e) {
    setStatus('重命名失败：' + e, 'error');
  }
  await refreshList();
}

/* 删除文件夹：空文件夹直接删；非空先确认，把其中笔记移到根目录再删目录。
   绝不连带删笔记，原目录内容只是换位置。 */
async function deleteFolderFlow(name) {
  // 成员必须取全量：state.notes 在搜索态下只是命中子集，会漏掉未显示的笔记，
  // 导致"搬走几篇就报文件夹非空"的残局（后端按磁盘真实计数拒绝删除）。
  let all = state.notes;
  const q = $('search').value.trim();
  if (q) {
    try { all = await invoke('list_notes', { sort: LS.get('sort', 'modified') }); } catch { }
  }
  const members = all.filter(n => (n.folder || '') === name);
  let message = `确定删除文件夹「${name}」？`;
  if (members.length) {
    const ok = await invoke('confirm_dialog', {
      title: '确认删除文件夹',
      message: `「${name}」内还有 ${members.length} 篇笔记，将先移到根目录再删除文件夹。继续？`,
      okLabel: '继续',
      cancelLabel: '取消',
    });
    if (!ok) return;
    for (const n of members) {
      try {
        const meta = await invoke('move_note', { fileName: noteKey(n), targetFolder: '' });
        if (state.current && noteKey(state.current) === noteKey(n)) {
          state.current = meta;
          LS.set('last_open', noteKey(meta));
        }
      } catch (e) {
        setStatus('移出失败：' + e, 'error');
        await refreshList();
        return;
      }
    }
  } else {
    const ok = await invoke('confirm_dialog', {
      title: '确认删除文件夹',
      message,
      okLabel: '删除',
      cancelLabel: '取消',
    });
    if (!ok) return;
  }
  try {
    await invoke('delete_folder', { name });
    if (state.activeFolder === name) state.activeFolder = '';
    // 被删的文件夹若正是筛选目标，清掉筛选，否则列表会空白
    if (state.folderFilter === name) state.folderFilter = null;
    collapsedFolders.delete(name);
    saveCollapsed();
    setStatus('已删除文件夹', 'ok');
  } catch (e) {
    // 磁盘上可能还有非 .md 文件（图片等），前端统计不到，这里解释清楚
    const msg = String(e);
    const hint = msg.includes('非空') ? msg + '（可能有图片等非笔记文件，请在资源管理器里处理）' : msg;
    setStatus('删除失败：' + hint, 'error');
  }
  await refreshList();
}

/* 轻量文本输入弹窗：WebView2 无 window.prompt，复用 link-modal 的样式约定 */
function promptInline(title, initial) {
  return new Promise(resolve => {
    const modal = $('prompt-modal');
    modal.hidden = false;
    modal.querySelector('.link-modal-title').textContent = title;
    const input = $('prompt-input');
    input.value = initial || '';
    input.focus();
    input.select();
    const done = ok => {
      modal.hidden = true;
      $('prompt-ok').onclick = $('prompt-cancel').onclick = null;
      input.onkeydown = null;
      modal.onclick = null;
      document.removeEventListener('keydown', escHandler, true);
      resolve(ok ? input.value.trim() : '');
    };
    // Esc 挂在 document 捕获阶段：焦点 Tab 到按钮时也能关掉弹窗
    const escHandler = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', escHandler, true);
    modal.onclick = e => { if (e.target === modal) done(false); };
    $('prompt-ok').onclick = () => done(true);
    $('prompt-cancel').onclick = () => done(false);
    input.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    };
  });
}

/* 结构化筛选条：显示当前生效的标签/文件夹筛选与多选计数，可逐个清除 */
function renderFilterBar() {
  const bar = $('filter-bar');
  bar.textContent = '';
  const chips = [];
  state.tagFilter.forEach(t => chips.push({ label: '标签: ' + t, kind: 'tag', value: t }));
  if (state.folderFilter !== null) {
    chips.push({ label: '文件夹: ' + (state.folderFilter || '根目录'), kind: 'folder', value: state.folderFilter });
  }
  if (state.selected.size) {
    chips.push({ label: `已选 ${state.selected.size} 项`, kind: 'sel', value: '' });
  }
  if (!chips.length) { bar.hidden = true; return; }
  bar.hidden = false;
  for (const c of chips) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip' + (c.kind === 'sel' ? ' is-sel' : '');
    chip.textContent = c.label;
    if (c.kind === 'sel') {
      chip.title = '清空选择';
      chip.onclick = () => { state.selected.clear(); refreshList(); };
    } else {
      chip.title = '点击清除该筛选';
      chip.onclick = () => {
        if (c.kind === 'tag') state.tagFilter = state.tagFilter.filter(x => x !== c.value);
        else state.folderFilter = null;
        refreshList();
      };
    }
    bar.appendChild(chip);
  }
}

/* 标签栏：数据源是全量标签（list_tags），点击=结构化筛选（不再塞进搜索框）。 */
function renderTagBar() {
  const bar = $('tag-bar');
  bar.textContent = '';
  const active = new Set(state.tagFilter);
  const chip = (label, isActive, onClick, cls) => {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '') + (isActive ? ' is-active' : '');
    s.textContent = label;
    s.onclick = onClick;
    return s;
  };
  if (state.tagFilter.length || state.folderFilter !== null || $('search').value.trim()) {
    bar.appendChild(chip('清除筛选', false, () => {
      state.tagFilter = []; state.folderFilter = null; $('search').value = ''; refreshList();
    }, 'tag-clear'));
  }
  for (const t of state.allTags) {
    const c = chip(t, active.has(t), () => {
      state.tagFilter = active.has(t)
        ? state.tagFilter.filter(x => x !== t)
        : [...state.tagFilter, t];
      refreshList();
    });
    // 右键标签：重命名（批量改写所有笔记）/ 删除（从所有笔记移除该标签）
    c.oncontextmenu = e => { e.preventDefault(); showTagMenu(e.clientX, e.clientY, t); };
    bar.appendChild(c);
  }
  if (!state.allTags.length && !bar.childNodes.length) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
  }
}

/* 标签右键菜单：重命名（批量改写全部笔记的 frontmatter）/ 删除（从所有笔记移除）。 */
let tagMenuTarget = null;
function showTagMenu(x, y, tag) {
  tagMenuTarget = tag;
  const m = $('tag-menu');
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
}
function hideTagMenu() { $('tag-menu').hidden = true; }
document.querySelectorAll('#tag-menu .dropdown-item').forEach(el => {
  el.onclick = async () => {
    const act = el.dataset.tagAct;
    const tag = tagMenuTarget;
    hideTagMenu();
    if (!tag) return;
    if (act === 'rename') {
      const to = await promptInline('重命名标签（留空则删除该标签）', tag);
      if (to === tag) return;
      try {
        const n = await invoke('rename_tag', { from: tag, to: to || '' });
        state.tagFilter = state.tagFilter.map(t => (t === tag ? (to || '') : t)).filter(Boolean);
        setStatus(`已更新 ${n} 篇笔记的标签`, 'ok');
      } catch (e) { setStatus('重命名标签失败：' + e, 'error'); }
    } else if (act === 'delete') {
      try {
        const n = await invoke('rename_tag', { from: tag, to: '' });
        state.tagFilter = state.tagFilter.filter(t => t !== tag);
        setStatus(`已从 ${n} 篇笔记移除标签「${tag}」`, 'ok');
      } catch (e) { setStatus('删除标签失败：' + e, 'error'); }
    }
    refreshList();
  };
});
document.addEventListener('click', e => { if (!e.target.closest('#tag-menu')) hideTagMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTagMenu(); });

/* 顶栏显示当前笔记相对路径，点击在资源管理器中定位。未落盘的新笔记隐藏。 */
function updateHeaderPath(note) {
  const el = $('header-path');
  if (!note || !note.file_name) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = note.file_name;
  el.onclick = async () => {
    try { await invoke('reveal_note', { fileName: note.file_name }); }
    catch (e) { setStatus('定位失败：' + e, 'error'); }
  };
}

/* 首次运行引导：写进 localStorage，写完第一篇（或手动关掉）后不再出现 */
function maybeShowFirstRun() {
  if (LS.get('first_run', '')) return;
  const tip = document.createElement('div');
  tip.className = 'first-run';
  tip.innerHTML = '<div class="first-run-card">' +
    '<div class="first-run-title">欢迎使用 MarkVault</div>' +
    '<ol class="first-run-steps">' +
    '<li>点左上角「＋ 新建」创建第一篇笔记</li>' +
    '<li>直接打字，内容会自动保存到笔记库</li>' +
    '<li>用左栏的文件夹按钮给笔记分类，右键笔记可复制 / 移动</li>' +
    '</ol>' +
    '<button type="button" class="first-run-ok primary">知道了</button>' +
    '</div>';
  tip.querySelector('.first-run-ok').onclick = () => {
    LS.set('first_run', '1');
    tip.remove();
  };
  document.body.appendChild(tip);
}

/* 预览空态：让新用户知道这块区域是干什么的。
   写成覆盖层（.preview-empty-layer）而不是覆盖 #preview 内容，
   否则导出 HTML/PNG 会把这句引导文案一起带走。 */
function renderPreviewEmptyState(show) {
  const pane = $('preview').parentElement || $('preview');
  let layer = pane.querySelector('.preview-empty-layer');
  if (show) {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'preview-empty-layer';
      layer.innerHTML = '<div class="preview-empty-title">预览会显示在这里</div>' +
        '<div class="preview-empty-hint">在左侧写 Markdown，例如用 # 写标题、**加粗**、- 列清单</div>';
      pane.appendChild(layer);
    }
    layer.hidden = false;
  } else if (layer) {
    layer.hidden = true;
  }
}

/* ---------- 打开/新建 ---------- */
async function openNote(fileName) {
  if (state.current && state.current.file_name === fileName && !state.dirty) return;
  if (state.dirty) await doSave();
  let note;
  try {
    note = await invoke('read_note', { fileName });
  } catch (e) {
    setStatus('读取失败：' + e, 'error');
    return;
  }
  state.current = note;
  $('title-input').value = note.title;
  $('doc-title').value = note.title;
  $('tags-input').value = (note.tags || []).join(', ');
  $('editor').value = note.content;
  renderHighlight();
  render(note.content);
  updateHeaderPath(note);
  state.dirty = false;
  LS.set('last_open', fileName);
  document.title = (note.title === '无标题' ? '未命名文档' : note.title) + ' - MarkVault';
  // 保存失败的错误态优先级高于"就绪"，不能被打开笔记的动作抹掉
  if (saveError) setStatus(saveError, 'error'); else setStatus('就绪');
  refreshList();
}

async function newNote() {
  if (state.dirty) await doSave();
  state.current = { file_name: '' };
  $('title-input').value = '';
  $('doc-title').value = '';
  $('tags-input').value = '';
  $('editor').value = '';
  $('header-path').hidden = true;
  $('header-path').textContent = '';
  renderHighlight();
  render('');
  state.dirty = false;
  document.title = '未命名文档 - MarkVault';
  // 明确告知新笔记会落到哪，避免用户以为"点了新建却什么都没发生"；
  // 左栏同时插入占位条，让"已创建"立刻可见。
  const where = state.folderFilter !== null
    ? (state.folderFilter || '根目录')
    : (state.activeFolder || '根目录');
  await refreshList();
  setStatus('新笔记将保存到「' + where + '」，输入即自动保存', 'ok');
  $('doc-title').focus();
}

/* ---------- 视图模式 ---------- */
function setLayout(mode) {
  state.layout = mode;
  LS.set('layout', mode);
  const shell = $('main-shell');
  shell.classList.remove('layout-both', 'layout-edit', 'layout-preview');
  shell.classList.add('layout-' + mode);
  document.querySelectorAll('#view-menu-row .dropdown-item, #view-menu-prow .dropdown-item').forEach(el => {
    el.style.color = el.dataset.view === mode ? 'var(--accent)' : '';
    el.style.fontWeight = el.dataset.view === mode ? '600' : '';
  });
}

/* ---------- 分隔条拖动 ---------- */
(function initResizer() {
  const resizer = $('resizer');
  const main = $('main-shell');
  let dragging = false;
  const saved = parseFloat(LS.get('editorWidth', ''));
  const applyWidth = w => { main.querySelector('.editor-block').style.flex = `0 0 ${w}px`; };
  // 恢复上次宽度：受窗口宽度约束，避免从小窗口拖出的窄宽在大窗口上原样还原
  if (saved > 0) {
    const rect = main.getBoundingClientRect();
    if (rect.width) applyWidth(Math.min(Math.max(saved, 240), rect.width - 320));
  }
  resizer.addEventListener('mousedown', e => { dragging = true; resizer.classList.add('dragging'); document.body.classList.add('resizing'); e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const w = Math.min(Math.max(e.clientX - rect.left, 240), rect.width - 320);
    applyWidth(w);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    // 记住宽度：刷新/重开后保持布局
    const w = main.querySelector('.editor-block').getBoundingClientRect().width;
    if (w) LS.set('editorWidth', String(Math.round(w)));
  });
})();

/* ---------- 下拉菜单 ---------- */
function closeAllMenus(except) {
  document.querySelectorAll('.dropdown-menu.show').forEach(m => {
    if (m !== except) m.classList.remove('show');
  });
}
/* 菜单项键盘导航：菜单是 div 列表，无原生焦点，靠 roving tabindex 接管。
   打开后聚焦首项，方向键循环、Enter/Space 触发、Esc 关闭并把焦点还给触发按钮。 */
function initMenuNav(menu, btn) {
  const items = () => [...menu.querySelectorAll('.dropdown-item')].filter(el => el.offsetParent !== null);
  menu.addEventListener('keydown', e => {
    const list = items();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[n].focus();
    } else if (e.key === 'Home') {
      e.preventDefault(); list[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault(); list[list.length - 1].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (i >= 0) list[i].click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAllMenus();
      btn.focus();
    }
  });
}
function bindMenu(btnId, menuId) {
  const menu = $(menuId);
  const btn = $(btnId);
  menu.querySelectorAll('.dropdown-item').forEach(el => { el.tabIndex = -1; });
  initMenuNav(menu, btn);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const m = menu;
    const show = !m.classList.contains('show');
    closeAllMenus();
    m.classList.toggle('show', show);
    // 工具栏/标签行容器有 overflow:hidden 或换行裁剪，统一用 fixed 定位到按钮正下方，避免被遮盖
    if (show && m.closest('.editor-toolbar, .title-row-actions, .preview-toolbar, .format-group-track')) {
      const r = btn.getBoundingClientRect();
      m.style.position = 'fixed';
      m.style.top = `${r.bottom + 6}px`;
      m.style.right = 'auto';
      m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
    } else {
      m.style.position = '';
      m.style.top = '';
      m.style.left = '';
      m.style.right = '';
    }
    if (show) {
      const first = [...m.querySelectorAll('.dropdown-item')].find(el => el.offsetParent !== null);
      if (first) first.focus();
    }
  });
  // 键盘方向键也可能在按钮上按下，直接开菜单并交焦点给首项
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && !menu.classList.contains('show')) {
      e.preventDefault(); btn.click();
    }
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown')) closeAllMenus();
});
window.addEventListener('resize', closeAllMenus);
window.addEventListener('scroll', closeAllMenus, true);

/* ---------- 编辑器格式操作（对齐 MarkPane 语义，execCommand 保撤销栈） ---------- */
function applyEdit(start, end, ins, selStart, selEnd) {
  // 用 insertText 走浏览器原生编辑栈，撤销/重做保持可用；input 事件由 execCommand 原生触发
  const ta = $('editor');
  ta.focus();
  ta.setSelectionRange(start, end);
  document.execCommand('insertText', false, ins);
  if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd);
}

/* 包裹式行内格式：空选区/纯定界符选区时插入占位文字；插入后整个包裹内容保持选中（同 MarkPane 'select'） */
function wrapSel(before, after, placeholder, rejectPattern) {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  let sel = v.slice(s, e);
  if ((!sel || (rejectPattern && rejectPattern.test(sel))) && placeholder) sel = placeholder;
  const all = before.length + sel.length + after.length;
  applyEdit(s, e, before + sel + after, s, s + all);
}

/* 行内格式开关（非对称定界符 <u>…</u>）：已包住/紧邻/同行内包围时剥掉一层，否则返回 false */
function toggleAsymmetricInline(open, close) {
  const ta = $('editor');
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  // 两侧紧邻：<u>|xx|</u>
  if (s >= open.length && e + close.length <= v.length &&
      v.slice(s - open.length, s) === open && v.slice(e, e + close.length) === close) {
    const inner = v.slice(s, e);
    applyEdit(s - open.length, e + close.length, inner, s - open.length, s - open.length + inner.length);
    return true;
  }
  // 选区整体含标记：<u>xx</u>
  const sel = v.slice(s, e);
  if (sel.startsWith(open) && sel.endsWith(close) && sel.length >= open.length + close.length) {
    const inner = sel.slice(open.length, sel.length - close.length);
    applyEdit(s, e, inner, s, s + inner.length);
    return true;
  }
  // 光标/选区在标记对内部（同行）：向两侧找最近的 open/close
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', s);
  if (lineEnd === -1) lineEnd = v.length;
  if (s >= lineStart && e <= lineEnd) {
    const before = v.slice(lineStart, s), after = v.slice(e, lineEnd);
    const oAt = before.lastIndexOf(open);
    const cAt = after.indexOf(close);
    if (oAt !== -1 && cAt !== -1) {
      const oS = lineStart + oAt, cE = e + cAt + close.length;
      const inner = v.slice(oS + open.length, cE - close.length);
      applyEdit(oS, cE, inner, oS, oS + inner.length);
      return true;
    }
  }
  return false;
}

/* 将行内 `code` 区域替换为同长空格，避免把代码里的 ** 当成定界符 */
function maskInlineCode(line) {
  let out = '', i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { out += line[i]; i++; continue; }
    let j = i + 1;
    while (j < line.length && line[j] === '`') j++;
    const ticks = j - i;
    const closeAt = line.indexOf('`'.repeat(ticks), j);
    if (closeAt === -1) { out += line[i]; i++; continue; }
    const end = closeAt + ticks;
    out += ' '.repeat(end - i);
    i = end;
  }
  return out;
}

/* 同行内找包围选区的一对定界符（跳过行内 code，`**` 非重叠扫描） */
function findEnclosingDelimPair(line, selStart, selEnd, delim) {
  const len = delim.length;
  const masked = maskInlineCode(line);
  const positions = [];
  for (let i = 0; i <= masked.length - len; i++) {
    if (masked.slice(i, i + len) === delim) { positions.push(i); i += len - 1; }
  }
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i], close = positions[i + 1], closeEnd = close + len;
    if (selStart >= open && selEnd <= closeEnd) {
      return { open, contentStart: open + len, contentEnd: close, closeEnd };
    }
  }
  return null;
}

/* 取消行内定界标记：已包住选区 / 紧邻选区外侧 / 同行内包围选区时剥掉一层 */
function resolveDelimUnwrapRange(text, start, end, delim) {
  const len = delim.length;
  if (len < 1) return null;
  if (end - start >= len * 2) {
    const selected = text.slice(start, end);
    if (selected.startsWith(delim) && selected.endsWith(delim) && !selected.includes('\n')) {
      return { oS: start, oE: end, cS: start + len, cE: end - len };
    }
  }
  if (start >= len && end + len <= text.length) {
    if (text.slice(start - len, start) === delim && text.slice(end, end + len) === delim && !text.slice(start, end).includes('\n')) {
      return { oS: start - len, oE: end + len, cS: start, cE: end };
    }
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = text.length;
  if (start < lineStart || end > lineEnd) return null;
  const line = text.slice(lineStart, lineEnd);
  const pair = findEnclosingDelimPair(line, start - lineStart, end - lineStart, delim);
  if (!pair) return null;
  return { oS: lineStart + pair.open, oE: lineStart + pair.closeEnd, cS: lineStart + pair.contentStart, cE: lineStart + pair.contentEnd };
}

function toggleDelimitedInline(delims) {
  const ta = $('editor');
  const text = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
  const sel = text.slice(start, end);
  for (const d of delims) {
    const r = resolveDelimUnwrapRange(text, start, end, d);
    if (!r) continue;
    const inner = text.slice(r.cS, r.cE);
    applyEdit(r.oS, r.oE, inner, r.oS, r.oS + inner.length);
    return true;
  }
  // 跨行选区补充分支（MarkPane 未覆盖；缺了会把 **x\ny** 叠包成 ****）
  for (const d of delims) {
    const len = d.length;
    if (sel.startsWith(d) && sel.endsWith(d) && sel.length >= len * 2) {
      const inner = sel.slice(len, -len);
      applyEdit(start, end, inner, start, start + inner.length);
      return true;
    }
    if (start >= len && end + len <= text.length &&
        text.slice(start - len, start) === d && text.slice(end, end + len) === d) {
      const inner = text.slice(start, end);
      applyEdit(start - len, end + len, inner, start - len, start - len + inner.length);
      return true;
    }
  }
  return false;
}

/* 加粗：已加粗则剥掉一层，否则包裹（支持 ** 与 __；纯定界符选拒绝防 ******） */
function formatBold() {
  if (!toggleDelimitedInline(['**', '__'])) wrapSel('**', '**', '加粗', /^\*+$|^_+$/);
}
function formatItalic() {
  if (!toggleDelimitedInline(['*'])) wrapSel('*', '*', '斜体', null);
}
function formatUnderline() {
  if (!toggleAsymmetricInline('<u>', '</u>')) wrapSel('<u>', '</u>', '下划线', null);
}
function formatStrike() {
  if (!toggleDelimitedInline(['~~'])) wrapSel('~~', '~~', '删除线', /^~+$/);
}
function formatInlineCode() {
  wrapSel('`', '`', '代码', /^`+$/);
}

/* 引用：对选中文字逐行加 '> '，无选区时插入占位（与 MarkPane formatQuote 一致） */
function formatQuote() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const sel = v.slice(s, e) || '引用';
  const out = '> ' + sel.replace(/\n/g, '\n> ');
  applyEdit(s, e, out, s, s + out.length);
}

/* 列表：stripListMarker + applyListPrefix 与 MarkPane 一致；有序列表自动重编号。
   空行/空选区时整行替换为 3 个占位项（MarkPane 语义：占位文字'列表项'） */
function stripListMarker(line, mode) {
  if (mode === 'task') return line.replace(/^[-*+]\s+\[[ xX]\]\s+/, '').replace(/^\d+\.\s+/, '').replace(/^[-*+]\s+/, '');
  if (mode === 'ordered') return line.replace(/^\d+\.\s+/, '');
  return line.replace(/^[-*+]\s+/, '');
}
function applyListPrefix(lines, mode, checkFirst) {
  let order = 1;
  return lines.map((line, index) => {
    if (!line.trim()) return line;
    const content = stripListMarker(line, mode);
    if (mode === 'ordered') return (order++) + '. ' + content;
    if (mode === 'task') return (checkFirst && index === 0 ? '- [x] ' : '- [ ] ') + content;
    return '- ' + content;
  }).join('\n');
}
function prefixLines(mode) {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const hasSel = s !== e;
  let rs, re, content, checkFirst = false;
  if (hasSel) {
    rs = s; re = e; content = v.slice(s, e);
  } else {
    rs = v.lastIndexOf('\n', s - 1) + 1;
    const lineEndIdx = v.indexOf('\n', s);
    re = lineEndIdx === -1 ? v.length : lineEndIdx;
    const cur = v.slice(rs, re);
    if (cur.trim()) {
      content = cur;
    } else {
      // 空行：占位文字 '列表项 1/2/3'（任务列表首项勾选，与 MarkPane 一致）
      content = ['列表项 1', '列表项 2', '列表项 3'].join('\n');
      checkFirst = mode === 'task';
    }
  }
  // 过滤纯空白行（与 MarkPane prefixLines 的 filter 行为一致仅用于圆形列表；此处保留空行占位）
  const out = applyListPrefix(content.split('\n'), mode, checkFirst);
  applyEdit(rs, re, out, rs + out.length, rs + out.length);
}

/* 圆形序号有序列表（对齐 MarkPane formatOrderedCircleList）：
   输出 <ol class="ol-circle"> HTML；无选区且当前行为空时插入 3 个占位项 */
function formatOrderedCircleList() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const hasSel = s !== e;
  let rs, re, content;
  if (hasSel) {
    rs = s; re = e; content = v.slice(s, e);
  } else {
    rs = v.lastIndexOf('\n', s - 1) + 1;
    const lineEndIdx = v.indexOf('\n', s);
    re = lineEndIdx === -1 ? v.length : lineEndIdx;
    const cur = v.slice(rs, re);
    if (cur.trim()) content = cur;
    else content = ['列表项 1', '列表项 2', '列表项 3'].join('\n');
  }
  const lines = content.split('\n').filter(l => l.trim());
  const items = (lines.length ? lines : ['列表项 1']).map(line => {
    let body = stripListMarker(line, 'task');
    body = stripListMarker(body, 'ordered');
    body = stripListMarker(body, 'unordered');
    return '  <li>' + esc(body.trim()) + '</li>';
  });
  const html = '<ol class="ol-circle">\n' + items.join('\n') + '\n</ol>\n';
  applyEdit(rs, re, html, rs, rs);
}

/* 标题：替换当前行已有的 # 前缀后应用目标级别 */
function insertHeading(level) {
  const ta = $('editor');
  const s = ta.selectionStart, v = ta.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = v.length;
  const cur = v.slice(lineStart, lineEnd);
  const out = '#'.repeat(level) + ' ' + cur.replace(/^#{0,6}\s*/, '');
  applyEdit(lineStart, lineEnd, out, lineStart + out.length, lineStart + out.length);
}

/* 代码块：选中内容包进 ``` 围栏，无选区时用占位，插入后全选 */
function insertCodeBlock() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  let sel = v.slice(s, e);
  if (!sel || /^`+$/.test(sel)) sel = '代码';
  const ins = '```\n' + sel + '\n```';
  applyEdit(s, e, ins, s, s + ins.length);
}

/* 链接：Tauri WebView2 不支持 prompt()，用内置弹窗输入 URL */
function insertLink() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || '链接';
  openLinkPrompt(url => {
    if (!url) { $('editor').focus(); return; }
    const ins = '[' + sel + '](' + url + ')';
    applyEdit(s, e, ins, s + ins.length, s + ins.length);
  });
}

function openLinkPrompt(cb) {
  const modal = $('link-modal');
  const input = $('link-url');
  modal.hidden = false;
  input.value = 'https://';
  input.focus();
  input.select();
  const escHandler = e => {
    if (e.key === 'Escape') { e.stopPropagation(); done(false); }
  };
  const done = ok => {
    modal.hidden = true;
    const url = ok ? input.value.trim() : '';
    $('link-ok').onclick = $('link-cancel').onclick = null;
    input.onkeydown = null;
    // 与添加时的 capture 标志一致，否则移除失败、监听器泄漏
    document.removeEventListener('keydown', escHandler, true);
    modal.onclick = null;
    cb(url);
  };
  document.addEventListener('keydown', escHandler, true);
  modal.onclick = e => { if (e.target === modal) done(false); };
  $('link-ok').onclick = () => done(true);
  $('link-cancel').onclick = () => done(false);
  input.onkeydown = e => {
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  };
}

/* 表格：弹出行×列，生成对齐好的 Markdown 管道表骨架，插到光标处 */
function insertTable() {
  promptInline('插入表格（行 x 列，如 3x4）', '3x3').then(spec => {
    if (!spec) { $('editor').focus(); return; }
    const m = spec.match(/^\s*(\d+)\s*[x×X*,\s]\s*(\d+)\s*$/);
    if (!m) { setStatus('表格格式无效，请填「行x列」，如 3x3', 'error'); $('editor').focus(); return; }
    const rows = Math.max(1, Math.min(30, +m[1]));
    const cols = Math.max(1, Math.min(12, +m[2]));
    const head = '| ' + Array.from({ length: cols }, (_, i) => '列' + (i + 1)).join(' | ') + ' |';
    const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
    const body = Array.from({ length: Math.max(0, rows - 1) }, () =>
      '| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |');
    const table = [head, sep, ...body].join('\n');
    const ta = $('editor');
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const before = v.slice(0, s);
    const lead = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
    const after = v.slice(e);
    const trail = after.length === 0 || after.startsWith('\n') ? '\n' : '\n\n';
    applyEdit(s, e, lead + table + trail, s + lead.length + 2, s + lead.length + 2);
  });
}

/* 插入图片：Tauri WebView2 无原生图片选择，走文件对话框选一个本地图片，
   复制进库内 .assets/ 后插入相对路径引用。 */
function insertImage() { pickAndSaveImage(true); }

/* 图片约束：与后端 MAX_IMAGE_BYTES 一致，前端先挡住再发，提示文案保持一致 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT_HINT = '仅支持JPG、PNG、JPEG格式的图片';
const IMAGE_SIZE_HINT = '图片大小不能超过10M';
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];

async function pickAndSaveImage(insert) {
  try {
    const picked = await invoke('pick_image');
    if (!picked) { $('editor').focus(); return null; }
    const rel = await invoke('save_asset', { dataBase64: picked.data, ext: picked.ext });
    if (insert) {
      const ta = $('editor');
      const s = ta.selectionStart, e = ta.selectionEnd;
      const ins = `![图片](${rel})`;
      applyEdit(s, e, ins, s + ins.length, s + ins.length);
      setStatus('已插入图片', 'ok');
    }
    return rel;
  } catch (err) {
    // 后端的格式/大小提示原样透出，不加前缀
    const msg = String(err);
    if (msg.includes('格式') || msg.includes('10M')) setStatus(msg, 'error');
    else setStatus('插入图片失败：' + msg, 'error');
    return null;
  }
}

/* 大图 base64：逐块转字符串再拼，避免一次性 apply 超长参数导致调用栈溢出 */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* 粘贴图片：从剪贴板取 Blob，校验格式与大小后落进 .assets/ 并插入引用 */
async function handleImagePaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return false;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      // 格式白名单：只放行 png / jpg(jpeg)
      if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
        setStatus(IMAGE_EXT_HINT, 'error');
        return true;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setStatus(IMAGE_SIZE_HINT, 'error');
        return true;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const ext = file.type.toLowerCase().includes('png') ? 'png' : 'jpg';
        const rel = await invoke('save_asset', { dataBase64: bytesToBase64(bytes), ext });
        const ta = $('editor');
        const s = ta.selectionStart, e2 = ta.selectionEnd;
        const ins = `![图片](${rel})`;
        applyEdit(s, e2, ins, s + ins.length, s + ins.length);
        setStatus('已粘贴图片到 ' + rel, 'ok');
      } catch (err) {
        const msg = String(err);
        if (msg.includes('格式') || msg.includes('10M')) setStatus(msg, 'error');
        else setStatus('粘贴图片失败：' + msg, 'error');
      }
      return true;
    }
  }
  return false;
}

/* 水平线：前后不足两个空行时自动补齐 */
function insertHorizontalRule() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const before = v.slice(0, s), after = v.slice(e);
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  const trail = after.length === 0 || after.startsWith('\n\n') ? '' : (after.startsWith('\n') ? '\n' : '\n\n');
  applyEdit(s, e, lead + '---' + trail, s + lead.length + 3, s + lead.length + 3);
}

/* 标签徽章：<badges tone="x">文字</badges>，预览渲染为彩色圆角胶囊 */
function insertTag(tone) {
  const allowed = { accent: 1, green: 1, yellow: 1, dark: 1 };
  const safe = allowed[tone] ? tone : 'accent';
  wrapSel('<badges tone="' + safe + '">', '</badges>', '标签');
}

/* 预览扩展渲染：任务列表样式 + badges 胶囊 + 下划线（marked 支持内嵌 HTML，先转译再净化） */
function enhancePreviewHtml() {
  const p = $('preview');
  p.querySelectorAll('u').forEach(el => el.classList.add('md-u'));
  // 任务列表：li.task-item + ul.task-list，复选框可点击回写源码
  p.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const li = cb.closest('li');
    if (!li) return;
    li.classList.add('task-item');
    const ul = li.closest('ul');
    if (ul) ul.classList.add('task-list');
    cb.setAttribute('contenteditable', 'false');
    // marked 渲染的复选框带 disabled，disabled 元素不触发 change，必须移除才能点击勾选
    cb.disabled = false;
    cb.addEventListener('change', () => toggleTaskItem(li, cb));
  });
  p.querySelectorAll('ol.ol-circle').forEach(ol => ol.classList.add('ol-circle'));
  p.querySelectorAll('badges').forEach(el => {
    const tone = (el.getAttribute('tone') || 'accent').toLowerCase();
    const span = document.createElement('span');
    span.className = 'badge tone-' + tone;
    span.textContent = el.textContent;
    el.replaceWith(span);
  });
  enhanceImages(p);
}

/* 预览里的库内图片：src 是相对路径（.assets/xx.png），WebView2 里 file:// 加载不到，
   统一换成 data URL。每次渲染后补一次，缓存已解析过的路径避免重复读盘。 */
const assetCache = new Map();
function enhanceImages(root) {
  root.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (!/^\.?assets\//.test(src) && !src.startsWith('.assets/')) return;
    const rel = src.replace(/^\.\//, '');
    if (assetCache.has(rel)) { img.src = assetCache.get(rel); return; }
    img.dataset.pending = rel;
    invoke('read_asset', { rel }).then(url => {
      assetCache.set(rel, url);
      // 渲染可能已被后续渲染替换掉，只有还挂在文档里的 img 才回填
      if (img.isConnected && img.dataset.pending === rel) img.src = url;
    }).catch(() => {
      img.alt = (img.alt || '') + '（图片未找到）';
    });
  });
}

/* 预览复选框点击 → 找到源码中对应列表行，回写 [x]/[ ] */
function toggleTaskItem(li, cb) {
  const ta = $('editor');
  const lines = ta.value.split('\n');
  // 与预览 DOM 对齐：仅统计顶层任务 li 的出现顺序
  const items = [];
  $('preview').querySelectorAll('li.task-item').forEach(el => {
    const c = el.querySelector('input[type="checkbox"]');
    if (c) items.push({ el, checked: c.checked });
  });
  const idx = items.findIndex(it => it.el === li);
  if (idx === -1) return;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/);
    if (!m) continue;
    if (seen === idx) {
      lines[i] = m[1] + (cb.checked ? 'x' : ' ') + m[3];
      const pos = lines.slice(0, i).join('\n').length + (i ? 1 : 0) + m[1].length;
      applyEdit(0, ta.value.length, lines.join('\n'), pos, pos);
      return;
    }
    seen++;
  }
}

/* 输入路径拆两级调度：高亮合并到动画帧，预览解析（marked + DOMPurify + 大纲 + 字数）
   较重，加短防抖。都不再每个按键同步全量重渲染，长文输入才不卡。 */
let previewTimer = null, hlRaf = 0;
function onEditorInput() {
  if (!hlRaf) {
    hlRaf = requestAnimationFrame(() => { hlRaf = 0; renderHighlight(); });
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => render($('editor').value), 120);
  scheduleAutosave();
}

/* ---------- 导出 ---------- */
async function exportNote(format) {
  if (!state.current) { setStatus('没有可导出的笔记'); return; }
  await doSave();
  // 保存失败时 file_name 仍为空（从未落盘），导出无从谈起
  if (!state.current.file_name) { setStatus('笔记未保存，导出取消', 'error'); return; }
  const fileName = state.current.file_name;
  // PDF 由 Rust 端 WebView2 原生渲染（无页眉页脚），前端不传内容
  let payload = '';
  if (format === 'html') {
    payload = buildStandaloneHtml();
  } else if (format === 'docx') {
    payload = buildDocxPayload($('editor').value);
  } else if (format === 'md') {
    payload = $('editor').value;
  } else if (format === 'png') {
    try {
      payload = await capturePng();
    } catch (e) {
      setStatus('生成图片失败：' + e, 'error');
      return;
    }
    if (!payload) { setStatus('生成图片失败', 'error'); return; }
  }
  try {
    const path = await invoke('export_note', { fileName, format, payload, title: state.current.title || '' });
    showToast('已导出到 ' + path, { label: '打开所在文件夹', onClick: () => invoke('reveal_path', { path: path.replace(/[\\/][^\\/]*$/, '') }) });
  } catch (e) {
    if (e === '已取消') return;
    setStatus('导出失败：' + e, 'error');
  }
}

/* 轻量 toast：右下角浮层，带一个可选动作按钮。用于导出/复制这类"一闪就没"的反馈。 */
let toastTimer = null;
function showToast(text, action) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = '';
  const span = document.createElement('span');
  span.className = 'toast-text';
  span.textContent = text;
  span.title = text;
  el.appendChild(span);
  if (action) {
    const a = document.createElement('button');
    a.className = 'toast-action';
    a.textContent = action.label;
    a.onclick = () => { action.onClick(); el.classList.remove('show'); };
    el.appendChild(a);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

/* DOCX 载荷：把 Markdown 逐行解析成结构化段落（heading / paragraph / list / code / quote），
   Rust 端据此生成真正的 OOXML，而不是把 HTML 改个扩展名。 */
function buildDocxPayload(md) {
  const out = [];
  const lines = (md || '').split('\n');
  let inFence = false, buf = [];
  const flushCode = () => {
    if (buf.length) { out.push({ block: 'code', text: buf.join('\n') }); buf = []; }
  };
  const headings = parseHeadings(md || '');
  const headingLines = new Map(headings.map(h => [h.line, h]));
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; if (!inFence) flushCode(); continue; }
    if (inFence) { buf.push(raw); continue; }
    const h = headingLines.get(i);
    if (h) { out.push({ block: 'heading', level: h.level, text: h.text }); continue; }
    // setext 标题的下划线行（=== / ---）已被并入标题，跳过它本身
    if (/^\s*(=+|-+)\s*$/.test(raw) && i > 0 && lines[i - 1].trim()) continue;
    const t = raw.trim();
    // 空行不入段：每个 block 本身就是独立段落，保留空段落只会让 Word 里多出空行
    if (!t) continue;
    let m;
    if ((m = t.match(/^>\s?(.*)$/))) { out.push({ block: 'quote', text: m[1] }); continue; }
    if ((m = t.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/))) {
      // 有序列表保留序号，无序统一用项目符号（docx 里由 Rust 端渲染）
      const ordered = /^\s*\d+\./.test(t);
      out.push({ block: 'list', text: ordered ? t : m[1] });
      continue;
    }
    out.push({ block: 'paragraph', text: t.replace(/[*_`]/g, '') });
  }
  flushCode();
  return JSON.stringify(out);
}

function buildStandaloneHtml() {  const body = $('preview').innerHTML;
  const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(state.current.title || '')}</title><style>body{max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.8;color:#1a1d23;} pre{background:#1a1d27;color:#d7dbea;padding:16px;border-radius:10px;} code{background:rgba(163,21,21,.08);padding:2px 5px;border-radius:4px;} pre code{background:transparent;padding:0;} blockquote{border-left:4px solid #6C5CE7;background:rgba(108,92,231,.07);margin:12px 0;padding:12px 16px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px 12px;} th{background:#f3f5f8;} img{max-width:100%;} h1{font-size:2em;} h2{border-bottom:1px solid #eee;padding-bottom:6px;} ul.task-list{list-style:none;padding-left:.4em;} li.task-item{list-style:none;} li.task-item input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:15px;height:15px;border:1.5px solid #9a948c;border-radius:4px;vertical-align:-2px;margin-right:6px;position:relative;} li.task-item input[type="checkbox"]:checked{background:#6C5CE7;border-color:#6C5CE7;} li.task-item input[type="checkbox"]:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);} ol.ol-circle{list-style:none;counter-reset:ol-circle;padding-left:0;} ol.ol-circle>li{counter-increment:ol-circle;position:relative;padding-left:30px;margin:6px 0;} ol.ol-circle>li::before{content:counter(ol-circle);position:absolute;left:0;top:.2em;width:20px;height:20px;border-radius:50%;background:#6C5CE7;color:#fff;font-size:12px;display:inline-flex;align-items:center;justify-content:center;} .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;} .badge.tone-accent{background:rgba(108,92,231,.12);color:#6C5CE7;} .badge.tone-green{background:rgba(46,184,114,.14);color:#1f9d63;} .badge.tone-yellow{background:rgba(240,180,40,.16);color:#b07d10;} .badge.tone-dark{background:rgba(30,34,44,.88);color:#fff;} u{text-decoration:underline;text-underline-offset:3px;}</style></head><body>${body}</body></html>`;
}

/* 导出 PNG：预览区是 flex 定高的滚动容器，直接截图只会拿到可见一屏。
   把内容克隆到离屏容器里、解除高度与溢出约束，按真实内容尺寸截图。 */
async function capturePng() {
  const src = $('preview');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + src.clientWidth + 'px;background:var(--panel-bg);';
  const clone = src.cloneNode(true);
  clone.style.cssText = 'height:auto;max-height:none;overflow:visible;';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    const w = Math.max(holder.scrollWidth, src.clientWidth);
    const h = Math.max(holder.scrollHeight, 1);
    const dataUrl = await domtoimage.toPng(clone, {
      width: w,
      height: h,
      bgcolor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      style: { overflow: 'visible' },
    });
    if (!dataUrl || dataUrl.indexOf(',') === -1) return null;
    return dataUrl.split(',')[1];
  } finally {
    holder.remove();
  }
}

/* ---------- 主题 ---------- */
function applyTheme(t) {
  document.body.dataset.theme = t;
  LS.set('theme', t);
}

/* ---------- 事件绑定 ---------- */
$('editor').addEventListener('input', onEditorInput);
// 粘贴截图：交给 handleImagePaste 处理，命中则阻止默认（否则会粘一堆乱码）
$('editor').addEventListener('paste', e => { handleImagePaste(e); });
$('editor').addEventListener('scroll', () => {
  // 行号与高亮随编辑区滚动容器整体移动，无需同步
});
/* 标题两处输入（顶栏 + 编辑框）双向同步：改一处即时反映另一处，再触发自动保存 */
function syncTitle(src) {
  const other = src === $('doc-title') ? $('title-input') : $('doc-title');
  if (other.value !== src.value) other.value = src.value;
  syncDraftTitle();
  scheduleAutosave();
}
/* 标题改动也刷新占位行的文字，让列表里显示的就是当前标题 */
function syncDraftTitle() {
  const el = document.querySelector('#note-list li.draft .nt');
  if (el) el.textContent = $('doc-title').value || '未命名文档';
}
$('doc-title').addEventListener('input', () => syncTitle($('doc-title')));
$('title-input').addEventListener('input', () => syncTitle($('title-input')));
$('doc-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('doc-title').blur(); }
});
$('tags-input').addEventListener('input', scheduleAutosave);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 250);
});

$('btn-new').onclick = newNote;
$('btn-new-folder').onclick = newFolderFlow;
$('btn-save').onclick = doSave;
/* 打开本地文档：Rust 端弹文件选择框（支持多选），复制进笔记库后打开最后一篇 */
$('btn-open').onclick = async () => {
  try {
    const metas = await invoke('import_note', { folder: state.activeFolder || '' });
    if (metas && metas.length) {
      setStatus(`已导入 ${metas.length} 篇`, 'ok');
      await refreshList();
      await openNote(metas[metas.length - 1].file_name);
    }
  } catch (e) {
    setStatus('打开失败：' + e, 'error');
  }
};
/* 目录/视图移至标签行：仅编辑/双栏时用 row-*；仅预览时编辑行随编辑区隐藏，用预览工具条上的 prow-* */
$('row-outline').onclick = () => toggleOutline($('row-outline'));
$('prow-outline').onclick = () => toggleOutline($('prow-outline'));
function toggleOutline(btn) {
  state.outlineOpen = !state.outlineOpen;
  ['row-outline', 'prow-outline'].forEach(id => {
    $(id).setAttribute('aria-pressed', String(state.outlineOpen));
  });
  $('outline-panel').classList.toggle('is-open', state.outlineOpen);
  $('outline-panel').setAttribute('aria-hidden', String(!state.outlineOpen));
  LS.set('outline', state.outlineOpen ? '1' : '0');
  // 打开时立即按当前正文重建一次，避免面板空着
  if (state.outlineOpen) renderOutline();
}
$('outline-close').onclick = () => {
  state.outlineOpen = false;
  $('row-outline').setAttribute('aria-pressed', 'false');
  $('prow-outline').setAttribute('aria-pressed', 'false');
  $('outline-panel').classList.remove('is-open');
  $('outline-panel').setAttribute('aria-hidden', 'true');
  LS.set('outline', '0');
};
$('btn-theme').onclick = () => applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');

bindMenu('btn-export-toggle', 'export-menu');
bindMenu('row-view', 'view-menu-row');
bindMenu('prow-view', 'view-menu-prow');
bindMenu('btn-heading', 'heading-menu');
document.querySelectorAll('#export-menu .dropdown-item').forEach(el => el.onclick = () => { closeAllMenus(); exportNote(el.dataset.fmt); });
document.querySelectorAll('#view-menu-row .dropdown-item, #view-menu-prow .dropdown-item').forEach(el => el.onclick = () => { closeAllMenus(); setLayout(el.dataset.view); });
document.querySelectorAll('#heading-menu .dropdown-item').forEach(el => el.onclick = () => { closeAllMenus(); insertHeading(+el.dataset.h); });

$('btn-bold').onclick = formatBold;
$('btn-italic').onclick = formatItalic;
$('btn-underline').onclick = formatUnderline;
$('btn-strike').onclick = formatStrike;
$('btn-quote').onclick = formatQuote;
$('btn-ul').onclick = () => prefixLines('unordered');
$('btn-task').onclick = () => prefixLines('task');
bindMenu('btn-ol', 'ol-menu');
document.querySelectorAll('#ol-menu .dropdown-item').forEach(el => el.onclick = () => {
  closeAllMenus();
  if (el.dataset.ol === 'circle') formatOrderedCircleList();
  else prefixLines('ordered');
});
$('btn-inline-code').onclick = formatInlineCode;
$('btn-codeblock').onclick = insertCodeBlock;
$('btn-link').onclick = insertLink;
$('btn-image').onclick = insertImage;
$('btn-table').onclick = insertTable;
$('btn-tag').onclick = () => insertTag('accent');
$('btn-hr').onclick = insertHorizontalRule;
$('btn-undo').onclick = () => { $('editor').focus(); document.execCommand('undo'); };
$('btn-redo').onclick = () => { $('editor').focus(); document.execCommand('redo'); };

/* ---------- 更换文件夹 ---------- */
/* 切换前必须先落盘：reload 会销毁页面，防抖窗口内的编辑只存在于内存。 */
$('btn-vault-dir').onclick = async () => {
  try {
    if (state.dirty) {
      const ok = await doSave();
      if (!ok) {
        setStatus('当前笔记未保存成功，已取消切换文件夹', 'error');
        return;
      }
    }
    const dir = await invoke('pick_vault_dir');
    if (dir) {
      // 说明清楚：切换不会搬运旧笔记，避免用户以为笔记丢了
      const ok = await invoke('confirm_dialog', {
        title: '切换笔记库',
        message: `即将把笔记库切换到：\n${dir}\n\n原文件夹里的笔记不会自动搬过来，也不会被删除。继续？`,
        okLabel: '切换',
        cancelLabel: '取消',
      });
      if (!ok) return;
      await invoke('set_config', { dir });
      location.reload();
    }
  } catch (e) {
    setStatus('切换笔记库失败：' + e, 'error');
  }
};

/* ---------- 关闭窗口 ---------- */
/* 保存失败必须中止关闭：state.dirty 是内存里唯一副本，销毁页面等于丢弃它。 */
listen('close-requested', async () => {
  if (state.dirty) {
    setStatus('保存中…');
    const ok = await doSave();
    if (!ok) {
      setStatus('保存失败，已取消关闭。请检查笔记文件夹后重试。', 'error');
      return;
    }
  }
  try { await invoke('close_window'); } catch (e) { /* destroy 已可能使 invoke 失败 */ }
}).catch(() => { });

/* ---------- 快捷键 ---------- */
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  else if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); focusEditorThen(formatBold); }
  else if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); focusEditorThen(formatItalic); }
  else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); focusEditorThen(insertLink); }
  else if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); cycleLayout(); }
  else if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); }
  else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindBar(); }
  // Ctrl+H：打开查找栏并聚焦替换输入框
  else if (ctrl && e.key.toLowerCase() === 'h') { e.preventDefault(); openFindBar(); $('replace-input').focus(); }
  // 查找跳转后会聚焦编辑器（让命中可见），此时 Enter 应继续跳到下一个而非插入换行
  else if (e.key === 'Enter' && !$('find-bar').hidden && e.target === $('editor')) {
    e.preventDefault();
    findIdx += e.shiftKey ? -1 : 1;
    gotoFindHit(true);
  }
  else if (e.key === 'F6') { e.preventDefault(); applySidebar(!state.sidebarOpen); }
  else if (e.key === 'Escape') { closeAllMenus(); if (!$('find-bar').hidden) closeFindBar(); }
});

/* 焦点不在编辑器时，Ctrl+B/I/K 先聚焦编辑器再执行，避免"按了没反应" */
function focusEditorThen(fn) {
  if (document.activeElement !== $('editor')) $('editor').focus();
  fn();
}
function cycleLayout() {
  const order = ['both', 'edit', 'preview'];
  setLayout(order[(order.indexOf(state.layout) + 1) % order.length]);
}

/* ---------- 编辑器内查找（Ctrl+F）：高亮当前命中，Enter/Shift+Enter 上下跳转 ---------- */
let findHits = [], findIdx = -1;
function openFindBar() {
  $('find-bar').hidden = false;
  $('find-input').focus();
  $('find-input').select();
  runFind();
}
function closeFindBar() {
  $('find-bar').hidden = true;
  findHits = []; findIdx = -1;
  $('editor').focus();
}
function runFind() {
  const q = $('find-input').value.toLowerCase();
  const v = $('editor').value;
  findHits = [];
  if (q) {
    let i = 0;
    while ((i = v.toLowerCase().indexOf(q, i)) !== -1) { findHits.push([i, i + q.length]); i += q.length; }
  }
  // 先归一化 findIdx（-1 表示尚未跳转过，按第一条算 1 起显示），再写计数文案
  if (!findHits.length) { findIdx = -1; $('find-count').textContent = '无结果'; return; }
  if (findIdx < 0) findIdx = 0;
  $('find-count').textContent = `${findIdx + 1}/${findHits.length}`;
  gotoFindHit();
}
function gotoFindHit(focusEditor) {
  if (!findHits.length) return;
  findIdx = (findIdx + findHits.length) % findHits.length;
  const [s, e] = findHits[findIdx];
  const ta = $('editor');
  // 仅导航（Enter/前后跳转）时聚焦编辑器；输入过程中的预览不抢焦点，否则选区会吞掉下一个字符
  if (focusEditor) {
    ta.focus();
    ta.setSelectionRange(s, e);
  }
  // 滚动让命中行可见（按行高估算）
  const line = v_countLines(ta.value, s);
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  $('editor-scroll').scrollTop = Math.max(0, line * lineH - $('editor-scroll').clientHeight / 2);
  $('find-count').textContent = `${findIdx + 1}/${findHits.length}`;
}
function v_countLines(v, pos) { return v.slice(0, pos).split('\n').length - 1; }
$('find-input').addEventListener('input', () => { findIdx = -1; runFind(); });
$('find-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation(); // 防止冒泡到全局 Enter 分支再跳一次
    // findIdx=-1 表示尚未选中过：Shift+Enter 从最后一条开始，Enter 从第一条开始
    if (findIdx === -1) findIdx = e.shiftKey ? findHits.length : 0;
    else findIdx += e.shiftKey ? -1 : 1;
    gotoFindHit(true);
  }
  else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
});
$('find-next').onclick = () => { findIdx++; gotoFindHit(true); };
$('find-prev').onclick = () => { findIdx--; gotoFindHit(true); };
$('find-close').onclick = closeFindBar;

/* ---------- 替换 ----------
   替换走 applyEdit（execCommand insertText），因此仍进原生撤销栈，Ctrl+Z 可回退整批替换。 */
function replaceCurrent() {
  const q = $('find-input').value;
  if (!q || !findHits.length) return;
  const [s, e] = findHits[findIdx];
  applyEdit(s, e, $('replace-input').value, s + $('replace-input').value.length, s + $('replace-input').value.length);
  // 替换后命中位置整体变化，重跑查找并前进到下一处
  runFind();
  findIdx++;
  gotoFindHit(true);
}
function replaceAll() {
  const q = $('find-input').value;
  const rep = $('replace-input').value;
  if (!q) return;
  const v = $('editor').value;
  const lc = v.toLowerCase(), lq = q.toLowerCase();
  const out = [];
  let i = 0, count = 0;
  while (true) {
    const at = lc.indexOf(lq, i);
    if (at === -1) { out.push(v.slice(i)); break; }
    out.push(v.slice(i, at), rep);
    i = at + q.length;
    count++;
  }
  if (!count) { setStatus('没有可替换的匹配', 'ok'); return; }
  const next = out.join('');
  // 整篇一次替换：选中全部内容再插入，保证能被一次 Ctrl+Z 撤销
  applyEdit(0, v.length, next, 0, 0);
  setStatus(`已替换 ${count} 处`, 'ok');
  runFind();
}
$('replace-one').onclick = replaceCurrent;
$('replace-all').onclick = replaceAll;
$('replace-input').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
});
$('replace-input').addEventListener('input', e => e.stopPropagation());

/* ---------- 编辑器 Tab 缩进 ----------
   正文里 Tab 用于缩进，为免纯键盘被困在 textarea：Ctrl+Tab 移出焦点。 */
$('editor').addEventListener('keydown', e => {
  if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    // 按 DOM 顺序走到编辑器之后的下一个可聚焦控件
    const focusables = [...document.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    const i = focusables.indexOf($('editor'));
    const next = focusables[i + 1] || focusables[0];
    if (next) next.focus();
    return;
  }
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = $('editor');
  const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
  if (e.shiftKey) {
    // Shift+Tab：对选区内每行（或当前行）删除行首一个缩进单位
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', en);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    let removedFirst = 0, delta = 0;
    const out = lines.map((l, i) => {
      const m = l.match(/^[ \t]/);
      if (!m) return l;
      const cut = i === 0 ? m[0].length : 1; // 首行可能从行中间开始，只按实际前缀算
      if (i === 0) removedFirst = cut;
      delta += cut;
      return l.slice(cut);
    }).join('\n');
    applyEdit(lineStart, lineEnd, out, Math.max(lineStart, s - removedFirst), Math.max(lineStart, en - delta));
  } else {
    // Tab：有选区时整块缩进，无选区插入两个空格
    if (s !== en && v.slice(s, en).includes('\n')) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = v.indexOf('\n', en);
      if (lineEnd === -1) lineEnd = v.length;
      const lines = v.slice(lineStart, lineEnd).split('\n');
      const out = lines.map(l => '  ' + l).join('\n');
      applyEdit(lineStart, lineEnd, out, s + 2, en + lines.length * 2);
    } else {
      applyEdit(s, en, '  ', s + 2, s + 2);
    }
  }
});

/* ---------- 恢复界面状态 ---------- */
applyTheme(LS.get('theme', 'light'));
setLayout(LS.get('layout', 'both'));
function applySidebar(open) {
  state.sidebarOpen = open;
  LS.set('sidebar', open ? '1' : '0');
  $('sidebar').classList.toggle('hidden-left', !open);
  $('btn-sidebar').setAttribute('aria-pressed', String(open));
}
applySidebar(LS.get('sidebar', '1') === '1');
$('btn-sidebar').onclick = () => applySidebar(!state.sidebarOpen);
$('btn-sidebar').setAttribute('aria-pressed', String(state.sidebarOpen));
$('sort-select').value = LS.get('sort', 'modified');
$('sort-select').onchange = () => { LS.set('sort', $('sort-select').value); refreshList(); };
state.outlineOpen = LS.get('outline', '0') === '1';
if (state.outlineOpen) {
  $('outline-panel').classList.add('is-open');
  $('outline-panel').setAttribute('aria-hidden', 'false');
  $('row-outline').setAttribute('aria-pressed', 'true');
  $('prow-outline').setAttribute('aria-pressed', 'true');
}


/* ---------- 启动 ---------- */
(async function init() {
  const cfg = await ensureConfig();
  if (!cfg) { setStatus('未选择文件夹，部分功能不可用'); return; }
  await refreshList();
  // 打开上次编辑的笔记（仍在列表中才打开）
  const last = LS.get('last_open', '');
  if (last && state.notes.some(n => n.file_name === last)) {
    await openNote(last);
  } else {
    // 没有打开任何笔记时，预览区给空态引导，而不是一片空白
    renderPreviewEmptyState(true);
  }
  setStatus('就绪 · 自动保存已启用');
  maybeShowFirstRun();
})();
