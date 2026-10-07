const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);

const state = {
  notes: [], current: null, dirty: false, config: null,
  layout: 'both', outlineOpen: false, sidebarOpen: true,
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
  // 按高亮层每行实际高度（含自动换行）拉伸行号，长行下方行号不错位
  const nums = gutter.querySelectorAll('.line-num');
  hlLines.forEach((el, i) => {
    const h = el.offsetHeight;
    if (h > 0 && nums[i]) nums[i].style.height = h + 'px';
  });
}

/* ---------- 预览渲染 ---------- */
function render(md) {
  const html = marked.parse(md || '');
  $('preview').innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['badges', 'u'], ADD_ATTR: ['tone'] });
  enhancePreviewHtml();
  renderOutline();
  renderWordCount(md || '');
}

function renderWordCount(md) {
  const cjk = (md.match(/[一-龥]/g) || []).length;
  const words = (md.replace(/[一-龥]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
  $('word-count').textContent = cjk + ' 字 · ' + words + ' 词';
}

/* ---------- 目录 ---------- */
let outlineTimer = null;
function renderOutline() {
  const list = $('outline-list');
  list.innerHTML = '';
  const hs = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  if (!hs.length) {
    list.innerHTML = '<div class="outline-empty">暂无标题，使用 # 添加章节</div>';
    return;
  }
  hs.forEach((h, i) => {
    h.dataset.outline = i;
    const btn = document.createElement('button');
    btn.className = 'outline-item level-' + h.tagName[1];
    btn.innerHTML = '<span class="outline-item-dot"></span>';
    const txt = document.createElement('span');
    txt.className = 'outline-item-text';
    txt.textContent = h.textContent;
    btn.appendChild(txt);
    btn.onclick = () => {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveOutline(i);
    };
    list.appendChild(btn);
  });
}

function setActiveOutline(idx) {
  document.querySelectorAll('#outline-list .outline-item').forEach((el, i) => {
    el.classList.toggle('is-active', i === idx);
  });
}

/* ---------- 编辑/预览滚动同步（比例映射 + 防回环锁） ---------- */
let syncFrom = null, syncResetTimer = null;
function syncScroll(src, dst) {
  if (syncFrom && syncFrom !== src) return;
  syncFrom = src;
  clearTimeout(syncResetTimer);
  syncResetTimer = setTimeout(() => { syncFrom = null; }, 120);
  const srcMax = src.scrollHeight - src.clientHeight;
  if (srcMax <= 1) return;
  const ratio = src.scrollTop / srcMax;
  dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
}
$('editor-scroll').addEventListener('scroll', () => syncScroll($('editor-scroll'), $('preview')));
$('preview').addEventListener('scroll', () => {
  syncScroll($('preview'), $('editor-scroll'));
  if (!state.outlineOpen) return;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    const hs = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
    const top = $('preview').scrollTop;
    let cur = 0;
    hs.forEach((h, i) => { if (h.offsetTop - 40 <= top) cur = i; });
    setActiveOutline(cur);
  }, 100);
});

/* ---------- 保存 ---------- */
let saveTimer = null;
function scheduleAutosave() {
  state.dirty = true;
  setStatus('未保存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 2000);
}

async function doSave() {
  if (!state.current) return;
  clearTimeout(saveTimer);
  const title = $('title-input').value.trim() || '无标题';
  const tags = $('tags-input').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const content = $('editor').value;
  try {
    const meta = await invoke('save_note', { fileName: state.current.file_name || '', title, tags, content });
    state.current = meta;
    state.dirty = false;
    LS.set('last_open', meta.file_name);
    document.title = (title === '无标题' ? '未命名文档' : title) + ' - MarkVault';
    setStatus('已保存 ' + new Date().toLocaleTimeString(), 'ok');
    await refreshList();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('未配置') || msg.includes('NotFound')) {
      setStatus('笔记文件夹不可用，请在顶栏更换文件夹', 'error');
    } else {
      setStatus('保存失败：' + msg, 'error');
    }
  }
}

function setStatus(t, kind) {
  const el = $('save-status');
  el.textContent = t;
  el.classList.remove('error', 'ok');
  if (kind === 'error') el.classList.add('error');
  else if (kind === 'ok') el.classList.add('ok');
}

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
async function refreshList() {
  const q = $('search').value.trim();
  const sort = LS.get('sort', 'modified');
  state.notes = q
    ? await invoke('search_notes', { query: q, sort })
    : await invoke('list_notes', { sort });
  const ul = $('note-list');
  ul.innerHTML = '';
  if (!state.notes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? '没有匹配的笔记' : '点击「新建」写第一篇笔记';
    ul.appendChild(li);
  }
  for (const n of state.notes) {
    const li = document.createElement('li');
    li.dataset.file = n.file_name;
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
    li.onclick = () => openNote(n.file_name);
    if (state.current && state.current.file_name === n.file_name) li.classList.add('active');
    ul.appendChild(li);
  }
  renderTagBar();
}

/* 悬停编辑：列表项内联输入框替换标题，Enter/失焦提交，Esc 取消 */
function startInlineRename(li, n) {
  if (li.querySelector('.rename-input')) return;
  const nt = li.querySelector('.nt');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = n.title;
  nt.replaceWith(input);  input.focus();
  input.select();
  let done = false;
  const commit = async ok => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (!ok || !title || title === n.title) { await refreshList(); return; }
    try {
      await invoke('rename_note', { fileName: n.file_name, title });
      if (state.current && state.current.file_name === n.file_name) {
        state.current.title = title;
        $('title-input').value = title;
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
  input.onblur = () => commit(true);
}

/* 删除：系统原生确认弹窗，确认后删除并清空编辑区（若正打开该笔记） */
async function deleteNoteFlow(n) {
  const ok = await invoke('confirm_dialog', {
    title: '确认删除',
    message: `确定删除「${n.title}」？删除后无法恢复。`,
    okLabel: '删除',
    cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    await invoke('delete_note', { fileName: n.file_name });
    if (state.current && state.current.file_name === n.file_name) {
      state.current = null;
      $('title-input').value = '';
      $('tags-input').value = '';
      $('editor').value = '';
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

function renderTagBar() {
  const bar = $('tag-bar');
  const all = new Set();
  state.notes.forEach(n => (n.tags || []).forEach(t => all.add(t)));
  bar.textContent = '';
  const clear = document.createElement('span');
  clear.className = 'tag';
  clear.textContent = '全部';
  clear.onclick = () => { $('search').value = ''; refreshList(); };
  bar.appendChild(clear);
  [...all].sort().forEach(t => {
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = t;
    s.onclick = () => { $('search').value = t; refreshList(); };
    bar.appendChild(s);
  });
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
  $('tags-input').value = (note.tags || []).join(', ');
  $('editor').value = note.content;
  renderHighlight();
  render(note.content);
  state.dirty = false;
  LS.set('last_open', fileName);
  document.title = (note.title === '无标题' ? '未命名文档' : note.title) + ' - MarkVault';
  setStatus('就绪');
  refreshList();
}

async function newNote() {
  if (state.dirty) await doSave();
  state.current = { file_name: '' };
  $('title-input').value = '';
  $('tags-input').value = '';
  $('editor').value = '';
  renderHighlight();
  render('');
  state.dirty = false;
  document.title = '未命名文档 - MarkVault';
  $('title-input').focus();
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
  resizer.addEventListener('mousedown', e => { dragging = true; resizer.classList.add('dragging'); document.body.classList.add('resizing'); e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const w = Math.min(Math.max(e.clientX - rect.left, 240), rect.width - 320);
    $('main-shell').querySelector('.editor-block').style.flex = `0 0 ${w}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
})();

/* ---------- 下拉菜单 ---------- */
function closeAllMenus(except) {
  document.querySelectorAll('.dropdown-menu.show').forEach(m => {
    if (m !== except) m.classList.remove('show');
  });
}
function bindMenu(btnId, menuId) {
  $(btnId).addEventListener('click', e => {
    e.stopPropagation();
    const m = $(menuId);
    const show = !m.classList.contains('show');
    closeAllMenus();
    m.classList.toggle('show', show);
    // 工具栏/标签行容器有 overflow:hidden 或换行裁剪，统一用 fixed 定位到按钮正下方，避免被遮盖
    if (show && m.closest('.editor-toolbar, .title-row-actions, .preview-toolbar, .format-group-track')) {
      const r = $(btnId).getBoundingClientRect();
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
  const escHandler = e => {
    if (e.key === 'Escape') { e.stopPropagation(); done(false); }
  };
  document.addEventListener('keydown', escHandler, true);
  modal.onclick = e => { if (e.target === modal) done(false); };
  $('link-ok').onclick = () => done(true);
  $('link-cancel').onclick = () => done(false);
  input.onkeydown = e => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
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

function onEditorInput() {
  renderHighlight();
  render($('editor').value);
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
  if (format === 'html' || format === 'doc') {
    payload = buildStandaloneHtml();
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
    const path = await invoke('export_note', { fileName, format, payload });
    setStatus('已导出：' + path, 'ok');
  } catch (e) {
    if (e === '已取消') return;
    setStatus('导出失败：' + e, 'error');
  }
}

function buildStandaloneHtml() {
  const body = $('preview').innerHTML;
  const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(state.current.title || '')}</title><style>body{max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.8;color:#1a1d23;} pre{background:#1a1d27;color:#d7dbea;padding:16px;border-radius:10px;} code{background:rgba(163,21,21,.08);padding:2px 5px;border-radius:4px;} pre code{background:transparent;padding:0;} blockquote{border-left:4px solid #6C5CE7;background:rgba(108,92,231,.07);margin:12px 0;padding:12px 16px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px 12px;} th{background:#f3f5f8;} img{max-width:100%;} h1{font-size:2em;} h2{border-bottom:1px solid #eee;padding-bottom:6px;} ul.task-list{list-style:none;padding-left:.4em;} li.task-item{list-style:none;} li.task-item input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:15px;height:15px;border:1.5px solid #9a948c;border-radius:4px;vertical-align:-2px;margin-right:6px;position:relative;} li.task-item input[type="checkbox"]:checked{background:#6C5CE7;border-color:#6C5CE7;} li.task-item input[type="checkbox"]:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);} ol.ol-circle{list-style:none;counter-reset:ol-circle;padding-left:0;} ol.ol-circle>li{counter-increment:ol-circle;position:relative;padding-left:30px;margin:6px 0;} ol.ol-circle>li::before{content:counter(ol-circle);position:absolute;left:0;top:.2em;width:20px;height:20px;border-radius:50%;background:#6C5CE7;color:#fff;font-size:12px;display:inline-flex;align-items:center;justify-content:center;} .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;} .badge.tone-accent{background:rgba(108,92,231,.12);color:#6C5CE7;} .badge.tone-green{background:rgba(46,184,114,.14);color:#1f9d63;} .badge.tone-yellow{background:rgba(240,180,40,.16);color:#b07d10;} .badge.tone-dark{background:rgba(30,34,44,.88);color:#fff;} u{text-decoration:underline;text-underline-offset:3px;}</style></head><body>${body}</body></html>`;
}

async function capturePng() {
  const node = $('preview');
  const dataUrl = await domtoimage.toPng(node);
  if (!dataUrl || dataUrl.indexOf(',') === -1) return null;
  return dataUrl.split(',')[1];
}

/* ---------- 主题 ---------- */
function applyTheme(t) {
  document.body.dataset.theme = t;
  LS.set('theme', t);
}

/* ---------- 事件绑定 ---------- */
$('editor').addEventListener('input', onEditorInput);
$('editor').addEventListener('scroll', () => {
  // 行号与高亮随编辑区滚动容器整体移动，无需同步
});
$('title-input').addEventListener('input', scheduleAutosave);
$('tags-input').addEventListener('input', scheduleAutosave);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 250);
});

$('btn-new').onclick = newNote;
$('btn-save').onclick = doSave;
/* 打开本地文档：Rust 端弹文件选择框，复制进笔记库后直接打开 */
$('btn-open').onclick = async () => {
  try {
    const meta = await invoke('import_note');
    if (meta) {
      setStatus('已导入', 'ok');
      await refreshList();
      await openNote(meta.file_name);
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
$('btn-tag').onclick = () => insertTag('accent');
$('btn-hr').onclick = insertHorizontalRule;
$('btn-undo').onclick = () => { $('editor').focus(); document.execCommand('undo'); };
$('btn-redo').onclick = () => { $('editor').focus(); document.execCommand('redo'); };

/* ---------- 更换文件夹 ---------- */
$('btn-vault-dir').onclick = async () => {
  try {
    const dir = await invoke('pick_vault_dir');
    if (dir) {
      await invoke('set_config', { dir });
      location.reload();
    }
  } catch (e) {
    setStatus('更换文件夹失败：' + e, 'error');
  }
};

/* ---------- 关闭窗口 ---------- */
listen('close-requested', async () => {
  try {
    if (state.dirty) {
      setStatus('保存中…');
      await doSave();
    }
  } finally {
    try { await invoke('close_window'); } catch (e) { /* destroy 已可能使 invoke 失败 */ }
  }
}).catch(() => { });

/* ---------- 快捷键 ---------- */
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  else if (ctrl && e.key.toLowerCase() === 'b' && document.activeElement === $('editor')) { e.preventDefault(); formatBold(); }
  else if (ctrl && e.key.toLowerCase() === 'i' && document.activeElement === $('editor')) { e.preventDefault(); formatItalic(); }
  else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindBar(); }
  else if (e.key === 'Escape') { closeAllMenus(); if (!$('find-bar').hidden) closeFindBar(); }
});

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
  $('find-count').textContent = findHits.length ? `${findIdx + 1 < 0 ? 0 : findIdx + 1}/${findHits.length}` : '无结果';
  if (!findHits.length) { findIdx = -1; return; }
  if (findIdx === -1) { findIdx = 0; return; }
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

/* ---------- 编辑器 Tab 缩进 ---------- */
$('editor').addEventListener('keydown', e => {
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

window.MV = { state, render, renderHighlight, refreshList, openNote, newNote, exportNote, doSave, formatBold, formatItalic, formatUnderline, formatStrike, formatInlineCode, formatQuote, prefixLines, insertHeading, formatOrderedCircleList, insertCodeBlock, insertLink, insertHorizontalRule, insertTag, applyEdit, wrapSel, toggleTaskItem };

/* ---------- 启动 ---------- */
(async function init() {
  const cfg = await ensureConfig();
  if (!cfg) { setStatus('未选择文件夹，部分功能不可用'); return; }
  await refreshList();
  // 打开上次编辑的笔记（仍在列表中才打开）
  const last = LS.get('last_open', '');
  if (last && state.notes.some(n => n.file_name === last)) {
    await openNote(last);
  }
  setStatus('就绪 · 自动保存已启用');
})();
