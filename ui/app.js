const { invoke } = window.__TAURI__.core;

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
    setStatus('保存失败：' + e);
  }
}

async function refreshList() {
  const q = document.getElementById('search').value;
  state.notes = q ? await invoke('search_notes', { query: q }) : await invoke('list_notes');
  const ul = document.getElementById('note-list');
  ul.innerHTML = '';
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
  const note = await invoke('read_note', { fileName });
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

document.getElementById('editor').addEventListener('input', () => { render(document.getElementById('editor').value); scheduleAutosave(); });
document.getElementById('title-input').addEventListener('input', scheduleAutosave);
document.getElementById('tags-input').addEventListener('input', scheduleAutosave);
document.getElementById('search').addEventListener('input', () => refreshList());
document.getElementById('btn-new').onclick = newNote;

window.MV = { state, api, render, scheduleAutosave, refreshList, openNote, newNote };

(async function init() {
  const cfg = await ensureConfig();
  if (!cfg) { setStatus('未选择文件夹，部分功能不可用'); return; }
  await refreshList();
  setStatus('就绪');
})();
