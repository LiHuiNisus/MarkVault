# MarkVault — 开发进度

## 2026-10-11：按用户逐条要求收尾（10 项）

1. **Word 导出写真 DOCX**：新增 `zip = 9`（deflate）依赖，`export.rs` 用 `build_document_xml`
   + `write_docx_zip` 打包 [Content_Types].xml / _rels/.rels / word/document.xml /
   word/styles.xml / word/_rels/document.xml.rels。前端 `buildDocxPayload` 把 Markdown 解析成
   结构化段落（heading/paragraph/list/code/quote）传给后端。菜单项从 `.doc` 改为 `.docx`
   （「标准 Word 文档，可直接编辑」）。3 条新单测校验 ZIP 魔数、部件齐全、XML 转义、坏载荷拒绝。
2. 导入前弹框改名：**不做**（用户决定）。
3. 「新建文件夹」图标按钮：**保留图标**（用户决定）。
4. **新建即显示占位条目**：`refreshList` 在 `state.current` 无 `file_name` 时插入 `li.draft`
   （虚线框 +「编辑中…」），标题输入实时同步到占位行文字；保存后由整表重建自然替换为真实条目。
5. **查找替换**：`#find-bar` 增加「替换为」输入框 + 替换 / 全部替换按钮，Ctrl+H 直达替换框。
   替换走 `applyEdit`（execCommand insertText），整批替换可一次 Ctrl+Z 撤销。
6. **删掉死代码**：`window.MV` 调试钩子（438 字符，无任何消费方）已移除。
7. 深浅两套代码块变量已核对齐全，无需再改。
8. **删除进系统回收站**：`store::delete_note` 改用 `SHFileOperationW` + `FOF_ALLOWUNDO`
   （静默、无确认，确认由应用自己的弹窗负责），回收站不可用时退回直接删除。新增
   `tests/recycle.rs`：用 PowerShell 读回收站条目数，删前删后计数必须增加——若退回永久删除会失败。
   确认弹窗文案改为「将移入系统回收站，可从回收站恢复」。
9. 自动保存失败保持顶栏提示（未做横幅，用户认可）。
10. **图片链路验证 + 格式/大小限制**：仅接受 PNG/JPG/JPEG 且 ≤10MB。
    - 后端：`commands.rs` 新增 `MAX_IMAGE_BYTES`、`normalize_image_ext`、`save_asset_in`、
      `read_asset_in`（后两者带目录参数便于测试）；超限/格式错分别返回
      「图片大小不能超过10M」「仅支持JPG、PNG、JPEG格式的图片」。
    - 前端：`handleImagePaste` 在调后端前先按 MIME 与 file.size 拦一轮，文案与后端一致；
      `bytesToBase64` 分块（0x8000）拼接，避免大图 `String.fromCharCode.apply` 爆栈。
    - 6 条新单测 + 2 个无头脚本（`image-base64-test.js` 校验分块编码与 Buffer 逐字节一致；
      `image-flow-test.js` + `_image-sandbox.js` 覆盖 GIF/BMP 拒绝、超限拒绝、边界值放行、
      JPEG→jpg 归一化、后端错误原样透出、纯文本粘贴不拦截）。

### 浏览器端到端验证（真实 ui/ + mock Tauri 桥）

`tmp-tests/harness/`：把 `ui/` 拷进去，前置一个 `mock-tauri.js` 内存实现（含 serde 风格的
**返回值克隆**，避免前端 state 别名到 mock 内部对象），起 `python -m http.server` 后用
Chrome DevTools 驱动真实 `app.js`。已验证：首次引导、预览空态、占位条目、自动保存后替换为真实行、
顶栏路径与字数、查找计数 1/3、全部替换 3 处、标签结构化筛选（正文含该词不被带出）、
图片粘贴三种拒绝 + 成功插入 + 预览 data URL、`docx` 载荷逐块正确、导出 toast、
右键移动到文件夹后**顶栏路径与 last_open 同步更新且继续编辑正常保存**（P0 回归）。

测试合计：26 单测 + 20 文件夹集成 + 1 回收站集成 = 47，另有 7 个无头脚本。

## 2026-10-10：6 角色用户模拟评测 → P0/P1 修复（用户要求「P0 + P1 全部」，一档一编译）

评测报告见 `.sdd/ux-review-2026-10-10.md`（6 个 subagent 分别扮演新手/键盘流/整理型/长文/导出/容错，逐条 file:line 证据）。

### 第 1 档 P0（已完成，PID 9396 验证过）
1. **换库丢字**：`btn-vault-dir` 选完目录直接 `set_config` + `location.reload()`，无 `doSave`。改为先 `if (state.dirty) await doSave()`，失败中止并提示；加确认框说明不自动迁移。
2. **关窗保存失败仍强关**：`doSave` 改为返回成败；`close-requested` 只在成功时 `close_window`，失败保持窗口并提示。`doSave` 错误写入持久 `saveError`，`openNote` 的「就绪」不再抹掉它。
3. **重命名文件夹后笔记分裂**：改名成功后把 `state.current.file_name` 前缀从旧名换成新名 + 同步 `last_open`，避免自动保存按旧路径写回、`create_dir_all` 重建旧文件夹。
4. **每键全量重渲染**：`onEditorInput` 拆两级——高亮走 `requestAnimationFrame` 合并，预览 `render()` 加 120ms 防抖。行号由 `offsetHeight` 改 `getBoundingClientRect().height` 保留小数，消除累积漂移。
5. **下拉菜单键盘不可选**：新增 `initMenuNav`，打开聚焦首项，接管 ↑↓/Home/End/Enter/Space/Esc。
6. **笔记列表零键盘**：`#note-list` 加 `tabindex`/`role=listbox`，方向键移动、Enter 打开、F2 重命名、Delete 删除、左右折叠文件夹、空格多选、Ctrl+A 全选、Esc 清空选择。
7. **删除无回收站**：`store::delete_note` 改为移入库内 `.trash/`（重名追加 `-2`），`list_folders` 隐藏项过滤自动跳过，3 条新集成测试。

### 第 2 档 P1 数据/整理（已完成，PID 36308 验证过）
- 删除非空文件夹改取全量列表算成员（搜索态下曾只搬走可见子集）。
- 右键菜单补「删除此笔记」「在资源管理器中显示」「仅看此文件夹」；「复制当前文档/文档路径」更名「复制此笔记文件/此笔记路径」。
- 内联重命名失焦改为取消（原来会静默写入半截标题）。
- 自动保存加 8 秒最大等待，连续打字不再长时间不落盘。
- 真实标签筛选：`search_notes` 加 `tags`/`folder` 结构化参数（AND 组合，标签只比 frontmatter）；新增 `list_tags`、`rename_tag`（批量改/删/合并标签）。
- 新增筛选条 `.filter-bar`，显示生效的标签/文件夹筛选与多选计数，可逐个清除。
- 多选批量操作：Ctrl/Shift 点击、空格、Ctrl+A；拖拽整组；右键「移动到…」对整组生效；新增 `move_notes` 命令。
- 导入改多选（`blocking_pick_files`），文件名保留原名（不再加时间戳前缀），`sanitize_stem` 清洗非法字符。
- 拖拽落点扩到文件夹内笔记行（把笔记拖到某文件夹的笔记上也算放进该文件夹）。
- 新建文件夹输入框与失败提示说明「不支持嵌套 / 非法字符」；删除文件夹失败说明可能含非 .md 文件。
- 顶栏「文件夹」改名「笔记库位置」，切换前弹确认说明不搬运旧笔记。
- 标签栏加 `max-height: 96px` + 滚动。

### 第 3 档 P1 写作/键盘/导出/引导（已完成，PID 37940 验证过）

写作体验
- 滚动同步改为**标题锚点对齐**（原来纯百分比映射，长文必然错位）；无标题时退回百分比。
- 大纲改为**解析源码**而非预览 DOM：仅编辑模式可点可跳，点击同时滚动编辑区到该行并同步预览；高亮跟随编辑区滚动（原来只在预览滚动时更新）。
- 大纲默认只列 H1–H3，底部「显示全部层级」开关。
- 字数统计口径修正：先剥代码块/行内代码/图片/URL 再计数，中文标点计入「字」。预览工具条 + **顶栏各显示一份**（仅编辑模式下预览工具条整体隐藏，原来字数会消失）。
- 新增「插入表格」按钮（弹出行×列，生成对齐的管道表骨架）；编辑器高亮新增表格行着色。
- 新增「插入图片」按钮 + **粘贴截图**（`ClipboardEvent` → `.assets/` → 插相对路径）；预览里相对图片路径经 `read_asset` 转 data URL 显示（WebView2 里 file:// 加载不到）。
- 分隔条宽度写入 `localStorage.editorWidth`，重开恢复。
- 深色模式代码块底色 `#1a1d27` → `#222634` + 描边（原来与面板几乎同色）。

键盘
- Ctrl+K 插链接、Ctrl+P 聚焦搜索、Ctrl+Shift+L 循环布局、Ctrl+Shift+T 切主题、F6 切侧栏。
- Ctrl+B/I/K 焦点不在编辑器时先聚焦编辑器再执行（原来静默失效）。
- 查找跳转后 Enter 继续跳下一个（原来焦点回编辑器，Enter 变成插入换行且改到正文）。
- 编辑器内 Ctrl+Tab 移出焦点（原来 Tab 被无条件吃掉，纯键盘出不去）。
- `prompt-modal` 的 Esc 挂到 document 捕获阶段（焦点在按钮时也能关）。

新手引导与命名
- 首次运行引导卡片（`mv_first_run`），三条步骤，点「知道了」后不再出现。
- 预览区空态文案；左栏空态保留。
- 顶栏新增**笔记相对路径**（可点击在资源管理器中定位）。
- 「文件夹」按钮改名「笔记库位置」，切换前弹确认说明不搬运旧笔记。
- 「新建文件夹」按钮 title 说明用途；新建文件夹输入框 placeholder 写明「仅一层，不支持 / 嵌套」。

导出与反馈
- 导出默认文件名改用**笔记标题**（`sanitize_filename` 清洗非法字符），标题为空才退回内部文件名。
- PNG 导出改为离屏克隆 + 解除高度/溢出约束，按内容真实尺寸截图（原来只截可见一屏）。
- `@media print` 加 `break-inside: avoid`（代码块/表格/图片/引用不被分页劈开）与标题 `break-after: avoid`。
- 新增 `showToast`：导出/复制成功弹右下角浮层，导出带「打开所在文件夹」动作（新增 `reveal_path`、`reveal_note`）。
- 导出菜单每项加小字说明（HTML 可再编辑、PDF 版式固定、PNG 超长会截断等）。
- 导入改多选 + 保留原文件名（不再加时间戳前缀）。

标签管理
- 标签右键菜单：重命名（批量改写全部笔记）/ 删除（从全部笔记移除）；`store::set_tags` 只改标签不动 `modified`。

测试：16 单测 + 20 集成 = 36 全过。

### 回归审查发现并修复（PID 38528）

独立审查 agent（Chromium + mock Tauri 驱动真实 app.js 实测）发现 10 处，全部已修：

- **[P0] 单篇移动把 `state.current` 覆盖成字符串**：`move_note` 返回的是新路径字符串，不是 NoteMeta。改为只更新 `file_name`/`folder`/`last_open`/顶部路径（`moveNote`、`moveSelected` 两处）。
- **[P1] 查找 Enter 一次跳两格**：find-input 的 Enter 冒泡到全局「编辑器内 Enter 续跳」分支。`e.stopPropagation()` + 该分支加 `e.target === $('editor')`。
- **[P1] 列表键盘焦点卡死**：`rows` 含被折叠的隐藏行，`focus()` 无效。过滤 `offsetParent !== null`。
- **[P1] 空态文案被导出带走**：`renderPreviewEmptyState` 原来写进 `#preview`，导出 HTML/PNG 会印上引导语。改为 `.preview-empty-layer` 覆盖层，不写 `#preview`；`render()` 非空时也传 `false` 收掉。
- **[P1] setext 标题漏解析**：`parseHeadings` 只认 `#{1,6}`，补 `===`/`---` 下划线式标题（H1/H2），避免大纲与预览标题错位。
- **[P2] 点大纲预览停半路**：`scrollIntoView({smooth})` 与锚点同步互拉。`syncPreviewToLine` 改为直接设 `scrollTop` 并抢占 `syncFrom` 锁 700ms；大纲点击先定位预览再滚编辑区。
- **[P2] renderPreviewEmptyState 无 false 分支**：补上，形参不再空转。
- **[P2] 查找计数显示 0/3**：`runFind` 先归一化 `findIdx` 再写文案。
- **[P2] 删除笔记残留顶栏路径文本**：补 `textContent = ''`。
- **[P2] 删除/重命名文件夹未同步 folderFilter**：改名跟着换、删除则清空，否则列表空白。

## 2026-10-06 深夜 4：用户反馈 3 问题修复

1. **标题下拉不能点选**：浏览器复测下拉打开/菜单项点击/H2-H6 替换全部正常（menuShown=true、### 替换成功）。真实 app 里疑似命中过一次缓存问题。已让用户重试验证；Chrome 实测通过。
2. **加粗选区与实际加粗不一致**：排查 textarea 与 highlight 层字体/断行（长文软换行逐项对比 diff={}，高度一致）、按钮 mousedown 不清选区。mock 复测精确选区 `审阅**问题一二三四**五六…` 全对，选区落在内容上。未复现；待用户具体操作路径。
3. **斜体/删除线/下划线再点恢复**：与 MarkPane 不同（MarkPane 斜体无 toggle），按用户要求加 toggle。新增 toggleInlineFormat：
   - 对称定界符（`*`/`~~`）走 toggleDelimitedInline
   - 非对称（`<u>…</u>`）三分支：两侧紧邻 / 整段含标记 / 同行内向两侧找最近标记对
   - '~~~~' 全选剥成空串（toggle 语义，合理）
   浏览器 18 断言全过（含'下划线整体选中'初判 FAIL 系测试脚本选区长度 8 应为 9，非产品缺陷）。

app.exe 已重启（PID 20320）。

## 2026-10-06 深夜 3：subagent 测试结论 + 3 缺陷修复 + 标签按钮补齐

**subagent 独立测试总结论：PASS**（14 按钮 + 标题下拉 6 级 + 链接弹窗 4 路径 + undo 深度链 100 步往返，无 console error、无崩溃）。

**subagent 发现 3 缺陷，全部已修**：
1. 加粗跨行选区产出 `****` → toggleDelimitedInline 补跨行分支（整段含 `**` 选区/紧邻外侧均剥）
2. 任务模式不剥普通 bullet（`- b` → `- [ ] - b`）→ stripListMarker('task') 补 `[-*+]` 前缀剥离
3. 加粗纯 `**` 选区产出 `******` → formatBold 补 rejectPattern `/^\*+$|^_+$/`

**补齐**：工具栏新增「标签」按钮（btn-tag，accent 色 `<badges>` 包裹）——subagent 发现 insertTag 无入口。

**复测**：浏览器 mock 复验 15 项全过（含 3 缺陷复现场景、混合 bullet `- a\n* b\n+ c` 全剥、badges 包裹、undo 回归）。
初测一处"FAIL"实为测试脚本自身选区长度写错（0..9 应为 0..11），已用 `ta.value.length` 重验排除。

app.exe 已重启（PID 26976），等用户验收。

## 2026-10-06 深夜 2：工具栏按钮重写（对齐 MarkPane 源码语义）

**背景**：用户反馈工具栏按钮不能正常操作。下载 MarkPane 真实源码（markpane.js 458KB + i18n.js）逐函数比对后全部重写。

**MarkPane 语义落地方（app.js 315-560 行）**：
- wrapSel：空选区/纯定界符选区（rejectPattern）插中文占位，插入后选中内容本身
- toggleDelimitedInline + resolveDelimUnwrapRange + findEnclosingDelimPair + maskInlineCode：加粗三态剥离（包住选区/紧邻外侧/同行内包围），支持 `__`，跳过行内 code 里的假定界符
- 斜体无 toggle（MarkPane 同，再点=再包一层）
- formatQuote 逐行 `> `；prefixLines('ordered'/'unordered'/'task') + applyListPrefix：有序自动重编号、空行插 3 占位项且任务首项 `[x]`
- insertHeading 替换整行 `#{0,6}` 前缀；insertCodeBlock 无前导换行（MarkPane 同）
- insertHorizontalRule 前后自动补空行；insertTag `<badges tone>` 四色
- 链接：WebView2 无 prompt()，新增 #link-modal 弹窗（确定/取消/Enter/Esc）
- 下划线 `<u>` 新增按钮；预览 enhancePreviewHtml：badges→彩色胶囊、u.md-u；DOMPurify ADD_TAGS badges/u ADD_ATTR tone

**按钮绑定**：14 个按钮 + 标题下拉 6 项全部真实 onclick；Ctrl+B/I 快捷键指向新函数。

**主线程浏览器自测（harness + mock Tauri，55+ 断言）**：31 场景全过（含三态剥离、重编号、占位、undo 栈、弹窗四路径、badges 渲染、高亮层同步）。
**待办**：subagent 独立模拟真人测试进行中。

## 2026-10-06 深夜：滚动同步根因修复（.pane 不撑高）

**问题**：上一版“同步”实为假象——`.main .pane { flex: 1; min-height: 0; }` 未设 overflow，
`#editor-scroll`（.editor-body）与 `.preview-content` 高度被内容无限撑开（scrollHeight == clientHeight），
max 恒为 0，ratio 映射根本没生效；用户鼠标滚轮实际滚动的是整个页面级容器。

**修复**（style.css 一行）：
```css
.main .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
```
两个滚动容器恢复正常：`#editor-scroll` max≈6114、`#preview` max≈7869，ratio 映射开始真正工作。

**浏览器实测（Chrome DevTools，300 行文档）**：
- 编辑器→预览 0%/50%/100% 三点偏差 ≤0.3px
- 预览→编辑器 30% 反向同步偏差 0.2px
- 防回环锁有效（位置稳定不振荡）
- textarea 无内部滚动条（滚轮不被截留）
- 7/7 测试全过

app.exe 已重启（PID 25180），等用户验收。

## 2026-10-06 晚：功能迭代 + 两轮 subagent 测试通过

新增需求全部落地：
1. 编辑/预览滚动同步（比例映射 + 120ms 回环锁）
2. 工具栏对齐 MarkPane：SVG 图标 + 撤销/重做；前缀开关（引用/任务/无序/有序互切不叠加）；execCommand('insertText') 保撤销栈
3. 笔记列表显示标签芯片（点击筛选，stopPropagation）
4. 标签搜索（Rust search_notes：标题 → 标签 → 正文三级）

测试轮次：
- 第 1 轮 FAIL 3 阻断项 → 修复：hl-line display:block 缺失（P0 编辑区错位）、toggleLinePrefix 清理顺序（P1）、undo/redo 失效（P1）
- 第 2 轮 PASS + 新发现 P1（有序列表 '2. '/'3. ' 重复前缀）→ 已修：CLEAR 表加 OL_RE 正则 /^\d{1,9}[.)] /；顺带删 applyEdit 重复 onEditorInput 调用（P3 双渲染）
- 最终状态：node --check OK，app.exe（PID 36760）运行中，等用户验收

遗留（不阻断）：
- .line-num 固定行高，长行软换行行号错位（需按渲染高度同步）
- 有序列表多行不重编号（每行都 '1. '）
- execCommand deprecated 但 WebView2 支持良好

## Context

用户需求：
1. 打开 MarkVault 时默认展示上次打开的文件夹与已有文档列表。
2. 新 UI 与 https://www.vibepm.net/markpane/editor.html 样式一致：实时预览、目录、视图设置、编辑工具栏、自动保存。

## 已完成（全部落盘）

### ui/index.html（重写）
- header-bar：M logo / MarkVault / 标题输入（filename-input 样式）/ 保存按钮 / 导出下拉 / 文件夹按钮
- sidebar：新建按钮 + 搜索 + 笔记列表 + 标签栏（可点筛选），可整栏收起
- side-rail（图标栏）：打开（侧栏开关）、新建、目录、视图下拉（编辑+预览/仅编辑/仅预览）、主题切换
- outline-panel：滑出式文档目录（H1-H6），点击滚动定位
- editor-block：标签行 + 格式工具栏（H1-H6 / B / I / S / 引用 / 有序 / 无序 / 任务 / 行内代码 / 代码块 / 链接 / 线条）+ 行号 gutter + 语法高亮编辑层 + textarea
- resizer：编辑/预览宽度拖动
- preview-block：实时预览 + 字数统计

### ui/style.css（重写）
- MarkPane 配色：accent `#6C5CE7`、浅色 `#f0f0f0` 画布 + 白色 `14px` 圆角面板、完整 `data-theme="dark"` 变量组
- 代码块 mac 三色圆点、引用块主题色左边线、h2 主题色竖条
- 打印/PDF 白底样式保留

### ui/app.js（重写）
- localStorage（mv_ 前缀）：theme、layout、sidebar、outline、last_open
- 启动：ensureConfig → refreshList → 自动打开 last_open 笔记（列表中存在才打开）
- 编辑器：行号 + 逐行语法高亮（标题/加粗/斜体/行内代码/链接/引用/围栏/删除线/水平线），textarea 透明文字 + caret 主题色
- 预览：marked + DOMPurify，outline 生成、滚动同步高亮、字数（中文字 + 英文词）
- 保存：2s 自动保存 + Ctrl+S；保存后更新 last_open
- 视图：layout-both/edit/preview + resizer 拖动（flex-basis）
- 快捷键：Ctrl+S/B/I/N/F、Esc 关菜单
- 搜索 250ms debounce
- 导出：html/md/doc/pdf(print)/png(dom-to-image) 逻辑保留
- close-requested 保存链路保留

### Rust 后端
- 无改动。`cargo build` 通过，`cargo test --lib` 7 passed

## 验证状态

- app.exe（debug）已多次重启验证，进程正常
- `node --check app.js` 语法通过
- 上次文件夹自动加载：config.json 已有 `本地笔记库路径`，list_notes 直接读取

## 后续可做

- release 构建 + NSIS 打包：`cargo tauri build`
- 版本号 bump 0.1.1（Cargo.toml / tauri.conf.json）
