# 当前进度

## 2026-10-24 收尾：版本升 0.1.3、修失效文案、重建打包、提交

上一轮遗留的四件事全部做完。

1. **失效提示文案**（`ui/app.js` 的 `doSave` catch 分支）：原来写「笔记文件夹不可用，请在顶栏更换文件夹」，
   但顶栏换库按钮早在 `612676a`（10-11）就按需求删了，用户照做找不到入口。改为如实报出目录路径
   （`state.config.vault_dir`）并提示检查是否存在与写入权限。harness 副本已同步。
2. **版本 0.1.3**：`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 同步升号。
3. **bundle identifier**：`net.markvault.app` → `net.markvault.desktop`。原值以 `.app` 结尾，macOS 打包会
   把 bundle 当成应用目录名，是已知隐患。改名后 WebView2 数据目录随之变化
   （`%LOCALAPPDATA%\net.markvault.app` → `net.markvault.desktop`），已把旧目录的
   `EBWebView\Default\Local Storage` 复制到新目录，主题/布局/上次打开等偏好不丢。
4. **重建 + 打包**：`cargo build --release` → `cp target/release/app.exe ../app.exe` →
   `cargo tauri build`，产出 `MarkVault_0.1.3_x64-setup.exe`（2.45 MiB）。NSIS 会再 patch 一次 release 产物，
   所以打包后又把 `target/release/app.exe` 重新 `cp` 回仓库根，两边 md5 一致（`73805488`）。

### 验证

- `cargo test`：33 lib + 20 folders + 1 recycle = 54 项全过。
- harness 九套探针全跑：`qa-markdown` / `qa-rich` / `qa-library` / `qa-keys` /
  `rich-e2e` / `rich-e2e2` / `rich-layout` / `rich-link-geometry` 均 0 失败；
  `rich-link-tooltip` 是可视化诊断脚本，输出几何数据与截图，本身不做断言。
- 真机（`app.exe` + CDP 9333）实测：窗口正常、22 篇笔记列出、上次打开的富文本笔记自动载入、
  类型开关为锁定态、笔记库指向 `D:\MarkVault\src-tauri\target\debug\notes`、
  运行中的 `doSave` 源码已含新文案且旧文案不存在。

### 未完成

- 安装包未实际执行安装（`D:\MarkVault` 里是旧版 0.1.2 的安装产物，直接覆盖安装会重写 exe）。

## 2026-10-24：模拟真人使用，四路并行 QA，修复 18 个缺陷

按「模拟用户操作、找 bug 并自动修复」的要求，把编辑体验分成四块（Markdown 编辑、
富文本 Quill、笔记库/导出、快捷键与持久化），各派一个子代理在 harness 里用真实坐标点击
跑探针，共 ~230 项检查。缺陷全部修复后，四套新增探针与四套既有探针均 0 失败。

### Markdown 编辑器（`tmp-tests/qa-markdown.py`，12 → 0）

1. **弹窗按 Enter 会在插入内容后多一个换行**：`promptInline` / `openLinkPrompt` 的
   keydown 没 `preventDefault`，`done()` 交回焦点后 Enter 的默认行为打到 textarea 上。
2. **表格弹窗同上**，首行只剩 `| `。
3. **多行选区止于下一行行首时多吃一行**：选区 `aaa\nbbb|ccc` 的末字符是换行，那一行并没被
   选中，`expandToLines` 却把它算进去，列表/引用/代码块都多包了一行。
4. **行内代码连点两次叠成 ``` ``world`` ```**：`formatInlineCode` 没走开关语义。
5. **光标在行内代码内部点按钮会撕裂代码**（`hello \`w\`代码\`orld\` end`）：原因是
   `findEnclosingDelimPair` 先用 `maskInlineCode` 把反引号区域涂成空格，目标定界符自身被涂掉。
   新增 `raw` 参数给反引号走不屏蔽的分支，`formatInlineCode` 改走 `resolveDelimUnwrapRange`。
6. **代码围栏内能加标题**：新增 `inFenceAt()`，围栏内拒绝并提示。
7. **查找期间改正文后 Enter 选中的是旧位置**：`onEditorInput` 不重跑 `runFind`，
   命中偏移全过期。改为输入时若查找栏开着就重算。
8. **无结果时编辑器 Enter 打不出换行**：全局 Enter 分支没判 `findHits.length`。
9. **切换笔记后编辑器停在中段**：`openNote` 不重置 `scrollTop`。
10. **切换笔记后查找计数仍是上一篇的**：同上，切笔记时重跑 `runFind`。

### 富文本（`tmp-tests/qa-rich.py`，3 → 0）

11. **撤销栈跨笔记泄漏**：`newNote` 只 `setContents([])` 没 `history.clear()`，
    新笔记里按 Ctrl+Z 会把上一篇正文整段复活，2 秒后自动保存又写成一个新 `.html`。
    `newNote` / 删除当前笔记 / 切类型三处都补了 `history.clear()`。
12. **网页复制来的图片存成 base64 大块**：`richImagePaste` 只接 `kind === 'file'` 的剪贴板项，
    走 `text/html` 的 data URL 图片直接落盘。新增 `externalizeInlineImages()`，把内联图
    逐个落进 `.assets/` 并登记到 `state.richAssets`，保存时换回相对路径。
13. **外部 HTML 里的坏图原样落盘**（`<img src="x">`）：`richHtmlForSave` 现在只保留
    登记过的内联图和 `http(s)` 远程图，其余连标签丢掉（有 alt 时退化成文字）。

### 笔记库（`tmp-tests/qa-library.py`，5 → 0）

14. **删掉当前笔记后继续打字会静默丢失**：`state.current` 置空后 `doSave` 直接返回成功，
    敲的字只进内存。新增 `beginDraft()`，在无当前笔记时首次输入即升级为新草稿并自动保存。
    删除后回到空态（列表提示 + 预览引导），输入即重建。
15. **搜索/筛选无结果时只显示一排空文件夹**：加空态分支，文案区分「没有匹配的笔记」
    与「该文件夹里还没有笔记」。

### 快捷键与布局（`tmp-tests/qa-keys.py`，24 → 0）

16. **弹窗打开时全局快捷键照常生效**：在链接弹窗里按 Ctrl+B 会把加粗打到背后编辑器的旧选区，
    Ctrl+N 直接新建、Ctrl+Shift+L/T 切布局切主题。新增 `anyModalOpen()` 统一拦截。
17. **焦点在输入框时 Ctrl+B/I/K/N 抢焦点**：标签框里按 Ctrl+B 跳到编辑器并加粗。新增
    `typingInField()`，输入框里只放行保存/查找/主题/布局。
18. **替换框里 Esc 关不掉查找栏**：`replace-input` 的 keydown 做了 `stopPropagation`，
    全局 Esc 收不到。补了本地 Esc 分支。
19. **弹窗没有焦点陷阱**：连按 Tab 会跑到页面上其它控件，弹窗看着还开着。新增 `trapFocus()`。
20. **Tab 缩进吃掉选中文字**：单行选区按 Tab 把选区替换成两个空格。改为在行首加缩进、选区右移。
21. **窄窗口/拖到最右时预览被挤出 main 被裁掉**：`.main.layout-both` 的 `min-width: 320px`
    在 900×600 下放不下两块；改成 `min(320px, calc((100% - 12px)/2))`。分隔条上限也扣掉
    resizer 宽度与两处 gap，并加了 window resize 时重新夹紧。
22. **刷新后编辑器滚动位置丢失**：新增按笔记路径记录滚动位置的 `mv_scrollPos`。

### 其他

- `delete_note` 改为返回 `bool`：`true` 进了回收站，`false` 说明回收站不可用、已永久删除。
  前端据此如实提示（原先实现会静默退回 `remove_file`，与确认框「可从回收站恢复」矛盾）。
- 删除确认文案改为「文件会移入 Windows 回收站，需要找回时在回收站里还原」——
  应用内不做回收站 UI 是设计决定，文案不再暗示应用内有恢复入口。

验证：`cargo test` 54 项全过；`qa-markdown.py` / `qa-rich.py` / `qa-library.py` /
`qa-keys.py` 全部 0 失败；既有 `rich-e2e.py` 29、`rich-e2e2.py` 19、`rich-layout.py` 20、
`rich-link-geometry.py` 41 项无退化；控制台无 JS 报错（favicon 404 除外）。

未完成：产物已构建（`src-tauri/target/release/app.exe`），但运行中的实例（PID 35608）
占着仓库根的 `app.exe`，替换失败，需先退出应用再 `cp`；未提交。

## 2026-10-23：新增富文本笔记类型（Markdown / 富文本二选一，创建后锁定）

编辑页标签行加了类型开关。新笔记可选 Markdown 或富文本，落盘后类型固定不可改；
打开已有笔记时按磁盘扩展名判定并锁定。

- Markdown 笔记：仍是 `xxx.md`，走原来的 textarea + 高亮层 + marked 预览。
- 富文本笔记：`xxx.html`，Quill 2.0.3 所见即所得，无独立预览、强制单栏。
- 类型由磁盘扩展名唯一决定，不写进 frontmatter（`store::kind_of_name`）。

详细设计与改动清单见 `docs/rich-text-notes.md`。

验证：`cargo test` 53 项全过；`tmp-tests/rich-e2e.py` 29/29、`rich-e2e2.py` 19/19、
`rich-layout.py` 20/20；Markdown 全流程回归无退化；控制台无 JS 报错。

未完成：`app.exe` 已构建（`src-tauri/target/release/app.exe`）但被运行中的实例占用，
未替换到仓库根的 `app.exe`；未提交。

## 2026-10-22 第二轮：模拟真人点击编辑器工具栏，修复 5 个缺陷

按要求模拟真人操作，在 harness（`tmp-tests/harness/`，端口 8791，mock Tauri 桥）里逐个真实点击
编辑页的 18 个按钮（撤销 / 重做 / 标题下拉 6 项 / 加粗 / 斜体 / 下划线 / 删除线 / 引用 / 任务 /
无序 / 有序下拉 2 项 / 行内代码 / 代码块 / 链接 / 图片 / 表格 / 标签 / 线条），
覆盖有选区、无选区（光标在行首 / 行中 / 行尾 / 空行 / 空文档）、跨行选区、多行选区等多种状态，
并用 `elementFromPoint` + `mousedown/mouseup/click` 在按钮真实坐标上触发，而不是直接调函数。

### 定位到并已修复的缺陷

**1. 引用 / 无序 / 任务 / 有序 / 代码块：选区落在行中间时插在行内，Markdown 不生效**

选区是 `hello world` 的 `world` 部分时，点「引用」得到 `hello > world`，点「无序」得到
`hello - world`，点「代码块」得到 `abc``` `。三者都是块级标记，必须占整行，插在行中只是普通文字，
预览仍是普通段落（实测预览 HTML 为 `<p>hello - world</p>`）。

修：新增 `expandToLines(s, e)` 把选区向外扩到整行边界，`formatQuote`、`prefixLines`、
`formatOrderedCircleList`、`insertCodeBlock` 全部改为整行替换。

**2. 圆形有序列表把标题行的 `#` 带进 `<li>`**

`### abc` 转圆形列表后输出 `<li>### abc</li>`，`#` 原样显示在预览里。
修：转列表项前先剥 `#{1,6}` 前缀。

**3. 引用按钮无开关语义，重复点击叠成 `> > >`**

原实现无条件加 `> `。整段已引用时再点一次变成 `> > a`；选区里部分行已引用时，未引用的和已引用的
混在一起被统一加前缀，同样叠加。
修：全部非空行都带 `>` 时剥一层（再点即取消）；部分引用时只给未引用的行补 `> `。

**4. 表格按钮会吃掉选中文字**

有选区时 `insertTable` 用 `s..e` 替换，选中内容直接消失，只剩表格骨架。
修：插入点收敛到 `selectionEnd`，正文原样保留，表格另起一块。

**5. 线条按钮同样吃掉选中文字**

`insertHorizontalRule` 同上，`hello world` 选中 `world` 后点线条，`world` 被替换成 `---`。
修：同上，改为在选区末尾插入。

### 验证

- `node --check ui/app.js` 通过；harness 已同步。
- 18 个按钮逐个真实坐标点击，全部有响应，无 `elementFromPoint` 被遮挡（最小窗口 900×600 下也全部在视口内）。
- 修复后逐项复测：`> hello world`、`- hello world`、`- [ ] hello world`、`1. hello world`、
  ```` ```\nhello world\n``` ````、`<ol class="ol-circle"><li>hello world</li></ol>`，预览全部渲染成对应块级元素。
- 引用开关：`> a\n> b` 再点为 `a\nb`；`> a\nb\n> c` 混合选区点为 `> a\n> b\n> c`（不叠加）。
- 表格 / 线条：`hello world` 选中 `world` 后插入，正文完整保留，表格另起段落。
- 撤销 / 重做：12 个按钮逐个「执行 → Ctrl+Z → Ctrl+Y」，`undone === 原值 && redone === 执行后值` 全过。
- 查找跳转回归：40 处命中逐个 Enter，`40/40` 命中在编辑区视口内（上一轮修复未退化）。
- 导出 5 种格式（html / md / docx / pdf / png）：全部成功，toast 与「打开所在文件夹」动作正常；
  `export_note` 注入失败时状态栏为 `导出失败：目标文件被占用`。
- 图片：「插入图片」成功路径、格式错 / 超限 / 其他错误三条失败路径文案正确；
  粘贴 PNG 成功、GIF 拒绝、11MB 拒绝、纯文本粘贴不被拦截。
- 表格弹窗：`3x4` / `2x2` / `1x1` 正常，`99x99` 夹到 30×12，`abc` 报「表格格式无效」，
  Esc / 点背景 / 取消按钮均能关闭且不改正文。
- 链接弹窗：确定 / Enter / Esc / 点背景 / 空 URL 五条路径正常。
- 其他回归：Tab / Shift+Tab（单行与多行）、Ctrl+Tab 移出焦点、Ctrl+B/I/K、Ctrl+S/N/P/H、
  Ctrl+Shift+L 循环布局、Ctrl+Shift+T 切主题、预览任务复选框回写源码、字数统计、
  大纲跟随滚动（4 个位置）、双向同步、拖拽分隔条并持久化 `mv_editorWidth`。
- 控制台无任何 JS 报错。

## 2026-10-22 第一轮：查找翻找时命中不出现在视口内

### 根因

`ui/app.js` 的 `gotoFindHit()` 用「源码行号 × 行高」估算滚动位置：

```js
const line = v_countLines(ta.value, s);
const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
$('editor-scroll').scrollTop = Math.max(0, line * lineH - $('editor-scroll').clientHeight / 2);
```

这个估算只在「一行不换行」时成立。正文里有长段落时，一个逻辑行会软换成 3–5 个视觉行，后面的行号
就越估越偏。实测 300 段长中文时：第 7 处命中真实位置约 3448px，实际只滚到 762px；第 14 处真实
6741px，只滚到 1859px。更极端的情形是单段软换行成一个近 5000px 高的「行」，把整行居中也看不到
命中字符。

### 修改（全部在 `ui/app.js`）

1. `hlLineTop(line)`：读高亮层里对应 `.hl-line` 的真实像素顶端，替代「行号 × 行高」。
2. `scrollEditorToLine(line)`：按真实几何把该行居中；拿不到元素时才退回行高估算。
3. `hlTextRectAt(el, col)`：用 `Range` 精确定位高亮层里第 `col` 个**字符**的矩形。
   只量一个字符——量整段会拿到跨多个视觉行的并集矩形，位置就没有意义。
4. `scrollEditorToPos(pos)`：直接把命中字符本身滚到视口中间。高亮层与正文不一致时先
   `renderHighlight()` 再量，避免拿替换后的旧几何定位。
5. `gotoFindHit()` 改为调用 `scrollEditorToPos(s)`。
6. 大纲面板点击改走 `scrollEditorToLine(h.line)`；聚焦 + 设置选区会触发 textarea 自身滚动，
   跳转后再校正一次位置。
7. `renderHighlight()` 记录 `hlSrc`，供跳转前判断高亮层是否过期。
8. `updateOutlineFromEditor()` 改用标题行真实位置，原来按 `scrollTop / lineHeight` 换算。
9. `syncScroll()` 双向同步改用标题真实像素位置 + 相邻两标题之间线性插值。原写法按固定系数 0.9
   搬运偏移，会越过下一个标题，导致两侧显示相邻两个不同章节。

新增 `lockSync(ms)` 硬锁：大纲点击期间两侧锚点同步全部让路（350ms）。

### 验证

- 43 处命中逐条断言，Enter 正反向全部可见，不可见 0；单行超长软换行 5/5 可见。
- 命中在行首 / 行中 / 行尾三种位置均可见；文档最末段正确停在滚动上限。
- 替换后立即跳转正确；大纲点击 6 个位置全可见；双向同步 18 个采样点一致。

## 尚未完成

- 没有重新构建 `app.exe`，没有打包。
- 没有提交（用户未要求）。
- 工作区未提交改动：`ui/app.js`（+176 / −50），以及未跟踪的 `progress.md`。
  `tmp-tests/` 被 `.gitignore` 忽略。
