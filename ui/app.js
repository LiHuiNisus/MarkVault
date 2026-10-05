const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// 供 Task 5、6 使用的全局对象
const api = { invoke };

const state = { notes: [], current: null, dirty: false, config: null };

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

function render(md) {
  const html = marked.parse(md || '');
  document.getElementById('preview').innerHTML = DOMPurify.sanitize(html);
}

let saveTimer = null;
function scheduleAutosave() {
  state.dirty = true;
  setStatus('未保存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 2000);
}

async function doSave() {
  if (!state.current) return;
  const title = document.getElementById('title-input').value.trim() || '无标题';
  const tags = document.getElementById('tags-input').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const content = document.getElementById('editor').value;
  try {
    const meta = await invoke('save_note', { fileName: state.current.file_name || '', title, tags, content });
    state.current = meta;
    state.dirty = false;
    setStatus('已保存 ' + new Date().toLocaleTimeString());
    await refreshList();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('未配置') || msg.includes('NotFound')) {
      setStatus('笔记文件夹不可用，请在底部更换文件夹');
    } else {
      setStatus('保存失败：' + msg);
    }
  }
}

async function refreshList() {
  const q = document.getElementById('search').value;
  state.notes = q ? await invoke('search_notes', { query: q }) : await invoke('list_notes');
  const ul = document.getElementById('note-list');
  ul.innerHTML = '';
  if (state.notes.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = document.getElementById('search').value ? '没有匹配的笔记' : '点击『新建』写第一篇笔记';
    ul.appendChild(li);
  }
  for (const n of state.notes) {
    const li = document.createElement('li');
    const nt = document.createElement('div');
    nt.className = 'nt';
    nt.textContent = n.title;
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = (n.modified || '').replace('T', ' ');
    li.appendChild(nt);
    li.appendChild(nm);
    li.onclick = () => openNote(n.file_name);
    if (state.current && state.current.file_name === n.file_name) li.classList.add('active');
    ul.appendChild(li);
  }
  renderTagBar();
}

function renderTagBar() {
  const bar = document.getElementById('tag-bar');
  const all = new Set();
  state.notes.forEach(n => (n.tags || []).forEach(t => all.add(t)));
  bar.textContent = '';
  // “全部”芯片：点击清除搜索/筛选，恢复完整列表
  const clear = document.createElement('span');
  clear.className = 'tag tag-all';
  clear.textContent = '全部';
  clear.onclick = () => {
    document.getElementById('search').value = '';
    refreshList();
  };
  bar.appendChild(clear);
  [...all].sort().forEach(t => {
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = t;
    s.onclick = () => { document.getElementById('search').value = t; refreshList(); };
    bar.appendChild(s);
  });
}

async function openNote(fileName) {
  if (state.dirty) await confirmDiscard();
  clearTimeout(saveTimer);
  let note;
  try {
    note = await invoke('read_note', { fileName });
  } catch (e) {
    setStatus('读取失败：' + e);
    return;
  }
  // read_note 返回扁平对象 {file_name, title, tags, created, modified, content}
  state.current = note;
  document.getElementById('title-input').value = note.title;
  document.getElementById('tags-input').value = (note.tags || []).join(', ');
  document.getElementById('editor').value = note.content;
  render(note.content);
  state.dirty = false;
  setStatus('就绪');
  refreshList();
}

async function newNote() {
  if (state.dirty) await confirmDiscard();
  clearTimeout(saveTimer);
  state.current = { file_name: '' };
  document.getElementById('title-input').value = '';
  document.getElementById('tags-input').value = '';
  document.getElementById('editor').value = '# 新笔记\n\n';
  render(document.getElementById('editor').value);
  state.dirty = false;
}

async function confirmDiscard() {
  // MVP：直接保存后切换，避免丢失
  await doSave();
}

function setStatus(t) { document.getElementById('save-status').textContent = t; }

async function exportNote(format) {
  if (!state.current) { setStatus('没有可导出的笔记'); return; }
  await doSave();
  const fileName = state.current.file_name || '无标题';
  if (format === 'pdf') { window.print(); return; }
  let payload = '';
  if (format === 'html' || format === 'doc') {
    payload = buildStandaloneHtml();
  } else if (format === 'md') {
    payload = document.getElementById('editor').value;
  } else if (format === 'png') {
    try {
      payload = await capturePng();
    } catch (e) {
      setStatus('生成图片失败：' + e);
      return;
    }
    if (!payload) { setStatus('生成图片失败'); return; }
  }
  try {
    const path = await invoke('export_note', { fileName, format, payload });
    setStatus('已导出：' + path);
  } catch (e) {
    if (e === '已取消') return; // 用户取消保存对话框，不算错误
    setStatus('导出失败：' + e);
  }
}

function buildStandaloneHtml() {
  const body = document.getElementById('preview').innerHTML;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(state.current.title || '')}</title><style>body{max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.7;} pre{background:#f4f4f4;padding:12px;} code{background:#f4f4f4;}</style></head><body>${body}</body></html>`;
}

async function capturePng() {
  // dom-to-image-more 渲染预览区为 PNG（需 vendor 引入）
  const node = document.getElementById('preview');
  const dataUrl = await domtoimage.toPng(node);
  if (!dataUrl || dataUrl.indexOf(',') === -1) return null;
  return dataUrl.split(',')[1];
}

document.getElementById('editor').addEventListener('input', () => { render(document.getElementById('editor').value); scheduleAutosave(); });
document.getElementById('title-input').addEventListener('input', scheduleAutosave);
document.getElementById('tags-input').addEventListener('input', scheduleAutosave);
document.getElementById('search').addEventListener('input', () => refreshList());
document.getElementById('btn-new').onclick = newNote;

// 导出下拉菜单：点击切换，点击菜单外关闭
const exportMenu = document.getElementById('export-menu');
document.getElementById('btn-export-toggle').onclick = (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!exportMenu.classList.contains('hidden') && !exportMenu.contains(e.target)) {
    exportMenu.classList.add('hidden');
  }
});
document.querySelectorAll('#export-menu button').forEach(b => b.onclick = () => {
  exportMenu.classList.add('hidden');
  exportNote(b.dataset.fmt);
});

// 更换文件夹：重新选择后写配置并整页刷新
document.getElementById('btn-vault-dir').onclick = async () => {
  try {
    const dir = await invoke('pick_vault_dir');
    if (dir) {
      await invoke('set_config', { dir });
      location.reload();
    }
  } catch (e) {
    setStatus('更换文件夹失败：' + e);
  }
};

// 关闭窗口：Rust 侧拦截 CloseRequested 并发来 close-requested；保存后真正关闭
listen('close-requested', async () => {
  try {
    if (state.dirty) {
      setStatus('保存中…');
      await doSave();
    }
  } finally {
    try { await invoke('close_window'); } catch (e) { /* destroy 已可能使 invoke 失败 */ }
  }
}).catch(() => { /* listen 注册失败不影响启动 */ });

window.MV = { state, api, render, scheduleAutosave, refreshList, openNote, newNote, exportNote };

(async function init() {
  const cfg = await ensureConfig();
  if (!cfg) { setStatus('未选择文件夹，部分功能不可用'); return; }
  await refreshList();
  setStatus('就绪');
})();
