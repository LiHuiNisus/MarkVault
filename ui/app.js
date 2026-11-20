const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);

const state = {
  notes: [], current: null, dirty: false, config: null,
  layout: 'both', outlineOpen: false, sidebarOpen: true,
  folders: [], activeFolder: '',
  // 当前文档类型：'md'（Markdown 源码 + 预览）或 'rich'（富文本所见即所得）。
  // 类型在创建时确定，落盘后不可更改（kindLocked）。磁盘扩展名是唯一事实来源。
  kind: 'md', kindLocked: false,
  // Quill 实例（懒创建）与「data URL → .assets/ 相对路径」映射，保存时据此还原图片引用
  rich: null, richAssets: new Map(),
  // 结构化筛选：folderFilter 为 null 表示不限、'' 表示只看根目录
  folderFilter: null,
  // 标签筛选（AND）：点列表里的标签胶囊就加进来，再点一次移除。
  // 与搜索框的全文查询是两件事——搜索匹配正文里的词，标签只认 frontmatter。
  tagFilter: [],
  // 「在此新建文档」显式指定的落点：null 表示没有指定，按筛选/选中文件夹推断。
  // 不直接用 activeFolder 是因为点击顺序和筛选状态会把它冲掉。
  pendingNewFolder: null,
  // 多选集合：存 file_name。用于批量移动。
  selected: new Set(),
  // 侧栏自定义顺序（拖动排序）：文件夹之间的顺序 + 每个文件夹内的笔记顺序。
  // 持久化在库根的 .markvault-order.json，由 Rust 端读写；这里只是内存镜像。
  order: { folders: [], notes: {} },
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem('mv_' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mv_' + k, v); } catch { } },
};

/* ---------- 配置 ---------- */
/* 笔记库目录由后端在启动时创建（exe 同级的 notes），前端只读取。 */
async function ensureConfig() {
  if (state.config) return state.config;
  const cfg = await invoke('get_config');
  if (!cfg || !cfg.vault_dir) throw new Error('笔记目录初始化失败');
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

/* 上一次渲染高亮层时用的正文。跳转前比对一次，过期就重渲染，避免拿旧几何定位。 */
let hlSrc = null;
/* 把行号高度对齐到高亮层每行的真实高度（含软换行）。
   两趟处理：先读完所有高度再统一写。边读边写每轮都会强制同步布局，
   上千行时整体耗时从毫秒级涨到秒级——打开长文明显卡顿即源于此。
   必须写每一行，不能"等于默认行高就跳过"：CSS 默认行高 22.390625px 与高亮层
   实测的 22.40625px 差 0.0156px，3000 行累计下来行号会错开 46px。
   写入本身很便宜（6000 行约 3ms），贵的是中间夹着的读取。 */
function syncGutterHeights() {
  const hlLines = $('editor-highlight').querySelectorAll('.hl-line');
  const nums = $('editor-gutter').querySelectorAll('.line-num');
  if (!hlLines.length || hlLines.length !== nums.length) return;
  const heights = new Array(hlLines.length);
  for (let i = 0; i < hlLines.length; i++) heights[i] = hlLines[i].getBoundingClientRect().height;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h > 0) nums[i].style.height = h + 'px';
  }
}

function renderHighlight() {
  const val = $('editor').value;
  const lines = val.split('\n');
  inCode = false;
  hlSrc = val;
  $('editor-highlight').innerHTML = lines.map(l => `<div class="hl-line">${hlLine(l) || '​'}</div>`).join('');
  $('editor-gutter').innerHTML = lines.map((_, i) => `<div class="line-num">${i + 1}</div>`).join('');
  syncGutterHeights();
}

/* 编辑区宽度变了（窗口缩放、拖分隔条、收侧栏、切布局）后行会重新软换行，
   行号高度必须跟着重算，否则行号从某一行开始整体偏移，越往下偏得越多。
   用 ResizeObserver 盯住编辑块宽度：比在每个改宽度的入口手动调用更可靠，
   也不会漏掉预览布局切换这类间接变化。 */
let gutterResizeTimer = null, lastEditorWidth = 0;
function scheduleGutterSync() {
  clearTimeout(gutterResizeTimer);
  gutterResizeTimer = setTimeout(() => {
    if (!isRich()) syncGutterHeights();
  }, 120);
}
function watchEditorWidth() {
  const block = document.querySelector('.editor-block');
  if (!block || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(entries => {
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      if (w === lastEditorWidth) continue;
      lastEditorWidth = w;
      scheduleGutterSync();
    }
  }).observe(block);
}
watchEditorWidth();
window.addEventListener('resize', scheduleGutterSync);

/* ---------- 预览渲染 ---------- */
/* 预览所见即编辑所见：段内单换行渲染为 <br>。
   marked 默认把单换行合并进同一段，编辑页两行、预览一行，两侧对不上。 */
marked.setOptions({ gfm: true, breaks: true });
/* 记录预览当前对应哪份正文：仅编辑模式下会跳过渲染，切回双栏时要据此补一次。 */
/* 记录"当前操作的是第几张表格"（预览里的表格顺序 = 源码里管道表的顺序）。
   声明放在 render 之前：render 收尾要据此决定浮动条是否还该显示。 */
let activeTableIdx = -1;
let previewSrc = null;
function render(md) {
  previewSrc = md || '';
  const html = marked.parse(md || '');
  $('preview').innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['badges', 'u'], ADD_ATTR: ['tone'] });
  enhancePreviewHtml();
  // 正文为空时给预览区块一个空态覆盖层，避免新用户对着白框（不写进 #preview，免得被导出带走）
  renderPreviewEmptyState(!(md || '').trim());
  renderOutline();
  renderWordCount(md || '');
  // 重渲染会替换掉预览里的 table 节点：之前定位的那张表已经不在 DOM 里了，
  // 浮动条继续留着就会对着"不存在的表格"操作。按源码重新解析一次位置。
  if (typeof refreshTableOpsAfterRender === 'function') refreshTableOpsAfterRender();
}

/* 渲染后重定位表格浮动条：光标还在表格里就继续显示，否则收起 */
function refreshTableOpsAfterRender() {
  if (typeof activeTableIdx === 'undefined' || activeTableIdx < 0) return;
  const ta = $('editor');
  if (document.activeElement === ta) syncTableOps();
  else showTableOps(activeTableIdx);
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
  // 顶栏也放一份：仅编辑模式下预览工具条整体隐藏，字数不能跟着消失。
  // 与富文本侧同口径：纯英文文档显示词数，「0 字」看着像统计失效。
  const hdr = $('header-word-count');
  if (hdr) hdr.textContent = (cjk + cjkPunct) ? (cjk + cjkPunct) + ' 字' : words + ' 词';
}

/* ---------- 文档类型：Markdown / 富文本 ----------
   类型在创建时确定，落盘后不可更改。磁盘扩展名（.md / .html）是唯一事实来源，
   前端只维护 state.kind 做编辑界面切换，不试图在两种格式之间做有损转换。 */
function isRich() { return state.kind === 'rich'; }

/* 当前正文：Markdown 取 textarea，富文本取 Quill 的 HTML（图片已还原成 .assets/ 相对路径） */
function currentContent() {
  return isRich() ? richHtmlForSave() : $('editor').value;
}

/* 富文本工具栏的中文文案。Quill 自带的按钮只有图标，没有 title，悬停不出提示；
   标题下拉与链接气泡的文字则写死在 snow 主题的 CSS 里。这里统一补中文：
   title/aria-label 走 JS，下拉项与气泡文案走 style.css 的 ::before/::after 覆盖。
   悬停出原生气泡，与 Markdown 工具栏的行为一致。 */
const RICH_BUTTON_TIPS = {
  'ql-bold': '加粗 Ctrl+B',
  'ql-italic': '斜体 Ctrl+I',
  'ql-underline': '下划线 Ctrl+U',
  'ql-strike': '删除线',
  'ql-blockquote': '引用',
  'ql-code-block': '代码块',
  'ql-link': '插入链接 Ctrl+K',
  'ql-image': '插入图片（也可直接粘贴截图）',
  'ql-clean': '清除格式',
};
const RICH_HEADING_LABELS = {
  1: '标题 1', 2: '标题 2', 3: '标题 3',
  4: '标题 4', 5: '标题 5', 6: '标题 6',
};

/* ---------- 富文本扩展格式 ----------
   Quill 2 核心给的按钮只有标题/粗斜下删/列表/引用/代码块/链接/图片。竞品（Typora、
   语雀、Notion、飞书）里最常用的下面这几项它一个都没有，所以在这里补：
   文字颜色与背景、对齐、列表缩进、上标下标、待办清单、表格、分隔线。
   表格是 Quill 2 自带的 modules/table，只是 snow 主题不给按钮，注册模块后可以自己接。
   待办清单也是核心 list blot 的既有能力（data-list=checked/unchecked），
   只是默认工具栏没暴露；点击勾选由 blot 自己处理。 */
let richFormatsReady = false;
const DividerBlotClass = (() => {
  class DividerBlot extends Quill.import('blots/block/embed') {}
  DividerBlot.blotName = 'divider';
  DividerBlot.tagName = 'HR';
  return DividerBlot;
})();

function initRichFormats() {
  if (richFormatsReady) return;
  richFormatsReady = true;
  // 分隔线：Quill 没有对应 blot，用 BlockEmbed 挂在 <hr> 上
  Quill.register(DividerBlotClass);
  // 剪贴板：HTML → Delta 时把 <hr> 认成分隔线；不注册的话粘贴会直接丢掉它
  const Delta = Quill.import('delta');
  Quill.import('modules/clipboard').DEFAULTS.matchers.push(['hr', (node, delta) => new Delta().insert({ divider: true })]);
}

/* 富文本工具栏。比原来多出：撤销重做（localizeRichToolbar 里插）、对齐、
   颜色/背景、缩进、上下标、待办、表格、分隔线。表格与分隔线不是 Quill 的
   工具栏格式（表格只有 modules/table 模块，分隔线是我们自己注册的 blot），
   由 appendRichExtras() 在 Quill 生成工具栏后追加按钮并绑点击。 */
const RICH_TOOLBAR_ROWS = [
  [{ header: [1, 2, 3, 4, 5, 6, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ align: [] }],
  [{ script: 'sub' }, { script: 'super' }],
  [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
  [{ indent: '-1' }, { indent: '+1' }],
  ['blockquote', 'code-block', 'link', 'image'],
  ['clean'],
];

/* 追加 Quill 工具栏不认识的按钮：表格、分隔线。
   放在「引用/代码/链接/图片」之后、「清除格式」之前，与 Markdown 工具栏的分组顺序一致。 */
function appendRichExtras(q) {
  const bar = document.querySelector('.rich-host .ql-toolbar');
  if (!bar) return;
  const mk = (cls, tip, svg, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ql-ext ' + cls;
    b.title = tip;
    b.setAttribute('aria-label', tip);
    b.innerHTML = svg;
    b.addEventListener('mousedown', e => e.preventDefault()); // 别让按钮抢走编辑器选区
    b.addEventListener('click', e => { e.preventDefault(); onClick(); });
    return b;
  };
  const tableBtn = mk('ql-table', '插入表格',
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',
    () => openRichTablePicker());
  const dividerBtn = mk('ql-divider', '插入分隔线',
    '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
    () => {
      const range = q.getSelection(true) || { index: q.getLength() - 1, length: 0 };
      if (range.length) q.deleteText(range.index, range.length, 'user');
      q.insertEmbed(range.index, 'divider', true, 'user');
      // 分隔线是块级嵌入：后面补一个空段落，否则光标无处可去，用户接着打字会落在 hr 之前
      q.insertText(range.index + 1, '\n', 'user');
      q.setSelection(range.index + 2, 0, 'user');
      q.focus();
    });
  const cleanBtn = bar.querySelector('button.ql-clean');
  const group = document.createElement('span');
  group.className = 'ql-formats';
  group.appendChild(tableBtn);
  group.appendChild(dividerBtn);
  if (cleanBtn && cleanBtn.parentElement) cleanBtn.parentElement.parentElement.insertBefore(group, cleanBtn.parentElement);
  else bar.appendChild(group);
}

/* 富文本插入表格：Quill 的 table 模块按当前光标插入，行列数由这里决定。
   复用 Markdown 侧的 8×8 网格选择器，但插入目标是 Quill。 */
let richTableTarget = null;
function openRichTablePicker() {
  richTableTarget = 'rich';
  openTablePicker();
}

function localizeRichToolbar() {
  const bar = document.querySelector('.rich-host .ql-toolbar');
  if (!bar) return;
  bar.querySelectorAll('button').forEach(btn => {
    let tip = '';
    if (btn.classList.contains('ql-list')) {
      tip = btn.value === 'ordered' ? '有序列表' : btn.value === 'check' ? '任务列表（待办）' : '无序列表';
    } else if (btn.classList.contains('ql-indent')) {
      tip = btn.value === '+1' ? '增加缩进 Tab' : '减少缩进 Shift+Tab';
    } else if (btn.classList.contains('ql-script')) {
      tip = btn.value === 'super' ? '上标' : '下标';
    } else {
      Object.keys(RICH_BUTTON_TIPS).forEach(cls => {
        if (btn.classList.contains(cls)) tip = RICH_BUTTON_TIPS[cls];
      });
    }
    if (!tip) return;
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
  });
  // 两个下拉（段落样式 / 对齐 / 颜色）都要中文提示：Quill 只在 hover 时出英文 label
  const pickerTips = [
    ['ql-header', '段落样式'],
    ['ql-align', '对齐方式'],
    ['ql-color', '文字颜色'],
    ['ql-background', '背景颜色'],
  ];
  pickerTips.forEach(([cls, tip]) => {
    const picker = bar.querySelector('.ql-picker.' + cls);
    if (!picker) return;
    const label = picker.querySelector('.ql-picker-label');
    if (label) {
      label.title = tip;
      label.setAttribute('aria-label', tip);
    }
    picker.querySelectorAll('.ql-picker-item').forEach(item => {
      const name = cls === 'ql-header' ? (RICH_HEADING_LABELS[item.dataset.value] || '正文') : tip;
      item.title = name;
      item.setAttribute('aria-label', name);
    });
  });
  /* 撤销/重做按钮：Quill 自己不加这两个按钮（只有快捷键），而 Markdown 工具栏上有。
     只认得按钮的用户在富文本里找不到撤销入口。补两个按钮接管 quill.history。 */
  if (!bar.querySelector('.ql-undo-bridge')) {
    const mk = (cls, tip, svg, act) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ql-undo-bridge ' + cls;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.innerHTML = svg;
      b.addEventListener('click', e => { e.preventDefault(); act(); });
      return b;
    };
    const undo = mk('ql-undo-btn', '撤销 Ctrl+Z',
      '<svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
      () => { if (state.rich) state.rich.history.undo(); state.rich && state.rich.focus(); });
    const redo = mk('ql-redo-btn', '重做 Ctrl+Y',
      '<svg viewBox="0 0 24 24"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>',
      () => { if (state.rich) state.rich.history.redo(); state.rich && state.rich.focus(); });
    // 插在工具栏最前面，与 Markdown 侧「撤销/重做 → 标题」的顺序一致
    bar.insertBefore(redo, bar.firstChild);
    bar.insertBefore(undo, bar.firstChild);
  }
  // 链接气泡输入框的提示文字取自 data-link 属性——Quill 每次打开气泡都会用它重设
  // placeholder，直接改 placeholder 会被覆盖，改属性才持久。
  const linkInput = document.querySelector('.rich-host .ql-tooltip input[type="text"]');
  if (linkInput) linkInput.setAttribute('data-link', '粘贴或输入链接地址');
}

/* 懒创建 Quill。工具栏是扩展过的完整格式集（见 RICH_TOOLBAR_ROWS）：
   Quill 2 核心自带表格模块，snow 主题不给按钮，这里自己接上。 */
function ensureQuill() {
  if (state.rich) return state.rich;
  initRichFormats();
  const q = new Quill('#rich-editor', {
    theme: 'snow',
    placeholder: '开始输入…',
    modules: {
      table: true,
      toolbar: { container: RICH_TOOLBAR_ROWS, handlers: { image: richImageHandler } },
    },
  });
  localizeRichToolbar();
  appendRichExtras(q);
  /* Quill 的链接气泡默认按 document.body 夹取边界，而它自己挂在 .ql-container 里，
     容器又是 overflow:hidden。选区靠左时气泡向左溢出容器，左半边直接被裁掉。
     把夹取边界收窄到容器本身，气泡就永远留在容器内。 */
  if (q.theme && q.theme.tooltip) q.theme.tooltip.boundsContainer = q.container;
  // 粘贴图片走与 Markdown 模式相同的校验与落盘路径
  q.root.addEventListener('paste', e => { richImagePaste(q, e); }, true);
  /* 链接气泡的保存按钮：Quill 原样存下输入框里的字符串，
     前后空格和缺失的协议都会写进 href，点开就是 404。
     在 Quill 的保存处理之前把值规范化好（捕获阶段先行，改的是输入框的值）。 */
  if (q.theme && q.theme.tooltip) {
    const tip = q.theme.tooltip.root;
    const input = tip.querySelector('input[data-link]');
    const fix = () => {
      if (!input) return;
      const clean = normalizeUrl(input.value);
      if (clean && clean !== input.value) input.value = clean;
    };
    tip.addEventListener('click', e => { if (e.target.closest('.ql-action')) fix(); }, true);
    if (input) {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') fix(); }, true);
      input.addEventListener('blur', fix, true);
    }
  }
  /* 删除操作单独成一步撤销。
     Quill 的历史按时间窗合并：打完一段字 1 秒内全选删除，删除会被并进打字那一组，
     合并后的条目撤不回来——用户按 Ctrl+Z 什么都回不去，而 2 秒后自动保存
     已经把空文档写盘。在删除按键到达 Quill 之前 cutoff() 截断当前批次，
     删除就成了独立的一步。
     监听 keydown 而不是 beforeinput：Quill 自己处理键盘删除时不一定先派发 beforeinput。 */
  q.root.addEventListener('keydown', e => {
    // 富文本编辑器是 contenteditable，Tab 会被当成制表符吃掉，纯键盘用户会被困在里面。
    // 与 Markdown 侧一致：Ctrl+Tab 把焦点移出去。
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const focusables = [...document.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);
      const i = focusables.indexOf(q.root);
      const next = focusables[i + 1] || focusables[0];
      if (next) next.focus();
      return;
    }
    const del = e.key === 'Backspace' || e.key === 'Delete'
      || (e.key.toLowerCase() === 'x' && (e.ctrlKey || e.metaKey));
    if (!del) return;
    if (q.history && typeof q.history.cutoff === 'function') q.history.cutoff();
  }, true);
  q.on('text-change', (delta, old, source) => {
    // 程序化装载（silent）不是用户在输入，不该把空档升级成草稿
    if (source !== 'silent') beginDraft();
    renderRichWordCount();
    scheduleAutosave();
    renderOutline();
  });
  /* 富文本滚动的章节高亮与 Markdown 侧对齐。滚动事件挂在 Quill 的滚动容器上，
     节流到 80ms（与 Markdown 侧 updateOutlineFromEditor 同节拍）。 */
  const scroller = q.root;
  scroller.addEventListener('scroll', () => {
    clearTimeout(richScrollTimer);
    richScrollTimer = setTimeout(() => {
      // 点击大纲后的程序化滚动期间不要用中间态覆盖刚点中的项
      if (Date.now() < syncLockUntil) return;
      updateRichOutlineFromScroll();
    }, 80);
  });
  state.rich = q;
  return q;
}
let richScrollTimer = null;

/* 富文本图片：落进 .assets/，DOM 里显示 data URL（WebView2 加载不到相对路径），
   保存时再由 richHtmlForSave 换回相对路径。 */
function richInsertAsset(q, rel, dataUrl) {
  state.richAssets.set(rel, dataUrl);
  const range = q.getSelection(true) || { index: q.getLength() - 1, length: 0 };
  q.insertEmbed(range.index, 'image', dataUrl, 'user');
  q.setSelection(range.index + 1, 0, 'user');
}

function richImageHandler() {
  const q = state.rich;
  if (!q) return;
  invoke('pick_image').then(async picked => {
    if (!picked) return;
    try {
      const rel = await invoke('save_asset', { dataBase64: picked.data, ext: picked.ext });
      richInsertAsset(q, rel, 'data:image/' + (picked.ext === 'jpg' ? 'jpeg' : picked.ext) + ';base64,' + picked.data);
      setStatus('已插入图片', 'ok');
    } catch (err) {
      const msg = String(err);
      setStatus(msg.includes('格式') || msg.includes('10M') ? msg : '插入图片失败：' + msg, 'error');
    }
  }).catch(err => setStatus('插入图片失败：' + err, 'error'));
}

function richImagePaste(q, e) {
  const cd = e.clipboardData;
  if (!cd) return false;
  const items = cd.items;
  if (items) {
    for (const it of items) {
      if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      e.stopPropagation();
      if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) { setStatus(IMAGE_EXT_HINT, 'error'); return true; }
      if (file.size > MAX_IMAGE_BYTES) { setStatus(IMAGE_SIZE_HINT, 'error'); return true; }
      file.arrayBuffer().then(async buf => {
        const bytes = new Uint8Array(buf);
        const ext = file.type.toLowerCase().includes('png') ? 'png' : 'jpg';
        const rel = await invoke('save_asset', { dataBase64: bytesToBase64(bytes), ext });
        richInsertAsset(q, rel, 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + bytesToBase64(bytes));
        setStatus('已粘贴图片到 ' + rel, 'ok');
      }).catch(err => setStatus('粘贴图片失败：' + err, 'error'));
      return true;
    }
  }
  // 从网页复制图文时，图片不是 file item，而是以 data URL 藏在 text/html 里。
  // 不接管的话 Quill 会原样接收，整段 base64 直接写进 .html，笔记文件迅速膨胀。
  const html = cd.getData ? cd.getData('text/html') : '';
  if (html && /<img\b[^>]*\bsrc\s*=\s*["']data:image\//i.test(html)) {
    e.preventDefault();
    e.stopPropagation();
    externalizeInlineImages(html).then(rewritten => {
      const range = q.getSelection(true) || { index: q.getLength() - 1, length: 0 };
      // 有选区时要先删掉再插入：dangerouslyPasteHTML(index, …) 只在光标处插入，
      // 不动 range.length，用户选中的文字会原地留在新内容后面。
      if (range.length) q.deleteText(range.index, range.length, 'silent');
      q.clipboard.dangerouslyPasteHTML(range.index, rewritten, 'user');
      setStatus('已粘贴内容与图片', 'ok');
    }).catch(err => {
      const msg = String(err && err.message || err);
      setStatus(msg === IMAGE_EXT_HINT || msg === IMAGE_SIZE_HINT ? msg : '粘贴图片失败：' + msg, 'error');
    });
    return true;
  }
  return false;
}

/* 把 HTML 里内联的 data URL 图片逐个落盘成 .assets/ 文件。
   返回的 HTML 仍使用 data URL（换成 .assets/ 相对路径会让 WebView2 真的发请求、必然 404），
   但同时在 state.richAssets 里登记 相对路径 -> data URL，保存时由 richHtmlForSave 反向替换。
   单张图不合规（webp/gif、超 10MB）只丢掉那张图并提示，不整体失败：
   整段粘贴连文字一起丢掉，用户看到的是"粘贴什么都没发生"，损失更大。 */
async function externalizeInlineImages(html) {
  const urls = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](data:image\/[^"']+)["']/gi)].map(m => m[1]);
  const out = new Map();   // 原始串 -> 规范化后的 data URL；值为 null 表示丢掉这张图
  const rels = [];
  let dropped = 0, tooBig = 0;
  for (const url of urls) {
    if (out.has(url)) continue;
    const m = url.match(/^data:image\/(png|jpe?g);base64,([\s\S]+)$/i);
    if (!m) { out.set(url, null); dropped++; continue; }
    const ext = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
    const base64 = m[2].replace(/\s/g, '');
    if (Math.floor(base64.length * 3 / 4) > MAX_IMAGE_BYTES) { out.set(url, null); tooBig++; continue; }
    let rel;
    try { rel = await invoke('save_asset', { dataBase64: base64, ext }); }
    catch { out.set(url, null); dropped++; continue; }
    const dataUrl = 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + base64;
    state.richAssets.set(rel, dataUrl);
    rels.push(rel);
    out.set(url, dataUrl);
  }
  // 逐张替换：丢掉的那张连同 <img> 标签一起删（它必然显示成破图）
  let rewritten = html;
  for (const [orig, norm] of out) {
    if (norm === null) {
      rewritten = rewritten.replace(new RegExp('<img\\b[^>]*src\\s*=\\s*["\']' + orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'gi'), '');
    } else {
      rewritten = rewritten.split(orig).join(norm);
    }
  }
  if (rels.length) setStatus('已粘贴 ' + rels.length + ' 张图片', 'ok');
  else if (tooBig) setStatus(IMAGE_SIZE_HINT, 'error');
  else if (dropped) setStatus(IMAGE_EXT_HINT, 'error');
  return rewritten;
}

/* 保存前：把 DOM 里的 data URL 图片换回 .assets/ 相对路径，文件里不留 base64 大块。
   全程在字符串上做替换：只要把 ".assets/x.png" 写进任何 DOM 节点的 src，
   浏览器就会真的发一个请求（离线克隆节点也一样），WebView2 里必然 404。 */
function richHtmlForSave() {
  if (!state.rich) return '';
  const clone = state.rich.root.cloneNode(true);
  clone.querySelectorAll('.ql-ui').forEach(el => el.remove());
  // 贴进来的外部 HTML 可能带 <img src="x">、blob:、相对路径——这些落盘后必然显示成破图，
  // 且没有任何补救途径。只保留两种 src：本次会话登记过（保存时换回 .assets/ 相对路径）
  // 的内联图，以及能自解析的 http(s) 远程图。其余连标签一起丢掉。
  const known = new Set(state.richAssets.values());
  clone.querySelectorAll('img').forEach(el => {
    const src = (el.getAttribute('src') || '').trim();
    if (known.has(src) || /^https?:\/\//i.test(src)) return;
    if (el.alt) el.replaceWith(clone.ownerDocument.createTextNode(el.alt));
    else el.remove();
  });
  let html = clone.innerHTML;
  for (const [rel, dataUrl] of state.richAssets) {
    if (!dataUrl) continue;
    html = html.split(dataUrl).join(rel);
  }
  return html;
}

/* 载入：把 .assets/ 相对路径换成 data URL（与预览的 enhanceImages 同一套 read_asset）。
   同样在字符串阶段替换，未命中的先塞占位像素，避免任何对 .assets/ 的真实请求。 */
const TINY_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function richLoadHtml(html) {
  const q = ensureQuill();
  state.richAssets.clear();
  const pending = [];
  // 逐个 img 标签处理：命中缓存的直接换 data URL，未命中的先占位并排队回填
  const rewritten = (html || '').replace(/<img\b[^>]*>/gi, tag => {
    const m = tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || tag.match(/\bsrc\s*=\s*'([^']*)'/i);
    if (!m) return tag;
    const rel = m[1].replace(/^\.\//, '');
    if (!/^\.?assets\//.test(rel) && !rel.startsWith('assets/')) return tag;
    const cached = assetCache.get(rel);
    if (cached) {
      state.richAssets.set(rel, cached);
      return tag.replace(m[0], 'src="' + cached + '"');
    }
    pending.push(rel);
    return tag.replace(m[0], 'src="' + TINY_PX + '" data-asset-rel="' + rel + '"');
  });
  q.setContents([], 'silent');
  q.clipboard.dangerouslyPasteHTML(rewritten, 'silent');
  q.history.clear();
  // Quill 会克隆节点，按出现顺序对齐回填
  const live = [...q.root.querySelectorAll('img[src="' + TINY_PX + '"]')];
  pending.forEach((rel, i) => {
    const target = live[i];
    invoke('read_asset', { rel }).then(url => {
      assetCache.set(rel, url);
      state.richAssets.set(rel, url);
      if (target && target.isConnected) target.src = url;
    }).catch(() => {
      if (target) target.alt = (target.alt || '') + '（图片未找到）';
    });
  });
  renderRichWordCount();
  // 富文本大纲直接读 Quill 的标题元素，必须在内容换完之后重建：
  // 不重建的话打开另一篇富文本笔记，目录还停在上篇的标题上。
  if (state.outlineOpen) renderOutline();
}

function renderRichWordCount() {
  // 从未创建过 Quill（纯 Markdown 用户）时让 Markdown 侧的字数计算负责
  if (!state.rich) return;
  const stripped = state.rich.getText().trim();
  const cjk = (stripped.match(/[一-鿿]/g) || []).length;
  const cjkPunct = (stripped.match(/[　-〿＀-￯]/g) || []).length;
  const words = (stripped.replace(/[一-鿿　-〿＀-￯]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
  $('word-count').textContent = (cjk + cjkPunct) + ' 字 · ' + words + ' 词';
  // 顶栏只放一个数：纯中文文档显示字数，纯英文文档显示词数。
  // 给英文文档显示「0 字」看起来像统计坏了，而顶栏又放不下两栏。
  $('header-word-count').textContent = (cjk + cjkPunct) ? (cjk + cjkPunct) + ' 字' : words + ' 词';
}

/* 切换编辑界面。locked 为真时不再渲染可点的类型开关，只留一个只读徽标：
   把不可逆的约束做成按钮，用户点下去只会得到一句"创建后不可更改"，是纯粹的挫败。 */
function applyKind(kind, locked) {
  state.kind = kind === 'rich' ? 'rich' : 'md';
  state.kindLocked = !!locked;
  const rich = isRich();
  const shell = $('main-shell');
  shell.classList.toggle('is-rich', rich);
  document.querySelector('.editor-block').classList.toggle('is-rich', rich);
  $('rich-host').hidden = !rich;
  $('editor-scroll').hidden = rich;
  const sw = $('kind-switch');
  sw.hidden = state.kindLocked;
  const badge = $('kind-badge');
  if (badge) {
    badge.hidden = !state.kindLocked;
    badge.textContent = rich ? '富文本' : 'Markdown';
    badge.title = '文档类型在创建时确定，落盘后不可更改';
  }
  sw.querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind));
    b.tabIndex = state.kindLocked ? -1 : 0;
    b.title = b.dataset.kind === 'rich' ? '富文本文档：所见即所得' : 'Markdown 文档：源码 + 实时预览';
  });
  // 富文本模式没有独立预览，布局强制单栏；切回时恢复用户原来的布局
  if (rich) ensureQuill();
  setLayout(rich ? 'edit' : LS.get('layout', 'both'), !rich);
  // 富文本模式固定单栏，「编辑 + 预览 / 仅预览」无从选择，视图切换置灰
  const viewBtn = $('row-view');
  if (viewBtn) {
    viewBtn.disabled = rich;
    viewBtn.title = rich ? '富文本模式固定为单栏' : '视图';
  }
  updateExportMenu();
  // 类型切换后目录要立即按新类型重建：刚切到富文本时还留着 Markdown 的
  // 「使用 # 添加章节」提示，等于给错指令。
  if (state.outlineOpen) renderOutline();
  // 「另存为富文本」只对 Markdown 笔记有意义
  const toRich = document.querySelector('#more-menu .dropdown-item[data-act="to-rich"]');
  if (toRich) toRich.hidden = rich;
}

/* 富文本笔记没有「导出 Markdown」：HTML 转 Markdown 有损，不给半截结果 */
function updateExportMenu() {
  const mdItem = document.querySelector('#export-menu .dropdown-item[data-fmt="md"]');
  if (mdItem) mdItem.hidden = isRich();
  const pngItem = document.querySelector('#export-menu .dropdown-item[data-fmt="png"]');
  if (pngItem) pngItem.hidden = isRich();
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
/* 富文本大纲：直接从 Quill 的标题元素读，点击就滚到那个元素。
   与 Markdown 侧一致：默认只列 H1–H3，末尾给「显示全部层级」切换——
   H1–H6 全列出来会把面板挤满。 */
function renderRichOutline(list) {
  const hs = state.rich ? [...state.rich.root.querySelectorAll('h1,h2,h3,h4,h5,h6')] : [];
  const all = hs.map(el => ({ el, level: +el.tagName.slice(1) }));
  const shown = outlineShowAll ? all : all.filter(h => h.level <= 3);
  shown.forEach((h, i) => {
    const btn = document.createElement('button');
    btn.className = 'outline-item level-' + h.level;
    btn.innerHTML = '<span class="outline-item-dot"></span>';
    const txt = document.createElement('span');
    txt.className = 'outline-item-text';
    txt.textContent = h.el.textContent || '';
    btn.appendChild(txt);
    btn.onclick = () => {
      lockSync(350);
      h.el.scrollIntoView({ block: 'center', behavior: 'auto' });
      setActiveOutline(i);
    };
    list.appendChild(btn);
  });
  if (!hs.length) {
    list.innerHTML = '<div class="outline-empty">暂无标题，在格式菜单里选标题样式</div>';
    return;
  }
  if (!shown.length) list.innerHTML = '<div class="outline-empty">只有 H4 以下标题</div>';
  const toggle = document.createElement('button');
  toggle.className = 'outline-item outline-toggle';
  toggle.innerHTML = '<span class="outline-item-text"></span>';
  toggle.querySelector('.outline-item-text').textContent = outlineShowAll ? '只看 H1–H3' : '显示全部层级';
  toggle.onclick = () => { outlineShowAll = !outlineShowAll; renderOutline(); };
  list.appendChild(toggle);
}

/* 富文本滚动联动：高亮当前所在的章节。
   Markdown 侧靠源码行号算，富文本没有行号，直接拿标题元素相对滚动容器的位置判断。
   索引要在「过滤后的可见标题」里算，否则「只看 H1–H3」时高亮会落到错误的行上。 */
function updateRichOutlineFromScroll() {
  if (!state.outlineOpen || !isRich() || !state.rich) return;
  const all = [...state.rich.root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  if (!all.length) return;
  const shown = outlineShowAll ? all : all.filter(h => +h.tagName.slice(1) <= 3);
  if (!shown.length) return;
  const scroller = state.rich.root;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const cur = scroller.scrollTop + 40;
  let last = 0;
  shown.forEach((el, i) => { if (el.getBoundingClientRect().top - base <= cur) last = i; });
  setActiveOutline(last);
}

function renderOutline() {
  const list = $('outline-list');
  list.innerHTML = '';
  if (isRich()) return renderRichOutline(list);
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
      // 先锁同步、再定位预览、最后滚编辑区，避免两侧锚点互相拉扯。
      // 锁只需覆盖跳转本身与紧随其后的滚动事件，太长会让用户随后手动滚动时同步失灵。
      lockSync(350);
      syncPreviewToLine(h.line);
      scrollEditorToLine(h.line);
      ta.focus();
      ta.setSelectionRange(idx, idx);
      // 聚焦与选区会触发 textarea 自身滚动，位置可能被挪走，再校正一次
      scrollEditorToLine(h.line);
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

/* 编辑区滚动时高亮当前章节：按「最后一个顶端不超过当前滚动位置的标题」判定。
   不能再用 行号 × 行高 换算滚动行：长段软换行后，同样行号对应的真实像素差很远，
   会一直高亮错章节。改为直接量高亮层里每个标题行的真实位置。 */
function updateOutlineFromEditor() {
  if (!state.outlineOpen) return;
  const hs = parseHeadings($('editor').value).filter(h => outlineShowAll || h.level <= 3);
  if (!hs.length) return;
  const scroll = $('editor-scroll');
  const cur = scroll.scrollTop + 40;
  let idx = 0;
  // 标题按行序递增，越过当前位置即可停，长文里不必每次量到底
  for (let i = 0; i < hs.length; i++) {
    const pos = hlLineTop(hs[i].line);
    if (pos === null) continue;
    if (pos <= cur) idx = i;
    else break;
  }
  setActiveOutline(idx);
}

/* ---------- 编辑/预览滚动同步 ----------
   纯百分比映射在长文里必然错位（预览有标题间距、代码块、图片，比例差异大）。
   改为标题锚点对齐：以两侧"最近的标题"为基准，把锚点标题的偏移对齐后再映射，
   没有标题可锚定时退回百分比。 */
let syncFrom = null, syncResetTimer = null;
/* 程序化跳转（大纲点击）期间的硬锁：两侧的锚点同步全部让路。
   否则预览那边被 syncPreviewToLine 滚动后触发的 syncScroll 会反向把编辑区
   按「行号 × 行高」估算重定位，刚滚好的位置被拽走。 */
let syncLockUntil = 0;
function lockSync(ms) { syncLockUntil = Date.now() + ms; }
/* 高亮层里源码第 line 行的真实像素顶端（相对滚动内容）。
   长段落软换行后，「行号 × 行高」与真实位置差很远，同步与定位都必须走真实几何。 */
function hlLineTop(line) {
  const scroll = $('editor-scroll');
  const el = $('editor-highlight').querySelectorAll('.hl-line')[line];
  if (!el) return null;
  return el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
}
function syncScroll(src, dst) {
  if (Date.now() < syncLockUntil) return;
  if (syncFrom && syncFrom !== src) return;
  syncFrom = src;
  clearTimeout(syncResetTimer);
  syncResetTimer = setTimeout(() => { syncFrom = null; }, 120);
  const srcMax = src.scrollHeight - src.clientHeight;
  if (srcMax <= 1) return;
  const toEditor = dst === $('editor-scroll');
  const hs = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  const srcLines = parseHeadings($('editor').value).slice(0, hs.length);
  if (hs.length && srcLines.length) {
    const ta = $('editor');
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const srcTop = i => {
      const t = hlLineTop(srcLines[i].line);
      return t === null ? srcLines[i].line * lineH : t;
    };
    // 编辑区侧：源码第 i 个标题的真实像素位置；预览侧：offsetTop
    const srcPos = i => toEditor ? hs[i].offsetTop : srcTop(i);
    const dstPos = i => toEditor ? srcTop(i) : hs[i].offsetTop;
    const pos = src.scrollTop + 40;
    // 找当前位置上方最近的标题；标题按行序递增，越过就停，长文里不必每次量到底
    let i = -1;
    for (let k = 0; k < srcLines.length; k++) {
      if (srcPos(k) <= pos) i = k;
      else break;
    }
    if (i >= 0) {
      /* 在两个标题之间做线性插值，而不是把当前偏移按固定系数搬过去。
         固定系数会把位置推过下一个标题，两侧显示相邻两个章节（差一章）。
         末尾没有下一个标题时按住区间起点对齐。 */
      const a = srcPos(i), b = i + 1 < srcLines.length ? srcPos(i + 1) : null;
      const da = dstPos(i), db = i + 1 < srcLines.length ? dstPos(i + 1) : null;
      if (b !== null && db !== null && b > a) {
        const r = Math.min(1, Math.max(0, (pos - a) / (b - a)));
        dst.scrollTop = Math.max(0, da + r * (db - da) - 40);
      } else {
        dst.scrollTop = Math.max(0, da + Math.max(0, pos - a) - 40);
      }
      return;
    }
  }
  // 兜底：百分比映射
  const ratio = src.scrollTop / srcMax;
  dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
}
/* 滚动位置按笔记记住：重开同一条笔记时回到上次读到的地方。
   只存内存 + localStorage，键是笔记相对路径；切换笔记/刷新都靠它恢复。 */
const SCROLL_KEY = 'mv_scrollPos';
function saveScrollPos() {
  if (isRich() || !state.current || !state.current.file_name) return;
  let map;
  try { map = JSON.parse(LS.get(SCROLL_KEY, '{}')) || {}; } catch { map = {}; }
  map[state.current.file_name] = $('editor-scroll').scrollTop;
  LS.set(SCROLL_KEY, JSON.stringify(map));
}
function restoreScrollPos() {
  if (isRich() || !state.current || !state.current.file_name) return;
  let map;
  try { map = JSON.parse(LS.get(SCROLL_KEY, '{}')) || {}; } catch { map = {}; }
  const y = map[state.current.file_name];
  // 内容可能已被外部删短，超过当前可滚高度时浏览器会自己夹到上限，无需额外判断
  if (typeof y === 'number' && y > 0) $('editor-scroll').scrollTop = y;
}

$('editor-scroll').addEventListener('scroll', () => {
  syncScroll($('editor-scroll'), $('preview'));
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(updateOutlineFromEditor, 80);
  saveScrollPos();
});
$('preview').addEventListener('scroll', () => {
  syncScroll($('preview'), $('editor-scroll'));
});

/* ---------- 保存 ---------- */
let saveTimer = null, saveMaxTimer = null;
/* 保存失败后进入持久错误态：后续成功保存前不清除，避免用户误以为一直在存 */
let saveError = '';
/* 状态点：idle（就绪）/ dirty（未保存）/ saving（保存中）/ ok（已保存）/ error（失败）/ warn（提醒）。
   五种状态各自有颜色，用户扫一眼标题右侧就知道"要不要等它"。
   warn 是"做成了，但有件事你得知道"——原来这类提示借用了 error 的红色，
   于是"Word 少了图片"和"保存失败"看起来一样严重。 */
function setStatus(t, kind) {
  const el = $('save-status');
  el.textContent = t;
  el.classList.remove('error', 'ok', 'warn');
  if (kind === 'error') el.classList.add('error');
  else if (kind === 'ok') el.classList.add('ok');
  else if (kind === 'warn') el.classList.add('warn');
  const wrap = $('save-state');
  if (wrap) {
    // 错误同时用 toast 说一遍：状态点在顶栏只有 12px，长错误会被省略号吃掉，
    // 用户看不到"哪里失败、下一步做什么"。提醒类不弹 toast，别抢注意力。
    if (kind === 'error' && t) showToast(t, null, 'error');
    const s = kind === 'error' ? 'error'
      : kind === 'warn' ? 'warn'
        : kind === 'ok' ? 'ok'
          : t === '未保存' ? 'dirty'
            : /保存中/.test(t) ? 'saving'
              : 'idle';
    wrap.dataset.state = s;
    wrap.title = s === 'error' ? (t + '（点击重试）')
      : s === 'warn' ? t
        : s === 'dirty' ? '有改动尚未落盘，约 2 秒后自动保存（点击立即保存）'
          : s === 'saving' ? '正在保存…'
            : s === 'ok' ? '已自动保存，点击立即保存'
              : '自动保存已开启，点击立即保存';
  }
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
  // 标签统一规范化：去空、去重（不区分大小写）、允许粘贴带 # 的写法
  const tags = normalizeTags($('tags-input').value.split(/[,，]/));
  const content = currentContent();
  // 新笔记落到当前选中的文件夹；已有笔记的路径以 state.current.file_name 为准。
  // 若正开着文件夹筛选，则新笔记直接落在该文件夹里（所见即所得）。
  const folder = state.current.file_name
    ? folderOfKey(state.current.file_name)
    : saveFolderForNewNote();
  try {
    const isNew = !state.current.file_name;
    const meta = await invoke('save_note', { fileName: state.current.file_name || '', title, tags, content, folder, kind: state.kind });
    state.current = meta;
    // 落盘后类型锁定：扩展名已定，强度上不允许再切
    if (!state.kindLocked) {
      applyKind(meta.kind || state.kind, true);
    }
    // 新建的笔记排到所在分组最前面（排序方式仍由用户选择，这里只写顺序表：
    // 自定义顺序下立刻生效，时间/标题排序下不影响它自己的规则）
    if (isNew && meta.file_name) prependToOrder(meta.folder || '', meta.file_name);
    // 落点已消费：清掉显式指定，避免影响下一次新建
    state.pendingNewFolder = null;
    state.dirty = false;
    LS.set('last_open', meta.file_name);
    pushRecent(meta.file_name);
    updateHeaderPath(meta);
    document.title = (title === '无标题' ? '未命名文档' : title) + ' - MarkVault';
    saveError = '';
    setStatus('已保存 ' + new Date().toLocaleTimeString(), 'ok');
    // 保存会刷新 modified：按时间排序时这一条要挪到最前，顺序由整表刷新负责。
    // 「自定义顺序」下位置只由上面的 prependToOrder 决定，但新建笔记必须整表刷新，
    // 否则它还是草稿占位行，左侧列表里看不到真正的条目。
    if (isManualOrder() && !isNew) updateRowMeta(meta);
    else await refreshList();
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('未配置') || msg.includes('NotFound')) {
      // 笔记库位置在启动时确定（exe 同级 notes，不可写则退到用户配置目录），
      // 应用内没有换库入口，所以这里只如实报出目录与原因，不提示做不到的操作。
      const vault = state.config && state.config.vault_dir ? state.config.vault_dir : '笔记文件夹';
      saveError = `笔记文件夹不可用：${vault}`;
      setStatus(saveError + '（请检查该目录是否存在且有写入权限）', 'error');
    } else {
      saveError = '保存失败：' + msg;
      setStatus(saveError, 'error');
    }
    return false;
  }
}

/* 新建的笔记插到所属分组的最前面。
   顺序表里没有的键会在 syncOrder 里被追加到末尾——那是给"外部新增/导入"准备的口径，
   但用户刚点「新建」写下的笔记出现在列表最底部，等于每次新建都要滚到底去找。
   doSave 拿到 file_name 后立刻把这一条挪到最前并落盘；排序方式为「按修改时间」时
   本来也会排在前面，这里不改动它，只是让自定义顺序同样合直觉。 */
function prependToOrder(folder, key) {
  if (!key) return;
  const f = folder || '';
  const list = orderNotes(f).filter(k => k !== key);
  list.unshift(key);
  state.order.notes[f] = list;
  persistOrder();
}

/* 新笔记的落点文件夹（唯一判定处，doSave、草稿占位行、状态栏提示共用）：
   优先「在此新建文档」显式指定的文件夹，其次文件夹筛选，最后列表里选中的文件夹。 */
function saveFolderForNewNote() {
  if (state.pendingNewFolder !== null) return state.pendingNewFolder;
  return state.folderFilter !== null ? state.folderFilter : state.activeFolder;
}

/* 顶部「新建文档」/ Ctrl+N：不带落点，按当前筛选或选中文件夹推断 */
function newNoteDefault() {
  state.pendingNewFolder = null;
  newNote();
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

/* 标签筛选：点一下加入、再点移除。多标签取交集（后端 AND），
   与搜索框的全文匹配叠加，互不顶替。 */
function toggleTagFilter(tag) {
  const t = String(tag || '').trim();
  if (!t) return;
  const i = state.tagFilter.indexOf(t);
  if (i >= 0) state.tagFilter.splice(i, 1);
  else state.tagFilter.push(t);
  state.selected.clear();
  refreshList();
}

/* 批量移动：逐篇调 move_notes，成功后清空选择。
   返回 [旧路径, 新路径] 数组，调用方（拖动排序）据此更新引用。 */
async function moveSelected(toFolder) {
  const keys = [...state.selected];
  if (!keys.length) return [];
  // 同 moveNote：保存失败即中止批量移动，避免未落盘内容丢失
  for (const k of keys) {
    if (state.current && noteKey(state.current) === k && state.dirty && !(await doSave())) {
      setStatus('保存失败，已取消移动。请检查笔记文件夹后重试。', 'error');
      return [];
    }
  }
  let pairs = [];
  try {
    pairs = await invoke('move_notes', { fileNames: keys, targetFolder: toFolder || '' });
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
    notify(`已移动 ${pairs.length} 篇到「${toFolder || '根目录'}」`);
  } catch (e) {
    setStatus('批量移动失败：' + e, 'error');
  }
  await refreshList();
  return pairs;
}

/* 列表里的时间用相对说法：今天只给时分，昨天/周几/月-日逐级降级。
   原来显示到秒（2026-10-28 18:28:00），一列里三个数字挤在一起，扫读时反而没有信息量。 */
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(iso).replace('T', ' ');
  const pad = n => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + hm;
  const diffDays = (now.getTime() - d.getTime()) / 86400000;
  if (diffDays > 0 && diffDays < 7) return '周' + '日一二三四五六'[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '-' + pad(d.getDate());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* 标签规范化：去掉首尾空白与空项，同名（不区分大小写）只留第一个。
   原来直接 split 后落盘，多打一个逗号就会存进一个空标签。 */
function normalizeTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = String(raw || '').trim().replace(/^#/, '');
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
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
  // 多选复选框：一直占位、悬停才显形，不改变文字基线。
  // 原来只有 Ctrl+点击能多选，界面上没有任何提示，等于把功能藏起来了。
  const check = document.createElement('span');
  check.className = 'nt-check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(state.selected.has(noteKey(n))));
  check.title = '选择这篇笔记';
  check.onclick = e => {
    e.stopPropagation();
    toggleSelect(noteKey(n));
    refreshSelectionUI();
  };
  info.appendChild(check);
  const nt = document.createElement('div');
  nt.className = 'nt';
  highlightText(nt, n.title, q);
  // 富文本笔记加一个类型徽标，列表里一眼能区分两种文档
  if (n.kind === 'rich') {
    const badge = document.createElement('span');
    badge.className = 'nt-kind';
    badge.textContent = '富文本';
    nt.appendChild(badge);
  }
  const nm = document.createElement('div');
  nm.className = 'nm';
  const ex = document.createElement('span');
  ex.className = 'ex';
  if (n.excerpt) highlightText(ex, n.excerpt, q);
  else ex.textContent = '';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = relTime(n.modified);
  when.title = (n.modified || '').replace('T', ' ');
  nm.appendChild(ex);
  nm.appendChild(when);
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
      s.onclick = e => {
        e.stopPropagation();
        toggleTagFilter(t);
      };
      lt.appendChild(s);
    }
    // 放进 nt-wrap：标签与标题左对齐（nt-wrap 留了复选框的缩进），
    // 直接挂 li 上会贴着行边，看起来像另一个层级的东西。
    info.appendChild(lt);
  }
  li.onclick = e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSelect(noteKey(n)); refreshSelectionUI(); return; }
    if (e.shiftKey) { e.preventDefault(); selectRangeTo(noteKey(n)); refreshSelectionUI(); return; }
    if (state.selected.size) { state.selected.clear(); refreshSelectionUI(); }
    openNote(noteKey(n));
  };
  if (state.current && noteKey(state.current) === noteKey(n)) li.classList.add('active');
  if (state.selected.has(noteKey(n))) li.classList.add('selected');
  // 拖拽：自定义 MIME 标记内部拖拽，避免把资源管理器拖入的文件误判成笔记移动。
  // 落在同一分组的行上 = 排序；落在别的分组的行上 = 移进那个分组并插到该位置。
  li.addEventListener('dragstart', e => {
    // 排序方式不是「自定义」时，拖动会静默改掉整个列表的排序规则；
    // 改成先取消这次拖动、问一句，用户确认后再拖一次。
    if (!isManualOrder()) {
      e.preventDefault();
      askManualOrder();
      return;
    }
    // 拖已选中的行时整组带走，否则只带当前行。
    // 收敛选择后必须同步 DOM 与筛选条：否则列表还显示 3 项选中、标签也写着「已选 3 项」，
    // 但 state 里只剩被拖的那一项，下一次批量操作会作用在用户没看到的集合上。
    if (!state.selected.has(noteKey(n))) {
      state.selected = new Set([noteKey(n)]);
      refreshSelectionUI();
    }
    draggingKeys = [...state.selected];
    draggingFolder = null;
    e.dataTransfer.setData(NOTE_MIME, JSON.stringify(draggingKeys));
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    draggingKeys = null;
    clearDropMarks();
  });
  li.addEventListener('dragover', e => {
    if (!draggingKeys) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const fromFolder = folderOfKey(draggingKeys[0]);
    const toFolder = n.folder || '';
    clearDropMarks($('note-list'));
    if (fromFolder === toFolder) li.classList.add(dropPosition(li, e) ? 'drop-after' : 'drop-before');
    else li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', e => {
    if (li.contains(e.relatedTarget)) return;
    li.classList.remove('drop-before', 'drop-after', 'drop-target');
  });
  li.addEventListener('drop', async e => {
    if (!draggingKeys) return;
    e.preventDefault();
    e.stopPropagation();
    const fromFolder = folderOfKey(draggingKeys[0]);
    const toFolder = n.folder || '';
    const targetKey = noteKey(n);
    const after = dropPosition(li, e);
    const keys = draggingKeys;
    draggingKeys = null;
    clearDropMarks($('note-list'));
    if (fromFolder === toFolder) {
      await reorderNotes(toFolder, keys, targetKey, after);
    } else {
      // 跨文件夹拖动：先真移动，再按落点插入目标分组的顺序
      ensureManualOrder();
      state.selected = new Set(keys);
      const pairs = await moveSelected(toFolder);
      const movedKeys = pairs.map(p => p[1]);
      if (movedKeys.length) await reorderNotes(toFolder, movedKeys, targetKey, after);
    }
  });
  return li;
}

/* 打开笔记后只需把「当前行」标出来，不必整表重建。
   原来无条件 refreshList()：哪怕列表内容一点没变，也要重新扫一遍库、重建上百个 DOM 节点，
   长列表下这一下就是明显的一次卡顿。行不在列表里（例如刚导入、被筛选掉）时才退回整表刷新。 */
function syncActiveRow(key) {
  const rows = document.querySelectorAll('#note-list li[data-file]');
  let found = false;
  rows.forEach(el => {
    const on = el.dataset.file === key;
    if (on) found = true;
    el.classList.toggle('active', on);
  });
  if (!found) refreshList();
}

/* 保存后只更新这一行的标题、时间与标签，不重建整表。
   自动保存每 2 秒就可能触发一次，每次都整表重建（重新扫库 + 重建上百个节点）
   在长列表里会持续掉帧；这三处显示才是真正变了的东西。 */
function updateRowMeta(meta) {
  const key = meta.file_name || (state.current && state.current.file_name);
  if (!key) return;
  // 搜索/文件夹筛选生效时，正文或标签一变，这行可能就不再命中。
  // 只有整表刷新才能把它移出列表，这里必须让路，否则会留下一条不该在的结果。
  if ($('search').value.trim() || state.folderFilter !== null) { refreshList(); return; }
  const li = [...document.querySelectorAll('#note-list li[data-file]')]
    .find(el => el.dataset.file === key);
  // 行不在列表里（新笔记、刚被移走）：只能整表刷新
  if (!li) { refreshList(); return; }
  const nt = li.querySelector('.nt');
  const nm = li.querySelector('.nm');
  if (nt) {
    nt.textContent = '';
    highlightText(nt, meta.title || '', '');
    if (meta.kind === 'rich') {
      const badge = document.createElement('span');
      badge.className = 'nt-kind';
      badge.textContent = '富文本';
      nt.appendChild(badge);
    }
  }
  if (nm) {
    nm.textContent = '';
    const ex = document.createElement('span');
    ex.className = 'ex';
    ex.textContent = meta.excerpt || '';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = relTime(meta.modified);
    when.title = (meta.modified || '').replace('T', ' ');
    nm.appendChild(ex);
    nm.appendChild(when);
  }
  // 标签胶囊：增删标签后行里必须立刻反映，否则要点一下别处才看得到
  const old = li.querySelector('.lt');
  if (old) old.remove();
  if ((meta.tags || []).length) {
    const lt = document.createElement('div');
    lt.className = 'lt';
    for (const t of meta.tags) {
      const s = document.createElement('span');
      s.className = 'lt-tag';
      s.textContent = t;
      s.onclick = e => { e.stopPropagation(); toggleTagFilter(t); };
      lt.appendChild(s);
    }
    const wrap = li.querySelector('.nt-wrap');
    (wrap || li).appendChild(lt);
  }
}
function syncSelectionDom() {
  document.querySelectorAll('#note-list li[data-file]').forEach(el => {
    const on = state.selected.has(el.dataset.file);
    el.classList.toggle('selected', on);
    const cb = el.querySelector('.nt-check');
    if (cb) cb.setAttribute('aria-checked', String(on));
  });
}

/* 选择状态变化后的统一收尾：行高亮、筛选条、批量操作条三处必须同步，
   否则会出现"列表显示选了 3 项、批量条写着 2 项"的错位。 */
function refreshSelectionUI() {
  syncSelectionDom();
  renderFilterBar();
  renderBatchBar();
}

/* 批量操作条：选中之后才出现，固定在侧栏底部。
   没有它的时候，用户即使碰巧用 Ctrl+点击选中了多篇，也不知道下一步能做什么。 */
function renderBatchBar() {
  const bar = $('batch-bar');
  if (!bar) return;
  const n = state.selected.size;
  bar.hidden = n === 0;
  $('batch-count').textContent = `已选 ${n} 篇`;
}

/* 搜索/筛选把当前笔记排除在外时，编辑区顶部给一句提示。
   否则左边列表没有当前行、右边还在显示这篇笔记，用户会以为筛选坏了。 */
function updateScopeNote() {
  const el = $('scope-note');
  if (!el) return;
  const q = $('search').value.trim();
  const filtering = !!(q || state.tagFilter.length || state.folderFilter !== null);
  const cur = state.current && state.current.file_name;
  const inList = !!cur && state.notes.some(n => noteKey(n) === cur);
  if (!filtering || !cur || inList) { el.hidden = true; return; }
  const title = $('doc-title').value.trim() || '当前笔记';
  $('scope-note-text').textContent = `「${title}」不在当前筛选结果中`;
  el.hidden = false;
}

/* 标签候选：把库里已有的标签喂给 input 的 datalist。
   没有候选时，同一个标签会被打出好几种写法（大小写、错别字），
   而标签一旦写错，筛选就永远对不上。 */
async function refreshTagSuggestions() {
  const list = $('tag-suggestions');
  if (!list) return;
  let tags = [];
  try { tags = await invoke('list_tags'); } catch { tags = []; }
  list.innerHTML = '';
  for (const t of tags || []) {
    const opt = document.createElement('option');
    opt.value = t;
    list.appendChild(opt);
  }
}

/* ---------- 标签管理 ----------
   候选只能降低写错的概率，已经写歪的标签需要批量治理：
   一个地方看到全部标签与篇数，改名（=合并）、删除都在这里做。 */
async function openTagManager() {
  const modal = $('tag-modal');
  modal.hidden = false;
  $('tag-modal-filter').value = '';
  await renderTagManager();
  $('tag-modal-filter').focus();
}
function closeTagManager() {
  const modal = $('tag-modal');
  if (modal) modal.hidden = true;
}

async function renderTagManager() {
  const list = $('tag-modal-list');
  if (!list) return;
  list.textContent = '';
  let counts = [];
  try { counts = await invoke('list_tag_counts'); } catch { counts = []; }
  const q = $('tag-modal-filter').value.trim().toLowerCase();
  const shown = (counts || []).filter(c => !q || String(c.name).toLowerCase().includes(q));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-empty';
    empty.textContent = (counts && counts.length)
      ? '没有匹配的标签'
      : '还没有标签：在笔记的标签框里输入即可创建';
    list.appendChild(empty);
    return;
  }
  for (const c of shown) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    const name = document.createElement('span');
    name.className = 'tag-row-name';
    name.textContent = c.name;
    name.title = c.name;
    const cnt = document.createElement('span');
    cnt.className = 'tag-row-count';
    cnt.textContent = `${c.count} 篇`;
    const rename = document.createElement('button');
    rename.textContent = '改名';
    rename.title = '改名；改成已有标签即合并';
    rename.onclick = () => renameTagFlow(c.name);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.title = '从所有笔记里移除这个标签（笔记保留）';
    del.onclick = () => deleteTagFlow(c.name);
    row.appendChild(name);
    row.appendChild(cnt);
    row.appendChild(rename);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function renameTagFlow(from) {
  const to = await promptInline('重命名标签（改成已有标签即合并）', from);
  if (!to || to === from) return;
  try {
    const n = await invoke('rename_tag', { from, to });
    notify(`已更新 ${n} 篇笔记的标签`);
    await afterTagChange();
  } catch (e) {
    notify('改名失败：' + e, 'error');
  }
}

async function deleteTagFlow(tag) {
  const ok = await invoke('confirm_dialog', {
    title: '删除标签',
    message: `从所有笔记里移除标签「${tag}」？笔记本身不会被删除。`,
    okLabel: '删除标签',
    cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    const n = await invoke('delete_tag', { tag });
    notify(`已从 ${n} 篇笔记里移除「${tag}」`);
    await afterTagChange();
  } catch (e) {
    notify('删除失败：' + e, 'error');
  }
}

/* 标签改完之后：列表、候选、当前笔记的标签框都要跟上。
   当前笔记若没未保存改动，直接重读一次元数据，避免标签框还显示旧名字。 */
async function afterTagChange() {
  await refreshList();
  refreshTagSuggestions();
  await syncCurrentTags();
  if (!$('tag-modal').hidden) await renderTagManager();
}

async function syncCurrentTags() {
  if (!state.current || !state.current.file_name || state.dirty) return;
  try {
    const n = await invoke('read_note', { fileName: state.current.file_name });
    state.current.tags = n.tags || [];
    $('tags-input').value = (n.tags || []).join(', ');
  } catch { /* 读不到就保持原样，不影响列表 */ }
}

/* 批量「移动」：在批量条上方弹一个小菜单列出文件夹。
   复用右键菜单的定位逻辑，但内容只关心目标文件夹。 */
function openBatchMoveMenu(anchor) {
  const menu = $('batch-move-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const add = (label, to) => {
    const d = document.createElement('div');
    d.className = 'dropdown-item';
    d.textContent = label;
    d.onclick = async e => {
      e.stopPropagation();
      hideBatchMoveMenu();
      await moveSelected(to);
      refreshSelectionUI();
    };
    menu.appendChild(d);
  };
  add('根目录', '');
  for (const name of (state.folders || [])) add(name, name);
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.max(6, r.top - h - 6) + 'px';
}
function hideBatchMoveMenu() {
  const menu = $('batch-move-menu');
  if (menu) menu.hidden = true;
}

/* 批量删除：一次确认，逐篇走 delete_note（进回收站），失败的跳过并汇报。 */
async function deleteSelectedFlow() {
  const keys = [...state.selected];
  if (!keys.length) return;
  const ok = await invoke('confirm_dialog', {
    title: '删除选中的笔记',
    message: `确定删除选中的 ${keys.length} 篇笔记？文件会移入 Windows 回收站。`,
    okLabel: '删除',
    cancelLabel: '取消',
  });
  if (!ok) return;
  let done = 0, failed = 0, permanent = 0;
  for (const k of keys) {
    try {
      const recycled = await invoke('delete_note', { fileName: k });
      if (recycled === false) permanent++;
      done++;
      if (state.current && state.current.file_name === k) {
        state.current = null;
        $('doc-title').value = '';
        $('tags-input').value = '';
        $('editor').value = '';
        renderHighlight();
        render('');
        renderPreviewEmptyState(true);
      }
    } catch { failed++; }
  }
  state.selected.clear();
  await refreshList();
  refreshSelectionUI();
  if (failed) notify('已删除 ' + done + ' 篇，' + failed + ' 篇失败', 'error');
  else if (permanent) notify('已删除 ' + done + ' 篇（回收站不可用，已永久删除）', 'error');
  else notify('已删除 ' + done + ' 篇，可从回收站恢复');
}

const NOTE_MIME = 'application/x-markvault-note';
/* 文件夹拖拽用独立 MIME：笔记的拖拽和文件夹的拖拽是两件事，混在一种类型里
   会让"把笔记拖进文件夹"和"把文件夹挪位置"互相误判。 */
const FOLDER_MIME = 'application/x-markvault-folder';

/* ---------- 自定义顺序（拖动排序） ---------- */
/* 顺序存在库根的 .markvault-order.json，由 Rust 端读写。结构：
   { folders: [文件夹名, …], notes: { '': [根目录笔记…], '文件夹名': [该文件夹内…] } }
   文件夹顺序始终生效；笔记顺序只在排序方式为「自定义」时生效，
   否则按修改时间/标题等排，拖动一次会自动切到自定义，避免"拖完立刻被重排回去"。 */
function orderFolders() { return state.order.folders || (state.order.folders = []); }
function orderNotes(folder) {
  if (!state.order.notes) state.order.notes = {};
  const k = folder || '';
  if (!state.order.notes[k]) state.order.notes[k] = [];
  return state.order.notes[k];
}
function isManualOrder() { return LS.get('sort', 'modified') === 'manual'; }

/* 按保存的顺序排列给定名字/笔记，未记录过的排在末尾且保持原有先后 */
function applySavedOrder(items, saved, keyOf) {
  const idx = new Map(saved.map((k, i) => [k, i]));
  // sort 是稳定排序：两边都没记录时保持传入顺序
  return items.slice().sort((a, b) => {
    const ia = idx.has(keyOf(a)) ? idx.get(keyOf(a)) : Infinity;
    const ib = idx.has(keyOf(b)) ? idx.get(keyOf(b)) : Infinity;
    return ia === ib ? 0 : (ia < ib ? -1 : 1);
  });
}

/* 与磁盘对齐：删掉已不存在的文件夹/笔记，新出现的追加到末尾。
   只在「未筛选」时清理：搜索/筛选态下列表是子集，按子集裁剪会把没显示的笔记
   从顺序表里删掉，清掉筛选后它们就都掉到末尾了。 */
function syncOrder(names, buckets, full) {
  const before = JSON.stringify(state.order);
  const live = new Set([...names].filter(Boolean));
  const fs = orderFolders().filter(n => full ? live.has(n) : true);
  for (const n of [...live]) if (!fs.includes(n)) fs.push(n);
  state.order.folders = fs;
  // 笔记顺序要覆盖根目录（键为空串）与每个文件夹——根目录不在 names 里，单独补上
  const folders = new Set(['', ...live, ...buckets.keys()]);
  for (const folder of folders) {
    const keys = (buckets.get(folder) || []).map(noteKey);
    const have = new Set(keys);
    const saved = full ? orderNotes(folder).filter(k => have.has(k)) : orderNotes(folder).slice();
    for (const k of keys) if (!saved.includes(k)) saved.push(k);
    state.order.notes[folder] = saved;
  }
  // 全量刷新时清掉已不存在的文件夹留下的桶：上面只遍历当前存在的分组，
  // 被删掉的文件夹的键永远走不到，不清就会一直留在顺序文件里越积越多。
  // 文件夹被删时其笔记已移到根目录，这些键全部失效，整桶直接丢弃。
  if (full) {
    for (const key of Object.keys(state.order.notes)) {
      if (!folders.has(key)) delete state.order.notes[key];
    }
  }
  // 有变化才落盘：每次刷新都写文件既浪费又会让磁盘时间戳乱跳
  if (JSON.stringify(state.order) !== before) persistOrder();
}

let saveOrderTimer = null, orderDirty = false, orderSavedPayload = '';
function persistOrder() {
  orderDirty = true;
  clearTimeout(saveOrderTimer);
  saveOrderTimer = setTimeout(async () => {
    if (!orderDirty) return;
    orderDirty = false;
    // 内容与上次写盘相同就不再发一次：拖一下笔记会连着走两遍刷新（移动 + 重排），
    // 两次都会触发这里，但只有一次真正改变了顺序。
    const payload = JSON.stringify(state.order);
    if (payload === orderSavedPayload) return;
    orderSavedPayload = payload;
    try { await invoke('save_order', { order: state.order }); }
    catch (e) {
      orderSavedPayload = '';
      setStatus('保存排序失败：' + e, 'error');
    }
  }, 300);
}

async function loadOrder() {
  try {
    const o = await invoke('get_order');
    if (o && typeof o === 'object') {
      state.order = { folders: Array.isArray(o.folders) ? o.folders : [], notes: o.notes || {} };
    }
  } catch { state.order = { folders: [], notes: {} }; }
}

/* 拖动排序前把排序方式切到「自定义」：否则刷新列表会按修改时间/标题重排，
   用户拖完看到位置又跳回去。返回 true 表示现在处于自定义顺序。 */
function ensureManualOrder() {
  if (isManualOrder()) return true;
  LS.set('sort', 'manual');
  const sel = $('sort-select');
  if (sel) sel.value = 'manual';
  notify('已切换为自定义顺序，可以拖动排序了');
  return true;
}

/* 非自定义排序下拖动：先解释清楚代价，确认后才切换。
   原来的做法是拖一下就静默把整个列表的排序规则改掉，用户只是想把笔记挪进文件夹。 */
async function askManualOrder() {
  const ok = await invoke('confirm_dialog', {
    title: '切换为自定义顺序？',
    message: '拖动排序需要把列表切换为「自定义」顺序，之后新增和修改不会再自动按时间排列。继续？',
    okLabel: '切换并排序',
    cancelLabel: '先不拖',
  });
  if (!ok) return;
  ensureManualOrder();
  await refreshList();
}

/* 当前 DOM 上某个分组的行顺序。拖动排序以此为基准，而不是以保存过的旧顺序为基准：
   用户可能刚在「按修改时间」下看过列表，拖的时候眼里看到的就是这个顺序。 */
function domKeysInFolder(folder) {
  return [...document.querySelectorAll('#note-list li[data-file]')]
    .filter(el => (el.dataset.folder || '') === (folder || ''))
    .map(el => el.dataset.file);
}
function domFolderNames() {
  return [...document.querySelectorAll('#note-list .folder-header')]
    .filter(el => !el.classList.contains('root-header'))
    .map(el => el.dataset.folder);
}

/* 拖动过程中记住被拖的对象：dragover 阶段浏览器不允许读 dataTransfer 的内容
   （安全限制，getData 返回空串），只能用 dragstart 时存下的内存状态判断。 */
let draggingKeys = null;
let draggingFolder = null;

function clearDropMarks(root) {
  (root || document).querySelectorAll('.drop-before, .drop-after, .drop-target').forEach(el => {
    el.classList.remove('drop-before', 'drop-after', 'drop-target');
  });
}

/* 重新排序：把 keys 移到 targetKey 之前/之后，只影响同一分组内的顺序。
   基准是已保存的顺序表本身（不按当前 DOM/筛选裁剪）：搜索或单文件夹筛选时，
   列表只是子集，拿子集当基准会把没显示的笔记挤出顺序表。缺失项在下次
   全量刷新时由 syncOrder 补齐。 */
async function reorderNotes(folder, keys, targetKey, after) {
  if (keys.includes(targetKey)) return;
  ensureManualOrder();
  const f = folder || '';
  const base = orderNotes(f).slice();
  for (const k of domKeysInFolder(f)) if (!base.includes(k)) base.push(k);
  if (!base.includes(targetKey)) base.push(targetKey);
  const moved = base.filter(k => keys.includes(k));
  if (!moved.length) return;
  const rest = base.filter(k => !keys.includes(k));
  let idx = rest.indexOf(targetKey);
  if (idx < 0) idx = rest.length;
  if (after) idx++;
  state.order.notes[f] = rest.slice(0, idx).concat(moved, rest.slice(idx));
  persistOrder();
  await refreshList();
}

async function reorderFolder(fromName, targetName, after) {
  if (fromName === targetName) return;
  // 与 reorderNotes 同理：以已保存的顺序表为基准，不拿当前 DOM 当基准——
  // 文件夹筛选生效时 DOM 里只有一部分标头，按子集重排会把其余文件夹挤出顺序表。
  const base = orderFolders().slice();
  for (const n of domFolderNames()) if (!base.includes(n)) base.push(n);
  for (const n of [fromName, targetName]) if (!base.includes(n)) base.push(n);
  const rest = base.filter(n => n !== fromName);
  let idx = rest.indexOf(targetName);
  if (idx < 0) idx = rest.length;
  if (after) idx++;
  rest.splice(idx, 0, fromName);
  state.order.folders = rest;
  persistOrder();
  notify('已调整文件夹顺序');
  await refreshList();
}

/* 落点指示：光标在上半 → 插到该行前面，下半 → 后面 */
function dropPosition(el, e) {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

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
  /* 文件夹操作收进一个「⋯」：原来三个 20px 图标要悬停才出现，
     既难命中又难分辨。点开后复用右键菜单的文件夹分组，位置跟随按钮。 */
  const more = document.createElement('button');
  more.className = 'nt-op folder-more';
  more.title = '文件夹操作';
  more.setAttribute('aria-label', '文件夹操作');
  more.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
  more.onclick = e => {
    e.stopPropagation();
    openFolderMenu(name, e.clientX, e.clientY);
  };
  ops.appendChild(more);
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
  bindFolderDrag(li, name);
  return li;
}

/* 文件夹拖动排序：拖文件夹标头可以把它挪到其他文件夹之间（根目录标头不可拖）。
   拖动文件夹时笔记拖拽的落点提示一律让路，避免两种手势互相干扰。 */
function bindFolderDrag(li, name) {
  li.draggable = true;
  li.addEventListener('dragstart', e => {
    if (!isManualOrder()) {
      e.preventDefault();
      askManualOrder();
      return;
    }
    draggingFolder = name;
    draggingKeys = null;
    e.dataTransfer.setData(FOLDER_MIME, name);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    draggingFolder = null;
    li.classList.remove('dragging');
    clearDropMarks();
  });
  li.addEventListener('dragover', e => {
    if (draggingFolder === null || draggingFolder === name) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks($('note-list'));
    li.classList.add(dropPosition(li, e) ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('dragleave', e => {
    if (li.contains(e.relatedTarget)) return;
    li.classList.remove('drop-before', 'drop-after');
  });
  li.addEventListener('drop', async e => {
    if (draggingFolder === null || draggingFolder === name) return;
    e.preventDefault();
    e.stopPropagation();
    const after = dropPosition(li, e);
    const from = draggingFolder;
    clearDropMarks($('note-list'));
    await reorderFolder(from, name, after);
  });
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
    // 先把行间插入线擦掉：移出笔记行的排序提示后落到标头上，旧提示不能留着
    clearDropMarks($('note-list'));
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
  // 一次搜索覆盖标题、正文与标签；文件夹与标签是结构化筛选，与搜索叠加，后端统一过滤。
  // 标签筛选必须走 tags 参数：塞进 query 会把"正文里恰好出现该词"的笔记也带出来。
  const args = { query: q, sort };
  if (state.folderFilter !== null) args.folder = state.folderFilter;
  if (state.tagFilter.length) args.tags = state.tagFilter.slice();
  try {
    state.notes = await invoke('search_notes', args);
  } catch {
    state.notes = await invoke('list_notes', { sort });
  }
  try { state.folders = await invoke('list_folders'); } catch { state.folders = []; }
  // 文件夹可能在资源管理器里被改名/删掉，而 activeFolder / pendingNewFolder 还指着旧名字。
  // 不复位的话，下次「新建」会把笔记写进一个已不存在的文件夹，保存时又把它重建出来——
  // 用户看到的是"删掉的文件夹自己回来了"。
  const liveFolders = new Set(state.folders || []);
  if (state.activeFolder && !liveFolders.has(state.activeFolder)) state.activeFolder = '';
  if (state.pendingNewFolder && !liveFolders.has(state.pendingNewFolder)) state.pendingNewFolder = null;
  if (state.folderFilter !== null && state.folderFilter !== '' && !liveFolders.has(state.folderFilter)) {
    state.folderFilter = null;
  }
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
  // 与磁盘对齐：删掉已不存在的项，新出现的追加到末尾。
  // 只有在没有搜索词、也没有文件夹筛选时，列表才是全量，才能安全裁剪顺序表。
  syncOrder(names, buckets, !q && state.folderFilter === null);
  // 文件夹顺序始终按保存的自定义顺序（拖动排序），与笔记的排序方式无关
  const folderNames = applySavedOrder([...names], orderFolders(), n => n);
  // 笔记顺序：自定义模式按保存的顺序，其余交给 Rust 的快照排序（同组内已有序）
  if (isManualOrder()) {
    for (const [folder, list] of buckets) buckets.set(folder, applySavedOrder(list, orderNotes(folder), noteKey));
  }
  const rootNotes = buckets.get('') || [];
  // 正在编辑但尚未落盘的新笔记：先建好占位行，空列表/有列表都要显示。
  // 落点与 doSave 保持一致，这样占位行会出现在它将来真正所属的文件夹里。
  const draftFolder = state.current && !state.current.file_name ? saveFolderForNewNote() : null;
  const draftItem = draftFolder !== null ? buildDraftItem($('doc-title').value, draftFolder) : null;
  // 搜索/筛选无命中：即便有文件夹也不该只显示一排空文件夹，那看起来像笔记全丢了
  if (!state.notes.length && (q || state.folderFilter !== null)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? '没有匹配的笔记' : '该文件夹里还没有笔记';
    if (draftItem) ul.appendChild(draftItem);
    ul.appendChild(li);
    return;
  }
  if (!state.notes.length && !folderNames.length) {
    if (draftItem) ul.appendChild(draftItem);
    else {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = q ? '没有匹配的笔记' : '点击「＋ 新建笔记」写第一篇';
      ul.appendChild(li);
    }
    return;
  }
  // 扁平排列：根标头（有文件夹时才显示）→ 根笔记 → 各文件夹（标头 + 其笔记）
  // 同组内保持 Rust 给的 modified 倒序，不重排。
  const frag = document.createDocumentFragment();
  // 目标是根目录（或目标文件夹当前不可见）时，占位行留在最上方
  if (draftItem && (!draftFolder || !folderNames.includes(draftFolder))) frag.appendChild(draftItem);
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
    // 占位行跟着它所属的文件夹走：紧跟文件夹标头，折叠时一并隐藏
    if (draftItem && draftFolder === name) {
      draftItem.classList.add('in-folder');
      draftItem.dataset.folder = name;
      draftItem.hidden = isCollapsed;
      frag.appendChild(draftItem);
    }
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
      // 行本身就是落点：同组内部=排序，跨组=移进该组并插到这个位置（见 buildNoteItem）
      frag.appendChild(el);
    }
  }
  ul.appendChild(frag);
}

/* 列表刷新的收尾：批量条、「当前笔记不在结果里」的提示、标签候选都依赖最新列表，
   统一由这个包装函数处理，避免每个 return 分支都要记得补一行。 */
const refreshListCore = refreshList;
let tagSuggestTimer = null;
refreshList = async function () {
  await refreshListCore();
  renderBatchBar();
  updateScopeNote();
  // 标签候选不必每次刷新都算：合并到一次延迟，连续保存时只发一次 IPC
  clearTimeout(tagSuggestTimer);
  tagSuggestTimer = setTimeout(refreshTagSuggestions, 800);
};

/* 草稿占位行：点「新建」后立刻可见，不再等 2 秒自动保存才出现条目。
   folder 传入落点文件夹名（'' 表示根目录），在提示里写明，避免用户不知道会存到哪。 */
function buildDraftItem(title, folder) {
  const li = document.createElement('li');
  li.className = 'draft';
  const nt = document.createElement('div');
  nt.className = 'nt';
  nt.textContent = title || '未命名文档';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = folder
    ? `编辑中…（自动保存到「${folder}」）`
    : '编辑中…（自动保存到根目录）';
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
        $('doc-title').value = title;
      }
      notify('已重命名');
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
    message: `确定删除「${n.title}」？文件会移入 Windows 回收站，需要找回时在回收站里还原。`,
    okLabel: '删除',
    cancelLabel: '取消',
  });
  if (!ok) return;
  try {
    const recycled = await invoke('delete_note', { fileName: n.file_name });
    if (state.current && state.current.file_name === n.file_name) {
      // 删掉正在编辑的笔记后回到「没有打开的笔记」：列表给空态，编辑区清空。
      // 之后只要开始输入，beginDraft() 会把它变成一个可自动保存的新草稿——
      // 不能停在「有编辑区但没有 current」的状态，那样敲的字只进内存、永不落盘。
      state.current = null;
      $('doc-title').value = '';
      $('tags-input').value = '';
      $('editor').value = '';
      if (state.rich) {
        state.richAssets.clear();
        state.rich.setContents([], 'silent');
        state.rich.history.clear();
      }
      updateHeaderPath(null);
      // 保留用户正在用的文档类型：删掉一篇富文本之后继续打字，理应还是富文本。
      // 统一切回 Markdown 会让输入落到隐藏的 textarea 里，用户看到的是"输入没反应"。
      applyKind(state.kind, false);
      if (isRich()) {
        state.rich && state.rich.setContents([], 'silent');
        state.rich && state.rich.history.clear();
        renderRichWordCount();
        renderOutline();
      } else {
        renderHighlight();
        render('');
      }
      renderPreviewEmptyState(true);
      if (!$('find-bar').hidden) closeFindBar();
      state.dirty = false;
      document.title = 'MarkVault';
    }
    // 后端在回收站不可用时（网络盘、非 Windows）会退回永久删除。
    // 确认框承诺过「可从回收站恢复」，这里必须如实纠正，否则用户以为还能找回。
    if (recycled === false) notify('已删除（回收站不可用，已永久删除，无法找回）', 'error');
    else notify('已删除，可从系统回收站恢复');
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

/* 文件夹行上的「⋯」：复用右键菜单的文件夹分组，位置贴在按钮上。
   右键菜单本身也保留，两个入口指向同一套动作。 */
function openFolderMenu(name, x, y) {
  ctxFolder = name;
  ctxTarget = null;
  const noteGroup = document.querySelector('#ctx-menu .ctx-group[data-group="note"]');
  const folderGroup = document.querySelector('#ctx-menu .ctx-group[data-group="folder"]');
  noteGroup.hidden = true;
  folderGroup.hidden = false;
  folderGroup.querySelector('[data-act="rename-folder"]').hidden = !name;
  folderGroup.querySelector('[data-act="delete-folder"]').hidden = !name;
  showCtxMenu(x, y);
}

/* 「移动到…」二级菜单：列出根目录 + 所有文件夹，标出当前所在位置。
   多选时对整组生效。 */
function buildMoveSubmenu(currentKey) {
  const sub = $('move-submenu');
  sub.innerHTML = '';
  const cur = folderOfKey(currentKey);
  // 只有「点中的这行本来就在多选集合里」才走批量；否则菜单只作用于这一行。
  const multi = state.selected.size > 1 && state.selected.has(currentKey);
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
    // 右键不再改动选择：菜单只针对点中的这一行，除非它本来就在多选集合里。
    // 原来右键会顺手把行变成「已选 1 项」，用户只是想复制一个路径，却留下了选择态。
    buildMoveSubmenu(ctxTarget);
  } else if (folderHeader) {
    ctxFolder = folderHeader.dataset.folder;
    ctxTarget = null;
    noteGroup.hidden = true;
    folderGroup.hidden = false;
    // 根目录没有文件夹名，重命名/删除对它无意义（后端也会以"非法名称"拒绝）
    const isRoot = folderHeader.classList.contains('root-header');
    folderGroup.querySelector('[data-act="rename-folder"]').hidden = isRoot;
    folderGroup.querySelector('[data-act="delete-folder"]').hidden = isRoot;
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
    refreshSelectionUI();
  }
  else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    state.selected = new Set(state.notes.map(noteKey));
    refreshSelectionUI();
  }
  else if (e.key === 'Escape' && state.selected.size) {
    e.preventDefault();
    state.selected.clear();
    refreshSelectionUI();
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
        
      } else if (act === 'copy-path') {
        if (!fileName) return;
        const path = await invoke('copy_note_path', { fileName });
        showToast('已复制路径：' + path);
        
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
  // 先落盘：否则移动后自动保存仍会按旧路径写回，看起来像复制/复活。
  // 保存失败必须中止移动，否则内存里的未保存内容会随着移动一起丢失。
  if (state.current && noteKey(state.current) === key && state.dirty && !(await doSave())) {
    setStatus('保存失败，已取消移动。请检查笔记文件夹后重试。', 'error');
    return;
  }
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
    notify('已移动到「' + (toFolder || '根目录') + '」');
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
      notify('已创建文件夹「' + name + '」');
      await refreshList();
      // 新文件夹按自定义顺序排在末尾，输入完往往在视口外；
      // 滚到它并闪一下，用户才知道"建在哪了"。
      const header = [...document.querySelectorAll('#note-list .folder-header')]
        .find(el => el.dataset.folder === name);
      if (header) {
        header.scrollIntoView({ block: 'nearest' });
        header.classList.add('just-created');
        setTimeout(() => header.classList.remove('just-created'), 1600);
      }
      return;
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

/* 在指定文件夹下新建：显式记下目标文件夹，再走常规新建流程。
   不走 activeFolder：activeFolder 会被折叠/选中操作改写，显式值更可靠。 */
function newNoteInFolder(folder) {
  state.pendingNewFolder = folder || '';
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
    // 刚在旧文件夹里点了「在此新建文档」还没保存时改名：落点跟着换，
    // 否则自动保存会按旧文件夹名重新把它建出来。
    if (state.pendingNewFolder === oldName) state.pendingNewFolder = name;
    // 正在编辑的笔记路径前缀必须跟着改，否则下次自动保存会按旧路径写回，
    // 把已改名的旧文件夹重新建出来（笔记分裂成新旧两份）。
    if (state.current && folderOfKey(state.current.file_name) === oldName) {
      state.current.file_name = name + '/' + baseNameOfKey(state.current.file_name);
      state.current.folder = name;
      LS.set('last_open', state.current.file_name);
      updateHeaderPath(state.current);
    }
    collapsedFolders.delete(oldName);
    saveCollapsed();
    // 顺序表按文件夹名做键，改名后要一起搬，否则新名字会排到末尾、旧键变成垃圾。
    // 桶里的笔记键同样要换前缀：不改的话里面全是 "旧名/xx.md"，
    // 与新列表的 "新名/xx.md" 对不上，用户先前拖好的组内顺序全部失效。
    if (state.order) {
      state.order.folders = (state.order.folders || []).map(n => (n === oldName ? name : n));
      const bucket = state.order.notes && state.order.notes[oldName];
      if (bucket) {
        state.order.notes[name] = bucket.map(k => name + '/' + baseNameOfKey(k));
        delete state.order.notes[oldName];
      }
      persistOrder();
    }
    notify('已重命名');
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
        // move_note 返回的是新相对路径字符串（不是 NoteMeta），只改路径字段，其余元数据保持
        const newKey = await invoke('move_note', { fileName: noteKey(n), targetFolder: '' });
        if (state.current && noteKey(state.current) === noteKey(n)) {
          state.current.file_name = newKey;
          state.current.folder = folderOfKey(newKey);
          LS.set('last_open', newKey);
          updateHeaderPath(state.current);
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
    // 还没保存的新笔记原本要落进来，改投根目录，避免自动保存时又把它建出来
    if (state.pendingNewFolder === name) state.pendingNewFolder = '';
    collapsedFolders.delete(name);
    saveCollapsed();
    notify('已删除文件夹');
  } catch (e) {
    // 磁盘上可能还有非 .md 文件（图片等），前端统计不到，这里解释清楚
    const msg = String(e);
    const hint = msg.includes('非空') ? msg + '（可能有图片等非笔记文件，请在资源管理器里处理）' : msg;
    setStatus('删除失败：' + hint, 'error');
  }
  await refreshList();
}

/* 轻量文本输入弹窗：WebView2 无 window.prompt，复用 link-modal 的样式约定 */
/* 把焦点限制在弹窗内。
   弹窗是 hidden 切换的普通 div，没有原生 focus trap：连按 Tab 会跑到页面上
   其它控件上，弹窗看起来还开着，用户的按键却打在了别处。 */
const trappedModals = new WeakSet();
function trapFocus(modal) {
  if (trappedModals.has(modal)) return;
  trappedModals.add(modal);
  const sel = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  modal.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const items = [...modal.querySelectorAll(sel)].filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function promptInline(title, initial) {
  return new Promise(resolve => {
    const modal = $('prompt-modal');
    modal.hidden = false;
    trapFocus(modal);
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
      // 必须 preventDefault：done() 会把焦点交回编辑器，Enter 的默认行为随后作用在
      // textarea 上，往里插一个换行——用户看到的是插入内容后面多出一行空白。
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
  });
}

/* 结构化筛选条：显示当前生效的文件夹筛选、标签筛选与多选计数，可逐个清除 */
function renderFilterBar() {
  const bar = $('filter-bar');
  bar.textContent = '';
  const chips = [];
  for (const t of state.tagFilter) {
    chips.push({ label: '#' + t, kind: 'tag', value: t });
  }
  if (state.folderFilter !== null) {
    chips.push({ label: '文件夹: ' + (state.folderFilter || '根目录'), kind: 'folder', value: state.folderFilter });
  }
  if (!chips.length) { bar.hidden = true; return; }
  bar.hidden = false;
  for (const c of chips) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip' + (c.kind === 'sel' ? ' is-sel' : '') + (c.kind === 'tag' ? ' is-tag' : '');
    chip.textContent = c.label;
    if (c.kind === 'sel') {
      chip.title = '清空选择';
      chip.onclick = () => { state.selected.clear(); refreshList(); };
    } else if (c.kind === 'tag') {
      chip.title = '点击移除该标签筛选';
      chip.onclick = () => toggleTagFilter(c.value);
    } else {
      chip.title = '点击清除该筛选';
      chip.onclick = () => {
        state.folderFilter = null;
        refreshList();
      };
    }
    bar.appendChild(chip);
  }
}

/* 当前笔记的相对路径不再占顶栏，改为「更多」菜单里的一项：
   路径是低频的排查信息，放在菜单里既能看到，也不跟标题抢位置。未落盘的新笔记禁用该项。 */
function updateHeaderPath(note) {
  const item = document.querySelector('#more-menu .dropdown-item[data-act="reveal"]');
  const hint = $('more-path');
  const has = !!(note && note.file_name);
  if (item) {
    item.hidden = !has;
    item.title = has ? '在资源管理器中显示：' + note.file_name : '';
  }
  if (hint) hint.textContent = has ? note.file_name : '';
}

/* 首次运行引导：写进 localStorage，看完或手动关掉后不再自动出现。
   force=true 时从「更多 → 使用帮助」重新打开。
   卡片不再压暗全屏：写笔记的人不需要为一页说明先点一次"知道了"。 */
function maybeShowFirstRun(force) {
  if (!force && LS.get('first_run', '')) return;
  if (document.querySelector('.first-run')) return;
  const tip = document.createElement('div');
  tip.className = 'first-run';
  tip.innerHTML = '<div class="first-run-card">' +
    '<button type="button" class="first-run-close" title="关闭" aria-label="关闭">✕</button>' +
    '<div class="first-run-title">MarkVault 可以这样用</div>' +
    '<ol class="first-run-steps">' +
    '<li>点左上角「＋ 新建笔记」，或在它的下拉里新建文件夹</li>' +
    '<li>标题写完按 Enter 直接进正文；内容自动保存</li>' +
    '<li>点列表里的标签就按标签筛选；点行首复选框可多选</li>' +
    '<li>「⋯ → 导入本地文档」会把文件复制进笔记库</li>' +
    '</ol>' +
    '<div class="first-run-keys">Ctrl N 新建 · Ctrl F 查找 · Ctrl Alt E 回正文 · F6 收/展列表</div>' +
    '<button type="button" class="first-run-ok primary">开始写</button>' +
    '</div>';
  const close = () => {
    LS.set('first_run', '1');
    tip.remove();
  };
  tip.querySelector('.first-run-ok').onclick = close;
  tip.querySelector('.first-run-close').onclick = close;
  document.body.appendChild(tip);
}
function showHelp(force) {
  maybeShowFirstRun(force !== false);
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

/* ---------- 最近打开的笔记（Ctrl+Tab） ----------
   一次只能开一篇是刻意的（单文档模型，不存在多文档状态同步问题），
   但"在会议记录和周报之间来回切"是每天都会发生的事：每次都要回列表里找。
   这里存最近 5 篇，Ctrl+Tab 在已保存的笔记之间轮换；切换仍然走 openNote，
   该保存的保存、该恢复的恢复，不引入第二套文档生命周期。
   未保存的新草稿不参与：切走它等于让它落盘，与"轮换"的预期不符。 */
const RECENT_KEY = 'recent';
const RECENT_MAX = 5;
function recentList() {
  let list;
  try { list = JSON.parse(LS.get(RECENT_KEY, '[]')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  // 只保留库里还存在的笔记：外部删除/改名后不该还留在轮换里
  return list.filter(k => typeof k === 'string' && state.notes.some(n => noteKey(n) === k));
}
function pushRecent(key) {
  if (!key) return;
  const list = recentList().filter(k => k !== key);
  list.unshift(key);
  LS.set(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}
function recentOthers() {
  const cur = state.current ? noteKey(state.current) : '';
  return recentList().filter(k => k !== cur);
}
async function openRecentMenu(anchor) {
  const others = recentOthers();
  if (!others.length) { notify('还没有可切换的最近笔记', 'error'); return; }
  const menu = $('recent-menu');
  if (!menu) { await openNote(others[0]); return; }
  menu.innerHTML = '';
  // 列最近几篇，而不是"按一下换一篇"：换到哪一篇应当是用户挑的。
  // 每行给标题 + 所在文件夹，同名笔记（周报）在不同文件夹里也能分清。
  others.slice(0, 5).forEach(key => {
    const meta = state.notes.find(n => noteKey(n) === key);
    const d = document.createElement('div');
    d.className = 'dropdown-item recent-item';
    const t = document.createElement('span');
    t.className = 'recent-title';
    t.textContent = (meta && meta.title) || key.replace(/\.(md|html)$/i, '');
    d.appendChild(t);
    const folder = folderOfKey(key);
    if (folder) {
      const h = document.createElement('span');
      h.className = 'df-hint';
      h.textContent = folder;
      d.appendChild(h);
    }
    d.onclick = async e => {
      e.stopPropagation();
      hideRecentMenu();
      await openNote(key);
    };
    menu.appendChild(d);
  });
  const btn = anchor || $('btn-tb-more') || $('btn-more');
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - h - 6) + 'px';
}
function hideRecentMenu() {
  const menu = $('recent-menu');
  if (menu) menu.hidden = true;
}
/* Ctrl+Tab / Ctrl+Shift+Tab：在最近列表里前后轮换。
   Shift 方向要按"最近顺序"反着走，否则两篇笔记之间来回按会在原地打转。 */
async function cycleRecent(back) {
  const list = recentList();
  const cur = state.current ? noteKey(state.current) : '';
  if (list.length < 2) { notify('还没打开过其他笔记', 'error'); return; }
  const i = list.indexOf(cur);
  let next;
  if (i < 0) next = back ? list[list.length - 1] : list[0];
  // list 是"最近在前"：当前(0) 的下一项就是上一篇，Ctrl+Tab 往后走一格
  else next = list[(i + (back ? -1 : 1) + list.length) % list.length];
  if (next === cur) return;
  await openNote(next);
}

/* ---------- 打开/新建 ---------- */
async function openNote(fileName) {
  if (state.current && state.current.file_name === fileName && !state.dirty) return;
  // 保存失败必须中止切换：state.dirty 是内存里唯一副本，覆盖 state.current 等于丢弃它
  if (state.dirty && !(await doSave())) {
    setStatus('保存失败，已取消打开。请检查笔记文件夹后重试。', 'error');
    return;
  }
  let note;
  try {
    note = await invoke('read_note', { fileName });
  } catch (e) {
    setStatus('读取失败：' + e, 'error');
    return;
  }
  state.current = note;
  $('doc-title').value = note.title;
  $('tags-input').value = (note.tags || []).join(', ');
  // 类型由后端按扩展名推出；打开已有笔记时一律锁定
  if (note.kind === 'rich') {
    applyKind('rich', true);
    richLoadHtml(note.content);
    // 另一侧编辑器（隐藏的 textarea + 预览）还留着上一篇 Markdown：
    // 不清的话它只是暂时看不见，删掉/切换笔记后旧正文会被当成"当前文档"的一部分
    // （导出、字数、查找都可能读到它）。
    $('editor').value = '';
    renderHighlight();
    render('');
    // render('') 会把字数按 Markdown 口径写成 0；富文本要重新按 Quill 正文算一遍
    renderRichWordCount();
  } else {
    applyKind('md', true);
    $('editor').value = note.content;
    renderHighlight();
    render(note.content);
    // 同理：富文本编辑器里还留着上一篇的 DOM，清掉并清撤销栈，
    // 否则在新开的 Markdown 笔记里切回富文本会看到上一篇的内容。
    if (state.rich) {
      state.rich.setContents([], 'silent');
      state.rich.history.clear();
      state.richAssets.clear();
    }
  }
  updateHeaderPath(note);
  state.dirty = false;
  // 换了正文：滚动位置按这篇笔记上次读到的地方恢复（没有记录就是文首）。
  // 不按笔记记的话，上一篇的 scrollTop 会直接落到新笔记上，看到的是文中一段而不是开头。
  $('editor-scroll').scrollTop = 0;
  if (state.rich) { const sc = document.querySelector('#rich-editor .ql-editor'); if (sc) sc.scrollTop = 0; }
  else restoreScrollPos();
  // 查找栏只对 Markdown 源码有意义：切到富文本时它既搜不到东西（正文在 Quill 里），
  // 又会保留上一篇的命中计数，看上去像在搜当前文档。直接关掉。
  if (!$('find-bar').hidden && isRich()) closeFindBar();
  else if (!$('find-bar').hidden) { findIdx = -1; runFind(); }
  LS.set('last_open', fileName);
  document.title = (note.title === '无标题' ? '未命名文档' : note.title) + ' - MarkVault';
  // 保存失败的错误态优先级高于"就绪"，不能被打开笔记的动作抹掉
  if (saveError) setStatus(saveError, 'error'); else setStatus('就绪');
  // 只切当前行的高亮，不重建整表：点一下笔记就重新扫库 + 重建全部行，
  // 在长列表里这本身就是一次可见的卡顿，而列表内容其实一个字都没变。
  syncActiveRow(fileName);
  // 点开笔记后直接接管输入：否则焦点还停在列表行上，用户接着敲字什么都打不进去。
  // 仅预览布局下编辑区不可见，此时不抢焦点。
  if (state.layout !== 'preview') focusEditor({ preventScroll: true });
  pushRecent(fileName);
}

/* 新建笔记：先问格式。
   两种格式落盘成不同扩展名（.md / .html），且**创建后不可更改**，
   所以选择必须发生在建文档之前，而不是建好之后再去点标签行那个开关——
   那个开关用户根本不知道存在，多半在写完正文才发现选错了类型。 */
let newNoteKindResolve = null;

function newNoteKindModal() {
  return new Promise(resolve => {
    const modal = $('new-note-modal');
    const opts = [...modal.querySelectorAll('.new-note-option')];
    const okBtn = $('new-note-ok');
    // 默认选中上次用过的类型（首次 Markdown）：重复新建同类型笔记时只需一次回车。
    const lastKind = LS.get('kind', 'md') === 'rich' ? 'rich' : 'md';
    let picked = lastKind;
    // 顶部提示带上落点：用户在「文件夹 → 在此新建文档」里点时也能确认会存到哪
    const hint = modal.querySelector('.new-note-desc');
    if (hint) {
      const where = saveFolderForNewNote();
      hint.textContent = '选择这篇笔记的格式。类型在创建时确定，保存后不能更改。'
        + (where ? '将保存到「' + where + '」。' : '将保存到根目录。');
    }
    const paint = () => opts.forEach(b => {
      const on = b.dataset.kind === picked;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      // 「上次使用」角标只挂在默认项（= 上次用过的类型）上；用户改选后不跟着跑，
      // 否则它描述的就不是"上次"，而成了"当前选中"的同义词。
      const tag = b.querySelector('[data-default-tag]');
      if (tag) tag.hidden = b.dataset.kind !== lastKind;
    });
    const pick = kind => {
      picked = kind;
      paint();
      if (okBtn) okBtn.textContent = '创建' + (kind === 'rich' ? '富文本' : 'Markdown') + '笔记';
    };
    paint();
    if (okBtn) okBtn.textContent = '创建' + (picked === 'rich' ? '富文本' : 'Markdown') + '笔记';
    newNoteKindResolve = resolve;
    modal.hidden = false;
    trapFocus(modal);
    const done = ok => {
      if (!newNoteKindResolve) return;
      newNoteKindResolve = null;
      modal.hidden = true;
      document.removeEventListener('keydown', esc, true);
      resolve(ok ? picked : '');
    };
    const esc = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', esc, true);
    modal.onclick = e => { if (e.target === modal) done(false); };
    opts.forEach(b => {
      b.onclick = () => pick(b.dataset.kind);
      // 双击直接创建：鼠标用户不必点一次选项再移到右下角点「创建」
      b.ondblclick = () => { pick(b.dataset.kind); done(true); };
      // 方向键在单选项之间移动（radiogroup 的键盘约定），Enter 直接创建
      b.onkeydown = e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          pick(picked === 'md' ? 'rich' : 'md');
          const next = opts.find(o => o.dataset.kind === picked);
          if (next) next.focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        }
      };
    });
    $('new-note-cancel').onclick = () => done(false);
    okBtn.onclick = () => done(true);
    // 焦点落在当前选中项上：默认值可见，且 Tab 顺序从选项开始
    const cur = opts.find(o => o.dataset.kind === picked);
    if (cur) cur.focus();
  });
}

async function newNote() {
  // 同 openNote：保存失败不得清空编辑区，否则未落盘内容直接丢失
  if (state.dirty && !(await doSave())) {
    setStatus('保存失败，已取消新建。请检查笔记文件夹后重试。', 'error');
    return;
  }
  const kind = await newNoteKindModal();
  // 取消：保持当前文档原样。之前已经保存过草稿的话，这里什么都不该变。
  // 同时清掉「在此新建文档」留下的显式落点，否则下次点普通「新建」会莫名落进那个文件夹。
  if (!kind) {
    state.pendingNewFolder = null;
    if (state.layout !== 'preview') focusEditor({ preventScroll: true });
    return;
  }
  LS.set('kind', kind);
  state.current = { file_name: '' };
  $('doc-title').value = '';
  $('tags-input').value = '';
  // 新笔记：类型由弹窗决定，落盘前锁定开关仍可再切（切了会清空正文）
  applyKind(kind, false);
  // 两个编辑器都清空：弹窗里可能选的是另一种格式，另一侧编辑器里还留着上一篇的 DOM。
  // 不清的话它只是被隐藏着，一旦用户在新笔记里切回那个类型，旧正文会整段复活。
  if (state.rich) {
    state.rich.setContents([], 'silent');
    state.rich.history.clear();
    state.richAssets.clear();
  }
  $('editor').value = '';
  renderHighlight();
  render('');
  if (isRich()) renderRichWordCount();
  updateHeaderPath(null);
  state.dirty = false;
  document.title = '未命名文档 - MarkVault';
  // 明确告知新笔记会落到哪，避免用户以为"点了新建却什么都没发生"；
  // 左栏同时插入占位条，让"已创建"立刻可见。
  const where = saveFolderForNewNote() || '根目录';
  await refreshList();
  setStatus('新笔记将保存到「' + where + '」', 'ok');
  $('doc-title').focus();
}

/* ---------- 视图模式 ---------- */
function setLayout(mode, persist) {
  state.layout = mode;
  // persist=false 用于富文本模式强制单栏：不覆盖用户原来的布局偏好
  if (persist !== false) LS.set('layout', mode);
  const shell = $('main-shell');
  shell.classList.remove('layout-both', 'layout-edit', 'layout-preview');
  shell.classList.add('layout-' + mode);
  document.querySelectorAll('#view-menu-row .dropdown-item, #view-menu-prow .dropdown-item').forEach(el => {
    el.style.color = el.dataset.view === mode ? 'var(--accent)' : '';
    el.style.fontWeight = el.dataset.view === mode ? '600' : '';
  });
  // 仅编辑模式下不再实时渲染预览；切回带预览的布局时要补一次，否则面板是旧的
  if (!isRich() && mode !== 'edit' && previewSrc !== $('editor').value) render($('editor').value);
}

/* ---------- 分隔条拖动 ---------- */
(function initResizer() {
  const resizer = $('resizer');
  const main = $('main-shell');
  let dragging = false;
  const saved = parseFloat(LS.get('editorWidth', ''));
  // userWidth = 用户自己拖出来的宽度；窗口放不下时临时让位，放得下再还回去。
  // 之前是"放不下就夹到 max 并写死"，于是窄窗口拉一次、再拉宽，编辑区就永久停在
  // 那个被夹小的值上，预览被撑到只剩 320px——布局看着像坏了。
  let userWidth = saved > 0 ? saved : 0;
  const applyWidth = w => { main.querySelector('.editor-block').style.flex = `0 0 ${w}px`; };
  const clearWidth = () => { main.querySelector('.editor-block').style.flex = ''; };
  // 预览区有自己的 min-width（320px），编辑区宽度上限必须把这段和两侧 gap 扣掉，
  // 否则拉到最右时预览被挤出 main 之外，右侧内容直接被裁掉看不见。
  const maxFor = () => {
    const rect = main.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(main).columnGap) || 0;
    const resizerW = resizer.getBoundingClientRect().width || 0;
    // main 的三个子元素之间有两个 gap，先扣掉它们再扣预览自己的 320px，否则会多出几像素
    return Math.max(240, rect.width - 320 - gap * 2 - resizerW);
  };
  const fitWidth = () => {
    // 单栏（只编辑/只预览/富文本）时没有第二栏要照顾，不做任何固定宽度
    if (!$('main-shell').classList.contains('layout-both')) { clearWidth(); return; }
    if (!userWidth) return;
    if (userWidth <= maxFor()) applyWidth(userWidth);
    else clearWidth();
  };
  resizer.addEventListener('mousedown', e => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    // 开始拖时先把当前实际宽度固化成起点，避免从"自适应"跳到鼠标位置
    userWidth = main.querySelector('.editor-block').getBoundingClientRect().width;
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const w = Math.min(Math.max(e.clientX - rect.left, 240), maxFor());
    applyWidth(w);
  });
  // 窗口宽度变化：只决定"用不用得上这个宽度"，不改写用户的记录值
  window.addEventListener('resize', fitWidth);
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    const w = main.querySelector('.editor-block').getBoundingClientRect().width;
    if (w) { userWidth = Math.round(w); LS.set('editorWidth', String(userWidth)); }
  });
  // 切布局（双栏↔单栏）后重新判断一次：从单栏切回双栏要把宽度还上
  document.querySelectorAll('#view-menu-row .dropdown-item, #view-menu-prow .dropdown-item')
    .forEach(el => el.addEventListener('click', () => setTimeout(fitWidth, 0)));
  fitWidth();
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
    // 空菜单不开：里面的项是 toolbarToMenu 按宽度搬进来的，窄窗口下一个都没搬
    // 也会露出「更多格式」按钮，点开就是一块空白（div 没有子节点，高度只剩 padding）。
    // 宁可什么都不发生，也不要弹一个空框。
    if (!m.children.length) { closeAllMenus(); return; }
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

/* 同行内找包围选区的一对定界符（跳过行内 code，`**` 非重叠扫描）。
   raw=true 时不做行内 code 屏蔽——反引号自身就是目标定界符，屏蔽掉就永远找不到。 */
function findEnclosingDelimPair(line, selStart, selEnd, delim, raw) {
  const len = delim.length;
  const masked = raw ? line : maskInlineCode(line);
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
function resolveDelimUnwrapRange(text, start, end, delim, raw) {
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
  const pair = findEnclosingDelimPair(line, start - lineStart, end - lineStart, delim, raw);
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
/* 行内代码：开关语义。普通 toggleDelimitedInline 会先 maskInlineCode 把 `code` 区域涂成空格，
   反引号自身就被涂掉、永远找不到定界符，所以这里直接扫反引号。 */
function formatInlineCode() {
  const ta = $('editor');
  const text = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
  const r = resolveDelimUnwrapRange(text, start, end, '`', true);
  if (r) {
    const inner = text.slice(r.cS, r.cE);
    applyEdit(r.oS, r.oE, inner, r.oS, r.oS + inner.length);
    return;
  }
  wrapSel('`', '`', '代码', /^`+$/);
}

/* 把 [s, e) 向外扩到整行边界。
   引用、列表、代码块都是块级标记，只对整行生效：选区落在行中间时按原样插入会得到
   `hello - world`、`abc``` ` 这类不生效的 Markdown，预览里仍是普通段落。 */
function expandToLines(s, e) {
  const v = $('editor').value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  // 选区正好停在下一行行首（末字符是换行）时，那一行并没有被选中，不该算进本次操作：
  // 否则「选到 bbb 末尾」会把 ccc 也一起加上前缀。
  if (e > lineStart && v[e - 1] === '\n') return [lineStart, e - 1];
  const nl = v.indexOf('\n', e);
  return [lineStart, nl === -1 ? v.length : nl];
}

/* 引用：整行加 '> '；整段已全部引用时剥掉一层（再点一次取消）；空行插入占位 */
function formatQuote() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const [rs, re] = expandToLines(s, e);
  const raw = v.slice(rs, re);
  const lines = raw.split('\n');
  // 全部非空行都已带 '> ' 时按开关语义剥一层，避免反复点击叠成 '> > >'
  const quoted = lines.filter(l => l.trim());
  if (quoted.length && quoted.every(l => /^\s*>/.test(l))) {
    const out = lines.map(l => l.replace(/^(\s*)>\s?/, '$1')).join('\n');
    applyEdit(rs, re, out, rs, rs + out.length);
    return;
  }
  const sel = raw || '引用';
  // 部分行已引用时只给未引用的行补 '> '，否则会叠成 '> > ' 双重引用
  const out = sel.split('\n').map(l => (/^\s*>/.test(l) ? l : '> ' + l)).join('\n');
  applyEdit(rs, re, out, rs, rs + out.length);
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
    // 选区落在行中间时扩到整行：`- ` 前缀插在行首才生效，插在行中只是普通文字
    [rs, re] = expandToLines(s, e);
    content = v.slice(rs, re);
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
    // 圆形有序列表输出块级 <ol>，同样必须整行替换，否则 HTML 混在段落中间不渲染
    [rs, re] = expandToLines(s, e);
    content = v.slice(rs, re);
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
    // 标题行转成列表项时也要去掉 # 前缀，否则输出 <li>### 标题</li>
    body = body.replace(/^#{1,6}\s*/, '');
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
  // 围栏内的行是代码，加 '#' 只会变成代码内容里的一行井号，预览不会出标题
  if (inFenceAt(v, s)) { setStatus('代码块内不能插入标题', 'error'); ta.focus(); return; }
  const out = '#'.repeat(level) + ' ' + cur.replace(/^#{0,6}\s*/, '');
  applyEdit(lineStart, lineEnd, out, lineStart + out.length, lineStart + out.length);
}

/* 判断 position 是否落在 ``` 围栏内部（含围栏行本身） */
function inFenceAt(v, position) {
  let open = false;
  for (const line of v.slice(0, position).split('\n')) {
    if (/^\s*```/.test(line)) open = !open;
  }
  return open || /^\s*```/.test(v.slice(v.lastIndexOf('\n', position - 1) + 1));
}

/* 代码块：选中内容包进 ``` 围栏，无选区时用占位，插入后全选。
   围栏是块级标记，必须独占整行：插在行中间会变成 `abc``` ` 这种行内代码，不渲染成代码块。 */
function insertCodeBlock() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const [rs, re] = expandToLines(s, e);
  let sel = v.slice(rs, re);
  if (!sel.trim() || /^`+$/.test(sel)) sel = '代码';
  const ins = '```\n' + sel + '\n```';
  applyEdit(rs, re, ins, rs, rs + ins.length);
}

/* 链接：Tauri WebView2 不支持 prompt()，用内置弹窗输入 URL */
/* 链接地址归一化：去掉首尾空白；没有协议就补 https://。
   不补的话 `example.com/x` 会被浏览器当成相对路径，点开跳到
   `http://tauri.localhost/example.com/x`，用户看到 404。 */
function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  // 已经是完整协议（含 mailto: / tel: 这类无 // 的）就原样保留
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  // 以 // 开头的协议相对地址，按 https 补全
  if (s.startsWith('//')) return 'https:' + s;
  return 'https://' + s;
}

function insertLink() {
  const ta = $('editor');
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || '链接';
  openLinkPrompt(url => {
    const clean = normalizeUrl(url);
    if (!clean) { $('editor').focus(); return; }
    const ins = '[' + sel + '](' + clean + ')';
    applyEdit(s, e, ins, s + ins.length, s + ins.length);
  });
}

function openLinkPrompt(cb) {
  const modal = $('link-modal');
  const input = $('link-url');
  modal.hidden = false;
  trapFocus(modal);
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
    // 同 promptInline：不拦住默认行为，Enter 会在交回焦点的编辑器里插入换行
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  };
}

/* 表格：8×8 网格拖选行列（P2）。弹一个「行 x 列」的输入框，用户得先在脑子里
   算好行列再打字，还要记住 3x4 这种格式——一次插入表格要停下来想两件事。
   网格是所见即所得：鼠标划过就显示「3 × 4」，点一下即插入。 */
const TABLE_GRID_MAX = 8;
let tableGridRows = 3, tableGridCols = 3;

function buildTableGrid() {
  const grid = $('table-grid');
  if (!grid || grid.children.length) return;
  for (let r = 1; r <= TABLE_GRID_MAX; r++) {
    for (let c = 1; c <= TABLE_GRID_MAX; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'table-cell';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.setAttribute('aria-label', `${r} 行 ${c} 列`);
      grid.appendChild(cell);
    }
  }
  grid.addEventListener('mouseover', e => {
    const cell = e.target.closest('.table-cell');
    if (cell) paintTableGrid(+cell.dataset.r, +cell.dataset.c, false);
  });
  grid.addEventListener('click', e => {
    const cell = e.target.closest('.table-cell');
    if (!cell) return;
    paintTableGrid(+cell.dataset.r, +cell.dataset.c, false);
    insertTable(tableGridRows, tableGridCols);
    closeTablePicker();
  });
  grid.addEventListener('keydown', e => {
    // 方向键移动选择，Enter 落定：网格是 64 个按钮，纯键盘也走得通
    const dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dr || dc) {
      e.preventDefault();
      paintTableGrid(
        Math.max(1, Math.min(TABLE_GRID_MAX, tableGridRows + dr)),
        Math.max(1, Math.min(TABLE_GRID_MAX, tableGridCols + dc)), true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertTable(tableGridRows, tableGridCols);
      closeTablePicker();
    }
  });
}
/* highlight=true 时把单元格标成"选中"并给出焦点，用于键盘操作 */
function paintTableGrid(r, c, focus) {
  tableGridRows = r; tableGridCols = c;
  const grid = $('table-grid');
  grid.querySelectorAll('.table-cell').forEach(cell => {
    const on = +cell.dataset.r <= r && +cell.dataset.c <= c;
    cell.classList.toggle('on', on);
    cell.tabIndex = (+cell.dataset.r === r && +cell.dataset.c === c) ? 0 : -1;
  });
  $('table-grid-label').textContent = `${r} × ${c}`;
  if (focus) {
    const cell = grid.querySelector(`.table-cell[data-r="${r}"][data-c="${c}"]`);
    if (cell) cell.focus();
  }
}
function openTablePicker() {
  buildTableGrid();
  paintTableGrid(3, 3, false);
  $('table-modal').hidden = false;
  trapFocus($('table-modal'));
  // 网格本身接管键盘，焦点放在当前格上而不是「插入」按钮
  const cell = $('table-grid').querySelector('.table-cell[data-r="3"][data-c="3"]');
  if (cell) cell.focus();
}
function closeTablePicker() {
  const target = richTableTarget;
  richTableTarget = null;
  // 先交回焦点再隐藏弹窗：焦点先在弹窗内的按钮上，隐藏后焦点落到 body，
  // 后续按键（尤其是 Esc / Tab）会打到整页而不是编辑器。
  if (target === 'rich') {
    const el = document.querySelector('#rich-editor .ql-editor');
    if (el) el.focus({ preventScroll: true });
  } else if ($('editor') && state.layout !== 'preview') {
    focusEditor({ preventScroll: true });
  }
  $('table-modal').hidden = true;
}

/* 生成对齐好的 Markdown 管道表骨架，插到光标处。
   富文本模式走 Quill 的 table 模块：它按块插入带边框的真表格，
   而不是把管道符写进 HTML 里（那在富文本里就是一段带竖线的普通文字）。 */
function insertTable(rows, cols) {
  rows = Math.max(1, Math.min(30, rows || 3));
  cols = Math.max(1, Math.min(12, cols || 3));
  if (isRich()) {
    insertRichTable(rows, cols);
    return;
  }
  const head = '| ' + Array.from({ length: cols }, (_, i) => '列' + (i + 1)).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: Math.max(0, rows - 1) }, () =>
    '| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |');
  const table = [head, sep, ...body].join('\n');
  const ta = $('editor');
  // 表格是独立块，不能覆盖已选文字：把插入点收敛到选区末尾，正文原样保留
  const s = ta.selectionEnd, v = ta.value;
  const before = v.slice(0, s);
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  const after = v.slice(s);
  const trail = after.length === 0 || after.startsWith('\n') ? '\n' : '\n\n';
  applyEdit(s, s, lead + table + trail, s + lead.length + 2, s + lead.length + 2);
  setStatus(`已插入 ${rows} × ${cols} 表格`, 'ok');
}

/* 富文本插入表格：Quill 的 table 模块按当前选区插入。
   网格选择器上限 8 列，这里仍按 30 行 / 12 列兜底，与 Markdown 侧同一套参数。 */
function insertRichTable(rows, cols) {
  const q = state.rich;
  if (!q) return;
  const table = q.getModule('table');
  if (!table) { setStatus('表格模块未加载，无法插入表格', 'error'); return; }
  // 表格是块级结构，插在行内会把当前段落截断：先确保光标在一个空段落里
  const range = q.getSelection(true);
  if (!range) { q.focus(); return; }
  if (range.length) q.deleteText(range.index, range.length, 'user');
  table.insertTable(rows, cols);
  q.focus();
  setStatus(`已插入 ${rows} × ${cols} 表格`, 'ok');
}

/* ---------- 预览里的表格操作（P2）----------
   插完表格没法改行列，只能回源码里一行一行数竖线——这是最初走查里被点名的坑。
   现在把光标放进表格，预览浮出「＋行/＋列/−行/−列/删除表格」。
   表格定位：预览的 table 顺序 ↔ 源码里的管道表块顺序，与任务勾选同一套对齐思路。 */
function tableBlocksOf(src) {
  const lines = src.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    // 表格块 = 连续一行以上以 | 开头，且第二行是分隔行
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const start = i;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++;
      blocks.push({ start, end: i - 1, lines: lines.slice(start, i) });
    } else i++;
  }
  return blocks;
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}
function renderRow(cells) {
  return '| ' + cells.join(' | ') + ' |';
}
/* 光标所在（或最近一次点击的）表格索引 */
function tableUnderCaret() {
  if (isRich()) return -1;
  const ta = $('editor');
  if (document.activeElement !== ta) return activeTableIdx;
  const pos = ta.selectionStart;
  const blocks = tableBlocksOf(ta.value);
  let line = 0;
  for (let i = 0; i < pos && i < ta.value.length; i++) if (ta.value[i] === '\n') line++;
  for (let k = 0; k < blocks.length; k++) {
    if (line >= blocks[k].start && line <= blocks[k].end) { activeTableIdx = k; return k; }
  }
  return -1;
}
function showTableOps(idx) {
  const bar = $('table-ops');
  if (!bar) return;
  activeTableIdx = idx;
  bar.hidden = idx < 0;
}
function hideTableOps() {
  const bar = $('table-ops');
  if (bar) bar.hidden = true;
  activeTableIdx = -1;
}
/* 把改动写回源码：只替换表格那几行，前面的正文一个字都不动，
   撤销栈里也只留一步，不会把整篇重写。 */
function rewriteTable(idx, newLines) {
  const ta = $('editor');
  const blocks = tableBlocksOf(ta.value);
  const b = blocks[idx];
  if (!b) return;
  const lines = ta.value.split('\n');
  const oldText = lines.slice(b.start, b.end + 1).join('\n');
  const newText = newLines.join('\n');
  if (oldText === newText) return;
  let off = 0;
  for (let i = 0; i < b.start; i++) off += lines[i].length + 1;
  applyEdit(off, off + oldText.length, newText, off, off + newText.length);
  render($('editor').value);
}
function tableOp(op) {
  const idx = activeTableIdx >= 0 ? activeTableIdx : tableUnderCaret();
  if (idx < 0) { notify('先把光标放进一个表格里', 'error'); return; }
  const blocks = tableBlocksOf($('editor').value);
  const b = blocks[idx];
  if (!b) return;
  const rows = b.lines.map(splitRow);
  // 首行是表头，第二行是 --- 分隔行；数据行从第 3 行起
  const bodyFrom = 2;
  const cols = Math.max(...rows.map(r => r.length));
  const norm = r => { const out = r.slice(); while (out.length < cols) out.push('   '); return out; };
  const pad = cells => { const out = cells.slice(); while (out.length < cols) out.push('   '); return out; };
  if (op === 'row-add') {
    const min = Math.min(rows.length, b.lines.length);
    rows.splice(min, 0, pad([]));
  } else if (op === 'row-del') {
    if (rows.length <= bodyFrom + 1) { notify('表格至少保留一行表头和一行数据', 'error'); return; }
    rows.pop();
  } else if (op === 'col-add') {
    const withNew = rows.map((r, i) => pad(norm(r)).concat(i === 1 ? '---' : '   '));
    rows.length = 0;
    rows.push(...withNew);
  } else if (op === 'col-del') {
    if (cols <= 1) { notify('表格至少保留一列', 'error'); return; }
    const cut = rows.map(r => norm(r).slice(0, cols - 1));
    rows.length = 0;
    rows.push(...cut);
  } else if (op === 'all-del') {
    // 整表删除：连同上下的空行一起收拾，避免留下两块空白。
    // 必须走 applyEdit（execCommand insertText）而不是直接赋值，否则这一步不在
    // 原生撤销栈里，Ctrl+Z 撤不回来——删表格是最容易点错的操作。
    const lines = $('editor').value.split('\n');
    let from = b.start, to = b.end + 1;
    while (from > 0 && lines[from - 1].trim() === '') from--;
    while (to < lines.length && lines[to].trim() === '') to++;
    let off = 0;
    for (let i = 0; i < from; i++) off += lines[i].length + 1;
    let len = 0;
    for (let i = from; i < to; i++) len += lines[i].length + 1;
    // 末尾多吃掉的那个换行要还回去，否则会把下一段正文顶到上一行
    if (to >= lines.length) len = Math.max(0, len - 1);
    applyEdit(off, off + len, '', off, off);
    render($('editor').value);
    hideTableOps();
    setStatus('已删除表格', 'ok');
    return;
  }
  rewriteTable(idx, rows.map(renderRow));
  setStatus('表格已更新', 'ok');
}
$('table-ops').querySelectorAll('button').forEach(btn => {
  btn.onclick = () => tableOp(btn.dataset.tbl);
});
$('table-cancel').onclick = closeTablePicker;
$('table-ok').onclick = () => { insertTable(tableGridRows, tableGridCols); closeTablePicker(); };
$('table-modal').addEventListener('click', e => { if (e.target === $('table-modal')) closeTablePicker(); });
$('table-modal').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeTablePicker(); }
});

/* 光标进出表格时就地更新浮动条：只在真的位于表格里才出现，免得常驻遮住正文。
   预览里的表格也支持鼠标悬停定位——用户习惯是在预览里看到表格就想改它。 */
function syncTableOps() {
  if (isRich() || state.layout === 'edit') { hideTableOps(); return; }
  showTableOps(tableUnderCaret());
}
$('editor').addEventListener('click', syncTableOps);
$('editor').addEventListener('keyup', e => {
  // 只关心会移动光标的键，打字不该每次刷新浮动条
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') syncTableOps();
});
$('preview').addEventListener('mouseover', e => {
  const t = e.target.closest('table');
  if (!t) return;
  const tables = [...$('preview').querySelectorAll('table')];
  const idx = tables.indexOf(t);
  if (idx >= 0) showTableOps(idx);
});
/* 点预览表格外部、或切走笔记时收起 */
$('preview').addEventListener('mouseleave', () => { if (document.activeElement !== $('editor')) hideTableOps(); });

/* 插入图片：Tauri WebView2 无原生图片选择，走文件对话框选一个本地图片，
   复制进库内 .assets/ 后插入相对路径引用。 */
function insertImage() { pickAndSaveImage(true); }

/* 从原文件名得到 alt：去掉扩展名、把 _ 换成空格。alt 固定成「图片」时，
   图片加载失败或导出成 PDF 只剩一个空框，读者完全不知道那本来是什么。 */
function imageAltFrom(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.slice(0, 80) : '';
}

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
      // alt 用原文件名（去扩展名）：导出成 PDF 或图挂了时，读者还知道这张图叫什么
      const ins = `![${imageAltFrom(picked.name) || '图片'}](${rel})`;
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
        // 粘贴的截图一般没有文件名，用时间当说明比「图片」有用：事后能认出是哪一张
        const alt = imageAltFrom(file.name) || ('截图 ' + new Date().toLocaleTimeString());
        const ins = `![${alt}](${rel})`;
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

/* 水平线：前后不足两个空行时自动补齐。分隔线是独立块，不覆盖已选文字 */
function insertHorizontalRule() {
  const ta = $('editor');
  const s = ta.selectionEnd, v = ta.value;
  const before = v.slice(0, s), after = v.slice(s);
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  const trail = after.length === 0 || after.startsWith('\n\n') ? '' : (after.startsWith('\n') ? '\n' : '\n\n');
  applyEdit(s, s, lead + '---' + trail, s + lead.length + 3, s + lead.length + 3);
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
  enhanceImageAlt(p);
  enhanceImages(p);
}

/* 图片说明（alt）：双击预览里的图片即可改。
   原来 alt 是写死的「图片」，想改就得回源码里找方括号、数第几张图——几乎没人会去改。 */
function enhanceImageAlt(root) {
  root.querySelectorAll('img').forEach(img => {
    img.title = (img.getAttribute('alt') || '') ? '双击修改图片说明' : '双击添加图片说明';
    img.addEventListener('dblclick', e => {
      e.preventDefault();
      const cur = img.getAttribute('alt') || '';
      // promptInline 的取消和"留空"都返回空串，没法区分；按"留空=不改"处理，
      // 标题里也照实写清楚。
      promptInline('图片说明（留空则保持原样）', cur).then(v => {
        if (!v || v === cur) return;
        updateImageAlt(img, v);
      });
    });
  });
}

/* 把预览里这张图的 alt 写回源码：源码里图片引用的顺序 ↔ 预览里 img 的顺序 */
function updateImageAlt(img, alt) {
  const ta = $('editor');
  const src = ta.value;
  const all = [...$('preview').querySelectorAll('img')];
  const idx = all.indexOf(img);
  if (idx < 0) return;
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m, i = 0;
  while ((m = re.exec(src)) !== null) {
    if (i === idx) {
      const start = m.index, end = m.index + m[0].length;
      const next = `![${alt}](${m[2]})`;
      applyEdit(start, end, next, start, start + next.length);
      render($('editor').value);
      setStatus('图片说明已更新', 'ok');
      return;
    }
    i++;
  }
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

/* 预览复选框点击 → 找到源码中对应列表行，回写 [x]/[ ]
   只改那一个字符，不再整篇重写：整篇重写会把编辑区滚动位置弹回顶部、把用户停在
   别处的选区一起清掉，而且一次勾选在撤销栈里变成"替换全文"一步。
   这里只替换 [ ] 里的 1 个字符，光标与滚动都原地不动。 */
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
      // 行首偏移 + 前缀长度 = [x] 里那个字符的位置
      let off = 0;
      for (let k = 0; k < i; k++) off += lines[k].length + 1;
      const at = off + m[1].length;
      applyEdit(at, at + 1, cb.checked ? 'x' : ' ', at + 1, at + 1);
      return;
    }
    seen++;
  }
}

/* 输入路径拆两级调度：高亮合并到动画帧，预览解析（marked + DOMPurify + 大纲 + 字数）
   较重，加短防抖。都不再每个按键同步全量重渲染，长文输入才不卡。 */
let previewTimer = null, hlRaf = 0;
/* 每次渲染挂序号：120ms 防抖期间用户又删/打了字，晚触发的回调必须以最新正文为准。
   旧回调迟到时丢弃，否则预览显示的是中间态，和编辑区对不上（用户报的"删的内容预览不对"）。 */
let renderSeq = 0;
/* 没有打开的笔记却开始输入时，升级成新草稿。
   删掉当前笔记、或上次打开的笔记已被外部删除，都会留下这种空档；
   不升级的话 doSave 见 state.current 为空直接返回成功，输入内容永远不会落盘。 */
function beginDraft() {
  if (state.current) return;
  state.current = { file_name: '' };
  LS.set('last_open', '');
  renderPreviewEmptyState(false);
}

/* 预览只在真的能看见时才渲染：仅编辑模式下右侧面板是隐藏的，
   每个键都去 marked 解析 + DOMPurify 净化再丢弃，是纯浪费。 */
function previewVisible() {
  return !isRich() && state.layout !== 'edit';
}

function onEditorInput() {
  beginDraft();
  if (!hlRaf) {
    hlRaf = requestAnimationFrame(() => { hlRaf = 0; renderHighlight(); });
  }
  // 预览解析（marked + DOMPurify + 大纲 + 字数）放到空闲帧：
  // 打字时的输入延迟优先于"预览早 100ms 出现"。
  clearTimeout(previewTimer);
  const seq = ++renderSeq;
  previewTimer = setTimeout(() => {
    const run = () => {
      if (seq !== renderSeq) return; // 期间又有输入，本次已过期
      if (!previewVisible()) return;
      render($('editor').value);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 300 });
    else run();
  }, 160);
  // 正文变了，查找命中点全部失效：不重跑就会按旧位置选中，跳过去选中的是一段无关文字
  if (!$('find-bar').hidden) { findIdx = -1; runFind(); }
  scheduleAutosave();
}

/* ---------- 导出 ---------- */
async function exportNote(format) {
  if (!state.current) { setStatus('没有可导出的笔记'); return; }
  // 富文本笔记没有「导出 Markdown / PNG」：HTML 转 Markdown 有损，PNG 走的是
  // Markdown 预览区（富文本模式没有预览区，会导出上一篇的内容）。
  // 菜单里已经藏了这两项，这里再挡一层，避免快捷键或旧入口绕过。
  if (isRich() && (format === 'md' || format === 'png')) {
    setStatus(format === 'md' ? '富文本笔记不支持导出 Markdown（格式有损）' : '富文本笔记不支持导出 PNG', 'error');
    return;
  }
  await doSave();
  // 保存失败时 file_name 仍为空（从未落盘），导出无从谈起
  if (!state.current.file_name) { setStatus('笔记未保存，导出取消', 'error'); return; }
  const fileName = state.current.file_name;
  // PDF 由 Rust 端 WebView2 原生渲染（无页眉页脚），前端不传内容
  let payload = '';
  // Word 缺图的提醒要等导出真的成功之后再报——先报再失败，用户会以为图片问题
  // 才是失败原因。这里先记下，成功分支里和「已导出」合成一条提示。
  let docxImgWarn = '';
  if (format === 'html') {
    payload = buildStandaloneHtml();
  } else if (format === 'docx') {
    payload = isRich() ? buildDocxPayloadFromHtml() : buildDocxPayload($('editor').value);
    // DOCX 生成器只写文字块，没有图片关系（word/media 与 rels 都没建）。
    // 与其让用户拿到一份悄悄少了所有截图的 Word，不如当场说清楚——
    // 但这是"能用、只是缺图"，不是失败：红色报错会让人以为整个导出挂了。
    const imgs = isRich()
      ? (state.rich ? state.rich.root.querySelectorAll('img').length : 0)
      : ($('editor').value.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
    if (imgs) docxImgWarn = `已导出 Word，但图片没跟过去（本篇 ${imgs} 张）`;
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
    if (docxImgWarn) {
      // 一条提示说清两件事：导出成功 + 图片没跟过去，并给一个能马上点的替代方案
      setStatus(docxImgWarn, 'warn');
      showToast(docxImgWarn, { label: '改用 PDF 导出', onClick: () => exportNote('pdf') }, 'warn');
    } else {
      showToast('已导出到 ' + path, { label: '打开所在文件夹', onClick: () => invoke('reveal_path', { path: path.replace(/[\\/][^\\/]*$/, '') }) });
    }
  } catch (e) {
    if (e === '已取消') return;
    setStatus('导出失败：' + e, 'error');
  }
}

/* 轻量 toast：右下角浮层，带一个可选动作按钮。
   操作成功一律走这里，不再去抢顶栏那行保存状态——那行只回答"存没存"。 */
let toastTimer = null;
function showToast(text, action, kind) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = '';
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-warn', kind === 'warn');
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
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 9000 : 6000);
}

/* 操作反馈统一入口：成功/失败都用 toast，失败停留更久 */
function notify(text, kind) {
  showToast(text, null, kind);
}

/* 富文本导出用的 HTML：图片换成 data URL（导出的文件要能独立打开），并去掉编辑器私有标记。
   同样全程字符串替换：把相对路径写进 DOM 会触发真实请求。 */
function richHtmlForExport() {
  if (!state.rich) return '';
  const clone = state.rich.root.cloneNode(true);
  clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  clone.querySelectorAll('.ql-ui').forEach(el => el.remove());
  let html = clone.innerHTML;
  // data URL 已经在 DOM 里，无需替换；仅补齐载入时未解析的资产
  for (const [rel, url] of state.richAssets) {
    if (!url) continue;
    html = html.split('src="' + rel + '"').join('src="' + url + '"');
  }
  return html;
}

/* 富文本 → DOCX 段落数组。只映射 md/docx 都能表达的结构，其余按段落降级。 */
function buildDocxPayloadFromHtml() {
  const out = [];
  if (!state.rich) return JSON.stringify(out);
  const walk = node => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        out.push({ block: 'heading', level: +tag.slice(1), text: el.textContent.trim() });
      } else if (tag === 'blockquote') {
        const t = el.textContent.trim();
        if (t) out.push({ block: 'quote', text: t });
      } else if (tag === 'pre') {
        out.push({ block: 'code', text: el.textContent });
      } else if (tag === 'ul' || tag === 'ol') {
        [...el.children].forEach(li => {
          if (li.tagName.toLowerCase() !== 'li') return;
          // 嵌套列表压平成同级项，Word 侧不建多级结构
          const own = [...li.childNodes].filter(n => n.nodeType === 3 || (n.nodeType === 1 && !/^(ul|ol)$/i.test(n.tagName)));
          const text = own.map(n => n.textContent).join('').trim();
          if (text) out.push({ block: 'list', text: tag === 'ol' ? `${[...el.children].indexOf(li) + 1}. ${text}` : text });
        });
      } else if (tag === 'p') {
        const t = el.textContent.trim();
        if (t) out.push({ block: 'paragraph', text: t });
        // 段落里理论上不嵌块级元素，这里不再递归
      } else {
        walk(el);
      }
    }
  };
  walk(state.rich.root);
  return JSON.stringify(out);
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

function buildStandaloneHtml() {
  // 富文本笔记：Quill 的输出本身就是成品 HTML，补上样式与标题即可
  if (isRich()) {
    const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = richHtmlForExport();
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(state.current.title || '')}</title><style>body{max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.8;color:#1a1d23;} h1{font-size:2em;} h2{border-bottom:1px solid #eee;padding-bottom:6px;} blockquote{border-left:4px solid #6C5CE7;background:rgba(108,92,231,.07);margin:12px 0;padding:12px 16px;} pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto;} img{max-width:100%;} ol,ul{padding-left:1.6em;} u{text-decoration:underline;text-underline-offset:3px;}</style></head><body>${body}</body></html>`;
  }
  const body = $('preview').innerHTML;
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
/* 标题只有一处（正文上方）。改标题即时刷新草稿行并触发自动保存。 */
function onTitleInput() {
  syncDraftTitle();
  scheduleAutosave();
}
/* 标题改动也刷新占位行的文字，让列表里显示的就是当前标题 */
function syncDraftTitle() {
  const el = document.querySelector('#note-list li.draft .nt');
  if (el) el.textContent = $('doc-title').value || '未命名文档';
}
$('doc-title').addEventListener('input', onTitleInput);
/* 标题按 Enter 直接进正文：这是"写标题 → 开始写"最自然的一步，
   不必再 Tab 穿过标签、类型、工具栏；同时保留失焦行为给鼠标用户。 */
$('doc-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('doc-title').blur(); focusEditor(); }
  else if (e.key === 'Escape') { e.preventDefault(); $('doc-title').blur(); }
});
$('tags-input').addEventListener('input', scheduleAutosave);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 250);
});

$('btn-new').onclick = newNoteDefault;
/* 「新建」旁边的下拉：新建文件夹、导入、帮助都收进来。
   侧栏顶部只留一个主按钮 + 一个箭头，比原来"主按钮 + 纯图标"更容易发现。 */
bindMenu('btn-new-menu', 'new-menu');
document.querySelectorAll('#new-menu .dropdown-item').forEach(el => {
  el.onclick = () => {
    const act = el.dataset.act;
    closeAllMenus();
    if (act === 'new-note') newNoteDefault();
    else if (act === 'new-folder') newFolderFlow();
    else if (act === 'import') importLocalDocs();
    else if (act === 'help') showHelp(true);
  };
});
$('scope-clear').onclick = () => {
  $('search').value = '';
  state.tagFilter = [];
  state.folderFilter = null;
  refreshList();
};
/* 标签管理：入口在排序行右侧，弹窗里改名/合并/删除 */
$('btn-tags').onclick = openTagManager;
$('tag-modal-close').onclick = closeTagManager;
$('tag-modal-filter').addEventListener('input', renderTagManager);
$('tag-modal').addEventListener('click', e => { if (e.target === $('tag-modal')) closeTagManager(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('tag-modal') && !$('tag-modal').hidden) closeTagManager();
});
$('batch-bar').querySelectorAll('button').forEach(b => {
  b.onclick = () => {
    if (b.dataset.act === 'move') openBatchMoveMenu(b);
    else if (b.dataset.act === 'delete') deleteSelectedFlow();
    else {
      state.selected.clear();
      refreshSelectionUI();
    }
  };
});
document.addEventListener('click', e => {
  if (!e.target.closest('#batch-move-menu') && !e.target.closest('#batch-bar')) hideBatchMoveMenu();
  if (!e.target.closest('#recent-menu') && !e.target.closest('#btn-more') && !e.target.closest('[data-act="recent"]')) hideRecentMenu();
});
/* ===== 窄窗口布局（P2-2）=====
   tauri.conf.json 的最小宽度就是 900，所以「900 挤压」不是边缘场景。
   三栏硬塞时每栏只剩 240px 左右，编辑器一行不到 20 个字。
   处理办法：
   - ≤1180：侧栏变覆盖式抽屉（不挤压正文），主区优先保证编辑与预览的可读宽度；
   - ≤1020：默认只显示一栏，用「视图」在编辑/预览间切换（双栏仍可手动选）；
   - 目录面板改成浮层，不再从正文里切一条走。
   JS 只负责「宽度变了就重排一次」，样式全在 style.css 的媒体查询里。 */
let narrowMode = '';
let layoutBeforeNarrow = '';
let autoHiddenSidebar = false;
function layoutForWidth() {
  const w = window.innerWidth;
  const mode = w <= 1020 ? 'single' : w <= 1180 ? 'drawer' : '';
  if (mode === narrowMode) return;
  const prev = narrowMode;
  narrowMode = mode;
  document.body.classList.toggle('is-narrow', mode === 'single');
  document.body.classList.toggle('is-drawer', mode === 'drawer');
  // 进单栏：双栏会挤成两条细缝，先收到「编辑」，用户想看预览点一下即可。
  // 记住原来的布局，窗口拉宽后还回去，别让一次缩放把用户的选择永久改掉。
  if (mode === 'single' && prev !== 'single' && state.layout === 'both') {
    layoutBeforeNarrow = 'both';
    setLayout('edit', false);
  } else if (!mode && layoutBeforeNarrow) {
    setLayout(layoutBeforeNarrow);
    layoutBeforeNarrow = '';
  }
  // 抽屉态：侧栏改成浮在正文上，不能默认盖着内容
  // 直接从宽屏跨过抽屉档掉到 ≤1020 时也要收：单栏下侧栏是整屏浮层，
  // 不收就等于"一缩放，正文被列表盖住"。
  if (mode && !prev && state.sidebarOpen) {
    applySidebar(false);
    autoHiddenSidebar = true;
  }
  // 退回宽屏：把之前为省空间自动收起的侧栏还回来（用户手动收的不动）
  if (!mode && prev && autoHiddenSidebar) {
    applySidebar(true);
    autoHiddenSidebar = false;
  }
}
window.addEventListener('resize', () => { closeAllMenus(); layoutForWidth(); });

$('save-state').onclick = doSave;
/* 导入本地文档：Rust 端弹多选文件框，复制进笔记库后打开最后一篇。
   命名用「导入」而不是「打开」：它不会打开原文件，只会在库里留一份副本。 */
async function importLocalDocs() {
  try {
    const metas = await invoke('import_note', { folder: state.activeFolder || '' });
    if (metas && metas.length) {
      await refreshList();
      // 先打开再报结果：openNote 会把状态重置成「就绪」，先报会被它盖掉。
      await openNote(metas[metas.length - 1].file_name);
      showToast(`已导入 ${metas.length} 篇（复制到笔记库，原文件未改动）`, {
        label: '导入更多',
        onClick: importLocalDocs,
      });
    }
  } catch (e) {
    setStatus('导入失败：' + e, 'error');
  }
}
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
/* 「更多」菜单承接低频应用级操作：导入、在文件夹中显示、主题。
   主题曾经是顶栏的一个图标按钮，但换肤不是每天都做的事，收进菜单即可。 */
bindMenu('btn-export-toggle', 'export-menu');
bindMenu('btn-more', 'more-menu');
document.querySelectorAll('#more-menu .dropdown-item').forEach(el => {
  el.onclick = async () => {
    const act = el.dataset.act;
    closeAllMenus();
    if (act === 'import') importLocalDocs();
    // 锚点用「更多」按钮本身：菜单项此刻已经被 closeAllMenus 藏起来了，
    // 拿它算位置只会得到 (0,0)，浮层就跑到左上角去。
    else if (act === 'recent') openRecentMenu($('btn-more'));
    else if (act === 'theme') applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
    else if (act === 'to-rich') convertToRich();
    else if (act === 'help') showHelp(true);
    else if (act === 'reveal') {
      if (!state.current || !state.current.file_name) { setStatus('这篇笔记还没保存到磁盘', 'error'); return; }
      try { await invoke('reveal_note', { fileName: state.current.file_name }); }
      catch (e) { setStatus('定位失败：' + e, 'error'); }
    }
  };
});
bindMenu('row-view', 'view-menu-row');
bindMenu('prow-view', 'view-menu-prow');
bindMenu('btn-heading', 'heading-menu');
document.querySelectorAll('#export-menu .dropdown-item').forEach(el => el.onclick = () => { closeAllMenus(); exportNote(el.dataset.fmt); });
document.querySelectorAll('#view-menu-row .dropdown-item, #view-menu-prow .dropdown-item').forEach(el => el.onclick = () => { closeAllMenus(); setLayout(el.dataset.view); });

/* 文档类型开关：仅新笔记、尚未落盘时可切换 */
$('kind-switch').querySelectorAll('button').forEach(btn => {
  btn.onclick = () => {
    const next = btn.dataset.kind;
    // 点已经选中的那个按钮什么都不该发生——先判这一条，再判锁定。
    // 顺序反了会在锁定态下对"已选中的类型"报「创建后不可更改」，用户莫名其妙。
    if (next === state.kind) return;
    if (state.kindLocked) {
      setStatus('文档类型创建后不可更改，如需另一种类型请新建文档', 'error');
      return;
    }
    // 切类型会丢当前正文（两种格式无法无损互转），先确认
    const hasBody = isRich() ? (state.rich && state.rich.getText().trim()) : $('editor').value.trim();
    const go = () => {
      LS.set('kind', next);
      if (next === 'rich') {
        $('editor').value = '';
        render('');
        applyKind('rich', false);
        state.rich && state.rich.setContents([], 'silent');
        // 同上：切类型后撤销栈里是另一种格式的内容，按 Ctrl+Z 会把它搬回来
        state.rich && state.rich.history.clear();
        state.rich && state.rich.focus();
      } else {
        state.richAssets.clear();
        state.rich && state.rich.setContents([], 'silent');
        state.rich && state.rich.history.clear();
        $('editor').value = '';
        applyKind('md', false);
        renderHighlight();
        render('');
        $('editor').focus();
      }
      state.dirty = false;
      notify('已切换为' + (next === 'rich' ? '富文本' : 'Markdown'));
    };
    if (!hasBody) { go(); return; }
    invoke('confirm_dialog', {
      title: '切换文档类型',
      message: '切换会清空当前正文，两种格式无法互转。继续？',
      okLabel: '继续',
      cancelLabel: '取消',
    }).then(ok => { if (ok) go(); });
  };
});
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
$('btn-table').onclick = openTablePicker;
$('btn-tag').onclick = () => insertTag('accent');
$('btn-hr').onclick = insertHorizontalRule;
$('btn-undo').onclick = () => { $('editor').focus(); document.execCommand('undo'); };
$('btn-redo').onclick = () => { $('editor').focus(); document.execCommand('redo'); };

/* ---------- 启动 ---------- */
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
/* 弹窗打开时，全局快捷键必须让路：否则在链接/表格弹窗里按 Ctrl+B，
   格式会施加到背后编辑器里的旧选区上，用户看着弹窗却改了正文。 */
function anyModalOpen() {
  return ['new-note-modal', 'link-modal', 'prompt-modal', 'table-modal'].some(id => { const el = $(id); return el && !el.hidden; });
}
/* 焦点在普通输入框里时，Ctrl+B/I/K/N 这类编辑命令不该抢焦点去编辑器。
   富文本编辑器本身是 contenteditable，但它不是"普通输入框"：它的格式快捷键
   由 Quill 自己接管，Ctrl+F 也该走"富文本不支持查找"的分支，不能算作输入框。 */
function typingInField() {
  const el = document.activeElement;
  if (!el || el === $('editor')) return false;
  if ($('rich-host') && $('rich-host').contains(el)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (anyModalOpen()) {
    // Esc 由各弹窗自己的监听器处理；其余快捷键一律不响应
    if (e.key !== 'Escape') return;
    return;
  }
  if (typingInField()) {
    // 输入框里只放行不改动正文的全局命令。Ctrl+B/I/K/N 这类会抢焦点或改正文的
    // 一律让给输入框本身——否则在标签框里按 Ctrl+B 会把加粗打到背后编辑器的旧选区上。
    if (ctrl && key === 's') { e.preventDefault(); doSave(); }
    else if (ctrl && key === 'f') { e.preventDefault(); openFindBar(); }
    else if (ctrl && key === 'h') { e.preventDefault(); openFindBar(); $('replace-input').focus(); }
    else if (ctrl && e.shiftKey && key === 't') { e.preventDefault(); applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); }
    else if (ctrl && e.shiftKey && key === 'l') { e.preventDefault(); cycleLayout(); }
    // F6 与 Ctrl+Alt+E 在输入框里也要能用：标签框/搜索框里想回正文时不能先点一下别处
    else if (e.key === 'F6') { e.preventDefault(); applySidebar(!state.sidebarOpen); }
    else if (ctrl && e.altKey && key === 'e') { e.preventDefault(); focusEditor(); }
    else if (ctrl && e.key === 'Tab') { e.preventDefault(); cycleRecent(e.shiftKey); }
    else if (e.key === 'Escape' && !$('find-bar').hidden) { e.preventDefault(); closeFindBar(); }
    return;
  }
  // 富文本模式：格式快捷键交给 Quill 自己的键盘绑定，这里只保留保存/新建/主题/布局
  if (isRich()) {
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
    else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newNoteDefault(); }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); }
    // 富文本也能查找/替换：直接搜 Quill 的纯文本，下标与文档位置一致
    else if (ctrl && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'h')) {
      e.preventDefault();
      openFindBar();
      if (e.key.toLowerCase() === 'h') $('replace-input').focus();
    }
    else if (e.key === 'F6') { e.preventDefault(); applySidebar(!state.sidebarOpen); }
    else if (ctrl && e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); focusEditor(); }
    else if (ctrl && e.key === 'Tab') { e.preventDefault(); cycleRecent(e.shiftKey); }
    else if (e.key === 'Escape') { closeAllMenus(); if (!$('find-bar').hidden) closeFindBar(); }
    return;
  }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  else if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); focusEditorThen(formatBold); }
  else if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); focusEditorThen(formatItalic); }
  else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newNoteDefault(); }
  else if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); focusEditorThen(insertLink); }
  else if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); cycleLayout(); }
  else if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); }
  else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindBar(); }
  // Ctrl+H：打开查找栏并聚焦替换输入框
  else if (ctrl && e.key.toLowerCase() === 'h') { e.preventDefault(); openFindBar(); $('replace-input').focus(); }
  // 查找跳转后会聚焦编辑器（让命中可见），此时 Enter 应继续跳到下一个而非插入换行。
  // 无命中时必须放行：否则用户在"无结果"状态下连换行都打不出来。
  else if (e.key === 'Enter' && !$('find-bar').hidden && findHits.length && e.target === $('editor')) {
    e.preventDefault();
    findIdx += e.shiftKey ? -1 : 1;
    gotoFindHit(true);
  }
  else if (e.key === 'F6') { e.preventDefault(); applySidebar(!state.sidebarOpen); }
  // Ctrl+Tab：在最近打开过的笔记之间轮换（Shift 反向）
  else if (ctrl && e.key === 'Tab') { e.preventDefault(); cycleRecent(e.shiftKey); }
  // Ctrl+Alt+E：把焦点交给正文。比"数着按几次 Tab"更适合每天写作的人。
  else if (ctrl && e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); focusEditor(); }
  else if (e.key === 'Escape') { closeAllMenus(); if (!$('find-bar').hidden) closeFindBar(); }
});

/* 焦点不在编辑器时，Ctrl+B/I/K 先聚焦编辑器再执行，避免"按了没反应" */
function focusEditorThen(fn) {
  if (!isRich() && document.activeElement !== $('editor')) $('editor').focus();
  fn();
}
/* 把当前 Markdown 笔记另存为富文本副本：单向转换，原笔记保留。
   两种类型不能互转是产品约束，但"先写后排版"是真实需求，给一条单向出口比堵死好。 */
async function convertToRich() {
  if (isRich()) { notify('这篇已经是富文本了', 'error'); return; }
  if (state.dirty && !(await doSave())) return;
  if (!state.current || !state.current.file_name) { notify('请先保存这篇笔记', 'error'); return; }
  const md = $('editor').value;
  const html = DOMPurify.sanitize(marked.parse(md || ''), { ADD_TAGS: ['badges', 'u'], ADD_ATTR: ['tone'] });
  const title = ($('doc-title').value.trim() || '未命名') + '（富文本）';
  const folder = folderOfKey(state.current.file_name);
  const tags = normalizeTags($('tags-input').value.split(/[,，]/));
  try {
    const meta = await invoke('save_note', {
      fileName: '', title, tags, content: html, folder, kind: 'rich',
    });
    await refreshList();
    await openNote(meta.file_name);
    notify('已另存为富文本副本，原 Markdown 笔记未改动');
  } catch (e) {
    notify('转换失败：' + e, 'error');
  }
}
function focusEditor(opts) {
  const preventScroll = opts && opts.preventScroll;
  if (isRich()) {
    const el = document.querySelector('#rich-editor .ql-editor');
    if (el) el.focus(preventScroll ? { preventScroll: true } : undefined);
    return;
  }
  $('editor').focus(preventScroll ? { preventScroll: true } : undefined);
}

/* 工具栏是一个整体制表位：18 个按钮不再逐个进 Tab 序，
   Tab 只停一次（首个按钮），用 ←/→/Home/End 在组内移动。
   纯键盘用户仍能到达每个按钮，但从标题到正文不再要按 20 多次 Tab。 */
function initToolbarRoving() {
  const track = document.querySelector('.format-group-track');
  if (!track) return;
  const items = () => [...track.querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent !== null);
  const setStop = el => {
    [...track.querySelectorAll('button')].forEach(b => { b.tabIndex = -1; });
    if (el) el.tabIndex = 0;
  };
  const first = items()[0];
  if (first) setStop(first);
  track.addEventListener('focusin', e => {
    const b = e.target.closest && e.target.closest('button');
    if (b) setStop(b);
  });
  track.addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const list = items();
    if (!list.length) return;
    const cur = e.target.closest && e.target.closest('button');
    const i = list.indexOf(cur);
    const n = e.key === 'Home' ? 0
      : e.key === 'End' ? list.length - 1
        : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[n].focus();
  });
  // 按钮可能因状态变化被隐藏（富文本切回、禁用撤销等），制表位要跟着校准，
  // 否则 Tab 会落在一个看不见的按钮上，等于没有入口。
  const obs = new MutationObserver(() => {
    const cur = track.querySelector('button[tabindex="0"]');
    if (cur && cur.offsetParent !== null && !cur.disabled) return;
    const list = items();
    if (list.length) setStop(list[0]);
  });
  obs.observe(track, { subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'style', 'class'] });
}
initToolbarRoving();

/* ---------- 工具栏溢出：单行 + 「更多格式」收纳 ----------
   原来 18 个按钮里带中文（引用/任务/无序/有序/行内代码/链接/图片/表格/标签/线条），
   一行放不下就换行，窄窗口还会甩出孤行。现在全部只留图标（title 里有名字），
   仍然放不下时按 data-tb 优先级把低频项搬进「⋯」，一行永远不换行。
   data-tb：0 撤销/重做/标题/加粗/斜体，1 列表/链接，2 引用/代码块/图片/表格，
   3 任务/徽章/分隔线，4 下划线/删除线/行内代码。数字越大越先被收起来。 */
const toolbarTrack = document.querySelector('.editor-toolbar .format-group-track');
const toolbarMore = $('tb-more-dropdown');
const toolbarAll = toolbarTrack ? [...toolbarTrack.children] : [];
let toolbarBusy = false;

function toolbarLabelOf(el) {
  const btn = el.matches('button') ? el : el.querySelector('button');
  return (btn && (btn.dataset.tbLabel || btn.title.split('（')[0].split(' ')[0])) || '';
}
/* 搬进「更多」的按钮要带上名字，否则菜单里只剩一个图标，等于没解释 */
function toolbarToMenu(el) {
  el.querySelectorAll('.tb-more-label').forEach(n => n.remove());
  el.classList.add('in-more');
  if (el.matches('button')) {
    el.tabIndex = -1;
    const span = document.createElement('span');
    span.className = 'tb-more-label';
    span.textContent = toolbarLabelOf(el);
    el.appendChild(span);
  }
  $('tb-more-menu').appendChild(el);
}
function toolbarToTrack(el) {
  el.querySelectorAll('.tb-more-label').forEach(n => n.remove());
  el.classList.remove('in-more');
  if (el.matches('button')) el.removeAttribute('tabindex');
}
function tidyToolbarDividers() {
  const kids = [...toolbarTrack.children];
  let prevDivider = true; // 行首的分隔符没有意义
  for (const el of kids) {
    if (el.classList.contains('divider')) {
      el.hidden = prevDivider;
      prevDivider = true;
    } else {
      prevDivider = false;
    }
  }
  // 行尾的分隔符同样去掉
  for (let i = kids.length - 1; i >= 0; i--) {
    if (!kids[i].classList.contains('divider')) break;
    if (!kids[i].hidden) { kids[i].hidden = true; break; }
  }
}
function layoutToolbar() {
  if (!toolbarTrack || !toolbarMore || toolbarBusy) return;
  toolbarBusy = true;
  // 1) 全部放回单行，先量一次看是否溢出
  toolbarMore.hidden = true;
  for (const el of toolbarAll) toolbarToTrack(el), toolbarTrack.appendChild(el);
  tidyToolbarDividers();
  if (toolbarTrack.scrollWidth <= toolbarTrack.clientWidth + 1) { toolbarBusy = false; return; }
  // 2) 需要「更多」：给它占位后按优先级从低到高搬走，直到装得下
  toolbarMore.hidden = false;
  const menu = $('tb-more-menu');
  menu.innerHTML = '';
  const idx = el => toolbarAll.indexOf(el);
  const movable = toolbarAll
    .filter(el => el.matches('button') && !el.hidden)
    .sort((a, b) => (+b.dataset.tb || 0) - (+a.dataset.tb || 0) || idx(b) - idx(a));
  for (const el of movable) {
    if (toolbarTrack.scrollWidth <= toolbarTrack.clientWidth + 1) break;
    toolbarToMenu(el);
    tidyToolbarDividers();
  }
  // 菜单内保持原有先后顺序，读起来和工具栏一致
  [...menu.children].sort((a, b) => idx(a) - idx(b)).forEach(n => menu.appendChild(n));
  // 一个都没搬走（只是差几像素）时不必显示「更多」
  if (!menu.children.length) toolbarMore.hidden = true;
  toolbarBusy = false;
}
bindMenu('btn-tb-more', 'tb-more-menu');
let toolbarResizeTimer = null;
const scheduleToolbarLayout = () => {
  clearTimeout(toolbarResizeTimer);
  toolbarResizeTimer = setTimeout(layoutToolbar, 120);
};
window.addEventListener('resize', scheduleToolbarLayout);
// 窗口宽度没变、工具栏自己变窄也会溢出：收侧栏、切视图（双栏→单栏）都只改主区宽度。
// 只听 window.resize 会漏掉这些，于是"切到单栏后还有按钮塞在更多里"或者反过来。
if (window.ResizeObserver) {
  new ResizeObserver(scheduleToolbarLayout).observe(toolbarTrack);
}
layoutToolbar();
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
  // 焦点交还给当前正在用的编辑器：富文本模式下 #editor 是隐藏的 textarea，
  // 聚焦它等于把焦点丢给 body，用户之后的输入会被静默吃掉。
  if (isRich()) { const el = document.querySelector('#rich-editor .ql-editor'); if (el) el.focus(); }
  else $('editor').focus();
}
function runFind() {
  const q = $('find-input').value.toLowerCase();
  // 富文本没有 textarea：直接搜 Quill 的纯文本，下标与文档位置一一对应，
  // 所以跳转/替换都能直接落回富文本，不用另建一套 UI。
  const v = isRich() ? (state.rich ? state.rich.getText() : '') : $('editor').value;
  findHits = [];
  if (q) {
    const lower = v.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(q, i)) !== -1) { findHits.push([i, i + q.length]); i += q.length; }
  }
  // 先归一化 findIdx（-1 表示尚未跳转过，按第一条算 1 起显示），再写计数文案
  if (!findHits.length) { findIdx = -1; $('find-count').textContent = '无结果'; return; }
  if (findIdx < 0) findIdx = 0;
  $('find-count').textContent = `${findIdx + 1}/${findHits.length}`;
  gotoFindHit();
}
/* 把源码第 line 行滚到编辑区中间。
   不能用 line * 行高估算：长行会软换行，几行之后的真实位置就远超估算，
   命中会被滚到视口之外（表现为"跳了但看不到文字"）。改按高亮层里对应
   .hl-line 的真实位置定位；高亮层还没渲染时再退回行高估算。 */
function scrollEditorToLine(line) {
  const scroll = $('editor-scroll');
  const el = $('editor-highlight').querySelectorAll('.hl-line')[line];
  if (el) {
    const box = scroll.getBoundingClientRect();
    const top = el.getBoundingClientRect().top - box.top + scroll.scrollTop;
    scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 2);
    return;
  }
  const lineH = parseFloat(getComputedStyle($('editor')).lineHeight) || 20;
  scroll.scrollTop = Math.max(0, line * lineH - scroll.clientHeight / 2);
}
/* 取高亮层某行内第 col 个字符的矩形（高亮层文本与源码逐字符对应）。
   只量这一个字符：整段量会得到跨多个视觉行的并集矩形，位置就没意义了。 */
function hlTextRectAt(el, col) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (col < acc + len) {
      const off = col - acc;
      const range = document.createRange();
      range.setStart(node, off);
      range.setEnd(node, Math.min(len, off + 1));
      const r = range.getBoundingClientRect();
      if (r.height > 0) return r;
      // 恰落在行尾：退一格取前一个字符的矩形
      if (off > 0) {
        const back = document.createRange();
        back.setStart(node, off - 1);
        back.setEnd(node, off);
        const rb = back.getBoundingClientRect();
        if (rb.height > 0) return rb;
      }
      return null;
    }
    acc += len;
  }
  return null;
}
/* 把源码位置 pos 滚到编辑区中间。
   只按行定位不够：命中落在被软换行撑到几千像素高的长行里时，把整行居中后
   命中字符仍在视口之外。改为直接定位命中字符自己的矩形，拿不到再退回按行。 */
function scrollEditorToPos(pos) {
  const v = $('editor').value;
  const line = v_countLines(v, pos);
  const col = pos - (v.lastIndexOf('\n', pos - 1) + 1);
  const scroll = $('editor-scroll');
  // 高亮层与正文对不上（替换后同一帧内跳转）说明几何是旧的，先重渲染再量
  const hlBox = $('editor-highlight');
  if (hlSrc !== v) renderHighlight();
  const hlLines = hlBox.querySelectorAll('.hl-line');
  const el = hlLines[line];
  const rect = el ? hlTextRectAt(el, col) : null;
  if (rect) {
    const top = rect.top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 2);
    return;
  }
  scrollEditorToLine(line);
}
function gotoFindHit(focusEditor) {
  if (!findHits.length) return;
  findIdx = (findIdx + findHits.length) % findHits.length;
  const [s, e] = findHits[findIdx];
  if (isRich() && state.rich) {
    const q = state.rich;
    if (focusEditor) q.setSelection(s, e - s, 'user');
    // getBounds 给的是相对编辑器的像素位置；命中在视口外才滚动，避免每跳一次整页抖
    try {
      const b = q.getBounds(s, e - s);
      const root = q.root;
      if (b && (b.top < root.scrollTop + 8 || b.top > root.scrollTop + root.clientHeight - 48)) {
        root.scrollTop = Math.max(0, b.top - root.clientHeight / 3);
      }
    } catch { /* 取不到几何就只选中，不影响替换 */ }
    $('find-count').textContent = `${findIdx + 1}/${findHits.length}`;
    return;
  }
  const ta = $('editor');
  // 仅导航（Enter/前后跳转）时聚焦编辑器；输入过程中的预览不抢焦点，否则选区会吞掉下一个字符
  if (focusEditor) {
    ta.focus();
    ta.setSelectionRange(s, e);
  }
  // 滚动让命中可见
  scrollEditorToPos(s);
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
  const rep = $('replace-input').value;
  if (isRich() && state.rich) {
    state.rich.deleteText(s, e - s, 'user');
    state.rich.insertText(s, rep, 'user');
    state.rich.setSelection(s + rep.length, 0, 'user');
    runFind();
    findIdx++;
    gotoFindHit(true);
    return;
  }
  applyEdit(s, e, rep, s + rep.length, s + rep.length);
  // 替换后命中位置整体变化，重跑查找并前进到下一处
  runFind();
  findIdx++;
  gotoFindHit(true);
}
function replaceAll() {
  const q = $('find-input').value;
  const rep = $('replace-input').value;
  if (!q) return;
  if (isRich() && state.rich) {
    if (!findHits.length) { notify('没有可替换的匹配', 'error'); return; }
    const hits = findHits.slice();
    // 从后往前替换：前面的下标不会被后面的改动挤偏
    for (let i = hits.length - 1; i >= 0; i--) {
      state.rich.deleteText(hits[i][0], hits[i][1] - hits[i][0], 'user');
      state.rich.insertText(hits[i][0], rep, 'user');
    }
    notify(`已替换 ${hits.length} 处`);
    runFind();
    return;
  }
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
  if (!count) { notify('没有可替换的匹配', 'error'); return; }
  const next = out.join('');
  // 整篇一次替换：选中全部内容再插入，保证能被一次 Ctrl+Z 撤销
  applyEdit(0, v.length, next, 0, 0);
  notify(`已替换 ${count} 处`);
  runFind();
}
$('replace-one').onclick = replaceCurrent;
$('replace-all').onclick = replaceAll;
$('replace-input').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
  // 全局 Esc 处理被 stopPropagation 挡住了，这里必须自己收尾，否则查找栏关不掉
  else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
});
$('replace-input').addEventListener('input', e => e.stopPropagation());

/* ---------- 编辑器 Tab 缩进 ----------
   正文里 Tab 用于缩进，为免纯键盘被困在 textarea：Ctrl+Tab 换到上一篇最近笔记。
   不把焦点移出编辑器——正文里的 Tab 是缩进，用它做"跳出去"会误伤正在排版的人。
   Ctrl+Tab 只在这里拦住缩进，真正的切换交给 document 上的全局快捷键：
   两处都调用会一次按键换两篇（切过去又切回来，看起来完全没反应）。 */
$('editor').addEventListener('keydown', e => {
  if (isRich()) return; // 富文本模式的键盘行为交给 Quill
  if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return;
  }
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = $('editor');
  const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
  if (e.shiftKey) {
    // Shift+Tab：对选区内每行（或当前行）删除行首最多一个缩进单位（2 空格或 1 个 Tab）
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', en);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    let removedFirst = 0, delta = 0;
    const out = lines.map((l, i) => {
      // 一个缩进单位：优先吃掉 2 个空格，否则 1 个 Tab/空格
      const m = l.match(/^(?:  |\t| )/);
      if (!m) return l;
      const cut = m[0].length;
      if (i === 0) removedFirst = cut;
      delta += cut;
      return l.slice(cut);
    }).join('\n');
    applyEdit(lineStart, lineEnd, out, Math.max(lineStart, s - removedFirst), Math.max(lineStart, en - delta));
  } else {
    // Tab 一律是「加缩进」，不能拿两个空格替换掉选区——那等于删掉用户选中的文字。
    // 跨行选区逐行在行首加；单行选区只在行首加、选区跟着右移 2；无选区则插入两个空格。
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    if (v.slice(s, en).includes('\n')) {
      let lineEnd = v.indexOf('\n', en);
      if (lineEnd === -1) lineEnd = v.length;
      const lines = v.slice(lineStart, lineEnd).split('\n');
      const out = lines.map(l => '  ' + l).join('\n');
      applyEdit(lineStart, lineEnd, out, s + 2, en + lines.length * 2);
    } else if (s !== en) {
      applyEdit(lineStart, lineStart, '  ', s + 2, en + 2);
    } else {
      applyEdit(s, en, '  ', s + 2, s + 2);
    }
  }
});

/* ---------- 恢复界面状态 ---------- */
applyTheme(LS.get('theme', 'light'));
setLayout(LS.get('layout', 'both'));
// 初始界面固定为 Markdown 空文档；「上次选择的类型」只在新建文档时生效（见 newNote）
applyKind('md', false);
function applySidebar(open) {
  state.sidebarOpen = open;
  LS.set('sidebar', open ? '1' : '0');
  $('sidebar').classList.toggle('hidden-left', !open);
  $('btn-sidebar').setAttribute('aria-pressed', String(open));
  // 抽屉态下打开侧栏会盖住正文，给个半透明遮罩提示"点别处会收起"（样式在 .sidebar-shown）
  document.body.classList.toggle('sidebar-shown', open);
  // 按钮文字描述「点下去会发生什么」，而不是同时写两个状态；
  // 收起状态下按钮仍在原位，写着「展开列表」。
  const label = $('sidebar-toggle-label');
  if (label) label.textContent = open ? '收起列表' : '展开列表';
  $('btn-sidebar').title = (open ? '收起' : '展开') + '笔记列表（F6）';
}
applySidebar(LS.get('sidebar', '1') === '1');
$('btn-sidebar').onclick = () => applySidebar(!state.sidebarOpen);
$('btn-sidebar').setAttribute('aria-pressed', String(state.sidebarOpen));
/* 抽屉态点遮罩收起：遮罩是 .workspace::after，命中时 event.target 就是 .workspace */
document.querySelector('.workspace').addEventListener('click', e => {
  if (!document.body.classList.contains('is-drawer') && !document.body.classList.contains('is-narrow')) return;
  if (e.target.closest('#sidebar') || e.target.closest('#btn-sidebar')) return;
  if (state.sidebarOpen) applySidebar(false);
});
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
  let cfg;
  try {
    cfg = await ensureConfig();
  } catch (e) {
    setStatus('笔记目录初始化失败：' + e, 'error');
    return;
  }
  // 先取回自定义顺序再列列表：否则首屏按"未记录顺序"排，随后又被重排一次
  await loadOrder();
  await refreshList();
  // 打开上次编辑的笔记（仍在列表中才打开）
  const last = LS.get('last_open', '');
  if (last && state.notes.some(n => n.file_name === last)) {
    await openNote(last);
  } else {
    // 没有打开任何笔记时，预览区给空态引导，而不是一片空白
    renderPreviewEmptyState(true);
  }
  // 顶栏只放一个短状态；"自动保存已启用"写进状态点的 title，不再占一行文字
  setStatus('就绪');
  maybeShowFirstRun();
  layoutForWidth();
})();
