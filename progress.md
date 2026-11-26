# 当前进度

## 2026-11-26 侧栏「新建」下拉被裁切修复

用户反馈：光标移到「＋ 新建笔记」右侧箭头打开的下拉里，每行只剩「新建…」「导入…」几个字。
根因是菜单按 `left:0` 往右展开，192px 宽的菜单有约 150px 越过 `#sidebar` 的 `overflow:hidden`
边界被整块裁掉。`ui/style.css` 给 `#new-dropdown .dropdown-menu` 加 `left:auto; right:0`，
菜单改为向左展开，完整落在 268px 侧栏内（`overflow:hidden` 保留，圆角与列表滚动依赖它）。

- 1280/1180/1020/900 四档宽度、抽屉态、键盘操作（Enter/↓/Esc 回焦、点外部关闭）均验证无截断。
- 顺手按常用操作回归：新建/改名/切换/自动保存、保存失败保护、搜索与筛选、文件夹与批量操作、
  表格/任务/图片/链接、视图与主题、侧栏与抽屉、快捷键等，未发现新的可复现缺陷。

### 打包 0.1.9 并重装

- 版本号 0.1.8 → 0.1.9，只动三处：`src-tauri/Cargo.toml`、`tauri.conf.json`、`Cargo.lock` 里
  `app` 那一节（同文件里 `jiff-tzdb` / `zerofrom` 也是 0.1.8，不能全局替换）。用 Python 按字节改，
  无 BOM、CRLF 不变，diff 各一行。
- `cargo tauri build` 2m00s，产出 `MarkVault_0.1.9_x64-setup.exe`
  （2.51 MiB / 2,631,956 字节，FileVersion / ProductVersion 均 0.1.9）。
- `setup.exe /S` 静默安装（退出码 0）覆盖 `〈安装目录〉`；注册表 `DisplayVersion` 已是 0.1.9，
  `InstallLocation` 仍是 `"〈安装目录〉"`；装后 `app.exe` 11,912,192 字节、版本 0.1.9。
- 装机后真机核对（CDP）：`__TAURI__.app.getVersion()` 返回 `0.1.9`；「新建」下拉
  `[77,111,191,129]` 完整落在侧栏 `[10,278]` 内，四项文字均未截断，截图
  `tmp-tests/newmenu-after-019.png`。
- 工作区改动：`ui/style.css`、`progress.md`、`.sdd/progress.md`、`Cargo.toml`、`tauri.conf.json`、
  `Cargo.lock`，未提交。

## 2026-11-20 打包 0.1.8 并重装

功能改动（`79b4307`）只改了 `ui/` 与一处 Rust 排序，不改 `Cargo.toml` 的话装出来的还是
0.1.7 的壳、看不到新界面；同号重发又会让人分不清手里是新是旧，所以升到 0.1.8 再装一次。

- `Cargo.toml` / `tauri.conf.json` / `Cargo.lock` 版本号 0.1.7 → 0.1.8。
  注意：这三个文件**不能用 PowerShell 的 `Set-Content -Encoding utf8` 改**——那会写入 BOM
  （实测首字节变成 `EF BB BF`），`Cargo.toml` 带 BOM 时 `[package]` 解析会出问题。
  这次用 Python 按字节读 UTF-8、正则替换后原样写回，diff 只有版本号一行，无 BOM、无 CRLF 变动。
- `cargo tauri build` 1m58s，产出 `MarkVault_0.1.8_x64-setup.exe`
  （2.51 MiB / 2,630,088 字节）。NSIS 会对 release 产物再补一次 bundle 类型信息，
  打包后重新把 `target/release/app.exe` 复制回仓库根 `app.exe`，两边 `FileVersion` 均为 0.1.8。
- 静默安装覆盖 `〈安装目录〉`（`setup.exe /S`，退出码 0）；注册表 `DisplayVersion` 已是 0.1.8，
  `InstallLocation` 仍是 `"〈安装目录〉"`。

### 装机后核对（CDP 连装好的 0.1.8）

- WebView2 子进程命令行里 `--webview-exe-version=0.1.8`，确认跑的是新装的这份。
- 新建弹窗：能打开、两个格式选项、默认项只有一个「上次使用」角标、顶部写明落点，
  取消后列表行数不变（不落盘）。
- 富文本工具栏：20 个按钮 + 4 个下拉（段落样式 / 颜色 / 背景 / 对齐），表格与分隔线按钮各 1 个，
  无被裁切、无点不到的按钮，正文区仍高 574。
- 真机插入分隔线成功、撤销后恢复，重新载入该笔记 `hr` / `table` 数量与插入前一致（未污染用户笔记）。
- 真实新建一篇 Markdown：排在根目录第一位，切「自定义顺序」仍在第一位；随后经原生确认框
  （后台线程点「删除」按钮）删除该临时笔记，行数回到 28，笔记库仍是 11 篇 md + 6 篇 html。

### 未做

- 未提交 0.1.8 的版本号与本轮记录（下一步单独提交）。
- `set-...` 之外的打包产物（`target/`、`app.exe`、安装包）按 `.gitignore` 不入库。

## 2026-11-19 新建格式弹窗 + 新建排最前 + 富文本工具栏扩充

用户提的四条：① 新建时弹框选 Markdown / 富文本；② 新建的笔记排在根目录最前；
③ 富文本的编辑功能太少，按竞品补常用按钮；④ 自查上述功能并主动修 bug。

### 改了什么

1. **新建格式弹窗**（`ui/index.html` 的 `#new-note-modal` + `ui/app.js` 的 `newNoteKindModal()`）
   - 入口统一收口到 `newNote()`：侧栏按钮、`Ctrl+N`、新建菜单、文件夹「在此新建文档」都会先弹框。
   - 默认选中 `mv_kind` 上次用过的类型并挂「上次使用」角标；顶部写明会保存到哪个文件夹。
   - 键盘：方向键在两选项间切换（radiogroup 语义），回车＝创建，`Esc`＝取消；取消不新建、不清正文、清掉 `pendingNewFolder`。
   - `anyModalOpen()` 加入该弹窗，弹窗开着时全局快捷键让路。
2. **新建笔记排最前**（`prependToOrder()` + Rust `sort_metas()`）
   - 首次落盘时把新键 `unshift` 进 `.markvault-order.json` 对应桶，自定义顺序下立刻最前；
     新建后强制整表刷新（草稿占位行要换成真实行）。
   - Rust 三种排序都补 `file_name` 兜底（文件名前缀是创建时间戳），并列项不再每次刷新乱跳。
3. **富文本工具栏 12 → 20 按钮 + 4 个下拉**
   - 新增：文字颜色、背景色、对齐、减少/增加缩进、上标/下标、任务列表、插入表格、插入分隔线。
   - 表格走 Quill 自带 `modules/table`（之前文档里"核心没有表格"的结论是错的，实测 2.0.3 有）；
     分隔线自注册 `divider` blot（`<hr>`）+ clipboard matcher。
   - `.ql-toolbar` 改 `flex-wrap: wrap`，900px 最小窗口换行不裁切；补表格边框 / `hr` / 勾选态 / `ql-align-*` 样式。

### 自查时发现并修掉的 bug

- `openNote()` 切类型只清目标侧编辑器：打开富文本后隐藏的 textarea 还留着上一篇 Markdown，
  导出/字数/查找能读到它；反向亦然。现在两侧都清并清掉 Quill 撤销栈。
- `newNote()` 同样补成两侧都清；`render('')` 后再 `renderRichWordCount()`，否则富文本字数显示按 Markdown 口径算成 0。
- `closeTablePicker()` 先把焦点交回编辑器再隐藏弹窗，避免焦点落到 body。

### 验证

- `node --check ui/app.js` 通过；`cargo test` 60 项（39 + 20 + 1）全过；`cargo build --release` 成功，
  仓库根 `app.exe` 已用新产物覆盖（当时仍是 0.1.7；随后升 0.1.8 重新打包，见上一节）。
- harness（8791）：`qa-rich.py`、`rich-e2e.py` 34 项、`rich-e2e2.py` 19 项、`rich-layout.py` 20 项、
  `rich-link-geometry.py` 41 项、`p2_resp/p2_recent/p2_table/p2_media/p2_scrim` 全绿；
  新增 `_r7_roundtrip.py`（颜色/对齐/表格/分隔线/待办 落盘重开 15 项全过）、
  `_r14_switch.py`（md↔rich 互切不串内容）、`_r5_modal.py`（弹窗布局/暗色/键盘）。
- 真机 CDP（9222，只读 + 一次真实新建后删除）：新建弹窗/落点提示/取消不落盘、富文本 20 按钮无裁切无死按钮、
  菜单回归、无 JS 报错；真实新建一篇后确认排在根目录第一位并写进顺序表，随后删除并清理顺序表残留键。
- harness 探针改造：新建要先弹框，18 个脚本的 `#btn-new` 调用统一改为「点开 → 选类型 → 确认」。
- 与本轮无关的既有失败（改动前后结果一致）：`qa-keys.py` 3 项、`qa-order.py` 3 项、
  `qa-audit.py` 9 项（HTML5 drag 合成事件在此环境不触发）、`qa-markdown.py` 的 `#btn-save` 陈旧选择器。

## 2026-11-01 打包 0.1.7 并重装

空弹框修复（`a52a319`）只改了 `ui/`，而 `ui/` 是打进 `app.exe` 的，必须重新打包才生效，
所以把 0.1.6 → 0.1.7 再装一次。同号重发会让装过的人分不清手里是新是旧，不能图省事。

- `cargo tauri build` 49s，产出 `MarkVault_0.1.7_x64-setup.exe`（2.50 MiB / 2,618,547 字节）。
- 入库看是 0.1.5 → 0.1.7：上一次 0.1.6 的版本号改动当时没提交，一直留在工作区，
  所以这次一并升到 0.1.7（0.1.6 从未单独入库，只存在于装机的那份产物里）。
- 静默安装 `setup.exe /S`，退出码 0；注册表 `DisplayVersion` 已是 0.1.7，`InstallLocation` 仍为 `〈安装目录〉`。
- 仓库根 `app.exe` 用本轮 release 产物覆盖，`FileVersion` / `ProductVersion` 均为 0.1.7。

### 装机后核对（CDP 连真机）

- **空弹框已消失**：`#tb-more-dropdown` 的 `hidden` 属性与 `getComputedStyle().display`
  终于一致（1280 宽下 `true` / `none`，按钮真的不显示），`#tb-more-menu` 子节点 0 个、不弹框。
  `.dropdown[hidden]` 与 `.dropdown-menu.show:empty` 两条规则确认已进样式表（`cssRules` 里能查到）。
- **有内容时菜单正常**：把布局切回 `both` 后，1000 宽收 3 项（下划线 / 删除线 / 行内代码，172 × 99.3）、
  940 与 900 宽收 5 项（+ 标签徽章 / 插入分隔线，172 × 159.3），全部在屏内、无横向滚动。
- 顶栏「更多」菜单 6 项、高度 189.3，文案不变。
- 回归：19 篇笔记 19 行、摘要 / 复选框 / 相对时间（`10-11`，`title` 2026-10-11 12:39:39）齐全、
  行高 66、标签胶囊 2 个、类型徽标 `Markdown`、`#batch-bar` / `#scope-note` / `#save-state` / `#btn-tags` 都在、
  无 `#title-input`、工具栏 1 行 35px、980 宽进单栏（侧栏 `x=-306`）且拉回 1280 还原 `both`、`errors: []`。
- 布局 `both` 下 1280 宽时 18 个按钮全在轨道内（15 个 `button` + 3 个 `dropdown` 容器），
  无一被裁、`elementFromPoint` 全部命中自身；切到 `edit` 单栏（轨道 510 但容器 960）自然收进「更多」。
- 笔记库未改动：`notes\` 11 个文件、`..\MarkVault` 4 个文件，修改时间仍是 10-17。

## 2026-11-01 修复「更多格式」空弹框

编辑工具栏右侧的「⋯」在按钮全放得下时（≥1180 宽、或 ≤1100 的单栏/收起侧栏）依然显示，
点开是一块空白。两个原因叠在一起：

1. `layoutToolbar()` 靠 `toolbarMore.hidden = true` 收按钮，但 `.dropdown` 自己设了
   `display:flex`，优先级高于浏览器给 `[hidden]` 的 `display:none` —— 这条 hidden 从来没生效，
   按钮一直看得见（`getComputedStyle` 是 `flex`，`hidden` 属性却为 `true`）。
2. 此时 `#tb-more-menu` 里一个子节点都没有，`.dropdown-menu.show` 只设了 `display:flex`，
   于是弹出一个 172×9 的空框（只剩 padding）。

修法（`ui/style.css` + `ui/app.js`，不动 HTML）：

- `.dropdown[hidden] { display: none !important; }` —— 让 hidden 真的生效，也不需要 JS 兜底。
- `.dropdown-menu.show:empty { display: none; }` —— 任何空菜单都不显示，防以后再踩。
- `bindMenu()` 里加一道：`if (!m.children.length) { closeAllMenus(); return; }`，
  空菜单点了不弹框。

### 验证

- 宽度扫描 1440/1280/1190/1180/1150/1100/1050/1000/980/900：`moreDisplay` 与 `moreHidden` 一致
  （能放下时 `none`，"更多"真的消失），有内容的菜单点开正常（1280 收 3 项、1190 收 5 项、1050 收 2 项）。
- 顶栏其他菜单（更多 / 导出 / 视图 / 标题）仍全部可开，项数与文案不变。
- 回归：`p2_toolbar.py` / `p2_resp.py` / `p2_recent.py` / `p2_table.py` / `p2_scrim.py` 全绿，`errors: []`。
- `ui/` 三个文件无 BOM。

## 2026-11-01 打包 0.1.6 并重装

P0/P1/P2 的 22 条整改提交为 `25fedb3` 后，出安装包并覆盖安装。

- 版本 0.1.5 → 0.1.6（`Cargo.toml` / `tauri.conf.json` / `Cargo.lock` 一处）。
  同号重发会让装过的人分不清手里是新是旧，必须换号。
- `cargo tauri build` 51s，产出 `MarkVault_0.1.6_x64-setup.exe`（2.50 MiB）。
  NSIS 会对 release 产物再打一次 bundle 类型信息，打包后重新把
  `target/release/app.exe` 复制回仓库根 `app.exe`。
- 静默安装覆盖 `〈安装目录〉`（`setup.exe /S`，退出码 0），注册表 `DisplayVersion` 已是 0.1.6。

### 装机后核对（CDP 连真机，只读）

- 版本：仓库根 `app.exe` 的 `FileVersion` / `ProductVersion` 均为 0.1.6，注册表同步。
- P0/P1：无 `#title-input`、类型徽标在有值、19 行笔记全带摘要（取正文首行截断）、
  全带复选框与相对时间（`10-11`，`title` 里是 `2026-10-11 12:39:39`）、行高 66、
  标签胶囊 2 个、`#btn-tags` / `#batch-bar` / `#scope-note` / `#save-state` 都在。
- P2：工具栏 1 行 35px（`trackW == trackSW == 510`）、表格选择器 64 格默认「3 × 3」、
  最近笔记 5 篇（另有 4 篇可切）、980 宽进单栏且侧栏收到 `x=-306`、无横向滚动、拉回 1280 还原 `both`。
- 页面错误 0；笔记库 `notes\` 11 篇、`..\MarkVault` 4 篇，修改时间未变。

### 注意

- 打包后 `target/release/app.exe` 已被 NSIS 写入 bundle 信息，与仓库根 `app.exe`
  （从打包前的产物复制）md5 不同是预期行为，判断装没装成功要看 `VersionInfo` 与注册表。
- CDP 探针要在启动前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`；
  安装程序启动的那份实例不带这个变量，9222 会连不上，需要手动重启一次 `app.exe`。

## 2026-11-01 P2 交互整改：工具栏 / 表格 / 图片与任务 / 最近笔记 / 响应式

走查报告与逐项验收：`..\MarkVault-UX-Review\`（`P2修复说明-20261101.md`、`p2-shots\`）。
前端改 `ui/` 三个文件；后端只给 `PickedImage` 加了 `name` 字段（`pick_image` 返回原文件名，
用于图片 alt），**存储格式与命令签名未变**。

### 改了什么

1. **工具栏（P2-1）**：18 个按钮收成一行 35px，全部去中文标签只留图标 + `title`。
   新增溢出引擎 `layoutToolbar()`：先量 `scrollWidth > clientWidth`，再按 `data-tb` 优先级
   把最低频的按钮逐个搬进「⋯ 更多格式」菜单，直到放得下；菜单按原顺序重排，空了就藏起来按钮。
   搬走的按钮保持原有 onclick（只动 DOM），加 `.in-more` 与 `tabIndex=-1`，不进 Tab 序。
   用 `ResizeObserver` 监听工具条本身（`window.resize` 早于 CSS 重排，切布局/收侧栏后会量到旧值）。
2. **表格（P2-3）**：弹窗换成 8×8 网格选择器（悬停实时显示「4 × 5」，默认 3×3，键盘可走）；
   预览里的表格 hover 出浮层：＋行 / ＋列 / −行 / −列 / 删除表格。「删除表格」走 `applyEdit`，可撤销。
   表格定位按源码里 pipe 块的顺序对齐（`tableBlocksOf` 要求第 2 行是分隔行）。
3. **图片与任务（P2-4）**：粘贴/选择图片时 alt 取文件名（`产品发布合影.png` → `产品发布合影`），
   双击图片改说明（`promptInline` + `updateImageAlt`）；任务勾选从「整篇重写」
   改成只替换 `- [ ]` / `- [x]` 那一个字符的 `applyEdit`，滚动位置与撤销粒度都不再被打乱；
   Word 导出丢图时状态点转 `warn`（黄），toast 附「改用 PDF 导出」。
4. **最近笔记（P2-5）**：「⋯ → 最近打开的笔记」列出最近 5 篇（标题 + 文件夹，同名笔记可区分）；
   `Ctrl+Tab` 前后轮换 MRU，`Ctrl+Shift+Tab` 反向。列表存 `localStorage` 的 `mv_recent`，
   读时过滤掉已删除的笔记。
5. **响应式（P2-2）**：≤1180px 侧栏变覆盖式抽屉（不挤压正文，打开时压一层可点穿的遮罩），
   ≤1020px 正文默认单栏（双栏会挤成两条缝），目录面板在窄窗改浮层。窗口拉回去时还原
   原来的布局与侧栏开合（只还原「自动收起」的，用户手动收的不动）。

### 这一轮实测发现并修掉的三个新问题

- **抽屉遮罩盖住顶栏**：`.workspace::after` 的 `z-index:30` 与 `header` 的 `z-index:10` 在根层叠
  上下文里比较，抽屉一开，顶栏连同下拉菜单整块点不动（Playwright 报 `workspace intercepts pointer events`）。
  给 `.workspace` 补 `z-index:0`，把遮罩关进自己的层叠上下文。
- **从宽屏直接跳到 ≤1020 不收侧栏**：原判断只在「进入抽屉档」时收，跨档（1440 → 980）时漏掉，
  单栏下侧栏是整屏浮层，等于正文被列表盖住。改成 `mode && !prev` 就收。
- **Ctrl+Tab 按一下切两次**：编辑器 keydown 与 document keydown 都调了 `cycleRecent`，净位移为 0，
  看起来像没反应。编辑器只 `preventDefault`，切换交给 document。

### 验证

- `node --check ui/app.js` 通过；`cargo test` 39 + 20 + 1 全过；`cargo build --release` 46s，
  产物已覆盖仓库根 `app.exe`。
- harness（1440 / 1100 / 900）：
  - 工具栏三档都是 1 行 35px；1440 无溢出，1100 只有「行内代码」进更多（标签正确），
    900 无溢出；Tab 序只有 1 个落点（`btn-undo`）；点「更多」里的按钮真的插入 `` `代码` ``。
  - 表格：默认 3×3、悬停到「4 × 5」、插入 4×5、加行 4→5、加列 5→6、减行 5→4、减列生效、
    删除后 `tables 0`、撤销后回到 1，表头与正文都保留。
  - 图片/任务：alt 取文件名、双击改说明生效；40 个复选框勾选后 `scrollTop` 358→358、
    字数 1471→1471、只改第 30 行；Word 丢图状态 `warn` + toast 带「改用 PDF 导出」。
  - 最近笔记：打开 3 篇后列表 3 条（最新在前）、Ctrl+Tab 从「需求评审」到「产品周报」、
    Ctrl+Shift+Tab 反向并回绕、撤销只影响当前篇、浮层 2 行且完全在屏内、点行切换、点外面关闭。
  - 响应式：1440 三栏 / 1100 抽屉（侧栏 `x=-306`，正文 534+534，无横向滚动）/
    900 单栏（正文 880，目录改浮层 `absolute`）/ 拉回 1440 还原 `both`。
    一行汉字数：1440 双栏 30 字、1100 双栏 28 字、900 单栏 **49 字**（改前三栏时约 20 字）。
- 真机（CDP 连 WebView2，只读）：工具栏 1 行 35px；980 宽进单栏且侧栏自动收起、
  抽屉打开时顶栏「更多」可点且菜单能开；表格选择器 64 格居中；最近笔记浮层 4 行在屏内。
  笔记库文件数与修改时间未变（`notes/` 11 篇、`..\MarkVault` 4 篇）。

### 未做 / 注意

- P0–P2 的改动仍未提交（用户未要求）；`tmp-tests/` 被 `.gitignore` 忽略。
- 安装包仍是旧构建，需 `cargo tauri build` 后重装才会生效。
- 工具栏溢出依赖容器宽度，`ResizeObserver` 不可用时退化为 `window.resize` + 120ms 防抖。

## 2026-11-01 P1 交互整改：列表 / 搜索 / 多选 / 文件夹 / 状态 / 长文 / 富文本 / 引导

走查报告与逐项验收：`..\MarkVault-UX-Review\`（`P1修复说明-20261101.md`、`p1-shots\`）。
前端改 `ui/` 三个文件；后端只加了派生字段与一个命令，**数据格式未变**（摘要不落盘）。

### 改了什么

1. **列表**：相对时间（今天 17:03 / 昨天 / 周四 / 10-23）+ 一行正文摘要；
   行高 71 → 64（有标签）/ 45（无标签）；标签 10→10.5px 并加深颜色。
2. **对比度**：时间 2.64:1 → 4.83:1，标签 4.0:1 → 5.55:1（都过 AA）。
3. **搜索**：后端给命中片段（`snippet_around`），列表直接显示"为什么命中"；
   当前笔记被筛掉时，编辑区顶部出现「不在当前筛选结果中」+ 清除筛选。
4. **多选**：行首复选框（悬停/选中显形）+ 底部批量条（移动 / 删除 / 取消）；
   右键不再把行变成「已选 1 项」，菜单只作用于点中的行（除非它本就在多选里）。
5. **文件夹**：新建旁边改成下拉（新建笔记 / 新建文件夹 / 导入 / 帮助）；
   文件夹行 hover 出「⋯」，复用右键菜单的文件夹分组；新建后滚动到该文件夹并闪一下。
6. **状态**：操作成功一律走 toast；错误同时弹一条 9 秒的红色 toast（顶栏状态点只有 12px，
   长错误会被省略号吃掉）；保存状态仍由状态点负责。
7. **长文**：预览只在可见布局下渲染、并放到 `requestIdleCallback`；
   切回双栏时补渲染。600 行文档连续输入 36 字的长任务从 2 次（50/53ms）降到 0。
8. **富文本**：Ctrl+F / Ctrl+H 可用（查 Quill 纯文本，跳转/替换下标一致）；
   「⋯ → 另存为富文本副本」；大纲空态文案随类型重建。
9. **拖动排序**：排序方式不是「自定义」时先弹确认，不再静默改掉整个列表的排序规则。
10. **标签**：输入框接 `datalist` 候选；新增 `list_tags` / `list_tag_counts` / `rename_tag` / `delete_tag`，侧栏「标签」入口打开管理面板（篇数 + 改名/合并/删除）；保存时去重、去空、去 `#`。
11. **引导**：改成右下角非阻断卡片（可关闭），新建下拉与「更多」里都能重开「使用帮助」。

### 验证

- `node --check ui/app.js` 通过；`cargo test` 38 + 20 + 1 全过（新增摘要单测）。
- harness：摘要/相对时间、批量条与移动、文件夹 ⋯、新建下拉、标签候选、标签改名/合并/删除、富文本查找 1/1 与替换、
  另存为富文本、搜索命中片段与范围提示，全部通过；长任务 0。
- 真机（`cargo build --release` 后 CDP 连 WebView2）：摘要正常、时间显示「17:03 / 昨天 / 周四」、
  批量条「已选 1 篇」、文件夹 ⋯ 四个动作、标签候选 2 个、标签面板列出 2 个带篇数、富文本查找 1/61。
- 截图：`..\MarkVault-UX-Review\p1-shots\`（含真机 `real-p1-main.png`）。

### 未做 / 注意

- 900px 下三栏仍偏挤（响应式布局，报告里的 P2）。
- 仓库根 `app.exe` 已用本轮 release 覆盖；安装包需 `cargo tauri build` 后重装。

## 2026-11-01 P0 交互整改：顶栏重组 / 标签真筛选 / 键盘路径 / 类型徽标

走查报告见 `..\MarkVault-UX-Review\MarkVault交互走查与优化建议-20261101.html`，
修复说明见 `..\MarkVault-UX-Review\P0修复说明-20261101.md`。只动了 `ui/` 三个文件 +
`commands.rs` 里一句对话框标题，数据格式与接口未变。

### 改了什么

1. **顶栏重组（P0-3）**：删掉与正文重复的 `#title-input`，标题只留正文上方一处；
   顶栏从 8 个平级控件收敛到「品牌 / 收起列表 / 状态点 / 字数 / 导出 / ⋯」。
   保存按钮去掉（自动保存是常态，状态点可点即强制落盘，Ctrl+S 不变）；
   路径从顶栏 pill 挪进「更多 → 在文件夹中显示」；主题挪进「更多」。
2. **窄窗溢出（P0-1）**：`style.css:150` 的媒体查询原来写在基础规则之前、被同权重规则覆盖，
   现在是死代码已删，改到顶栏规则之后重写（1024 / 960 两档）。
   900px 时按钮组右边缘从 1037px 收到 890px，页面无横向溢出。
3. **标签真筛选（P0-2）**：新增 `state.tagFilter`，点列表里的标签胶囊 = 加筛选 chip，
   再点移除；`refreshList` 传 `tags` 给后端（`search_notes` 早就支持），
   与搜索框、文件夹筛选 AND 叠加。此前点标签是把标签名塞进搜索框走全文匹配，
   实测会把正文里恰好出现该词的笔记带出来。
4. **导入改名（P0-4）**：「打开」→「更多 → 导入本地文档…」，toast 说明「复制到笔记库，
   原文件未改动」；Rust 文件框标题改为「导入 Markdown 文档（复制进笔记库）」。
5. **键盘（P0-5）**：工具栏 18 个按钮改成单一制表位（roving tabindex，←/→/Home/End 组内移动），
   从标题 Tab 到正文由 24 次降到 7 次，另有 Enter（标题框）/ Ctrl+Alt+E 一步到正文；
   打开笔记后自动聚焦正文；F6 在输入框里也能用（原来被 typingInField 提前 return 吃掉）。
6. **类型徽标（P0-6）**：落盘后隐藏可点的类型开关，改为标题旁的只读徽标
   （Markdown / 富文本），不再出现「点了报创建后不可更改」。

### 验证

- `node --check ui/app.js` 通过；`cargo test` 37 + 20 + 1 全过。
- harness 实测：顶栏 `#title-input/#btn-save/#btn-open/#btn-theme/#header-path` 均已不存在；
  打开笔记后 `document.activeElement=editor`；工具栏 `tabIndex=0` 的按钮 1 个；
  点「需求评审」只返回 1 篇（此前 2 篇，含 1 篇误命中），chip 显示 `#需求评审`，再点恢复 13 篇；
  900px 下 `header-actions.right=890 < 900`，「更多」菜单右边缘 890 在视口内。
- 真机（`cargo build --release` 后 `app.exe`，CDP 连 WebView2）：顶栏 4 组控件、无保存按钮、
  工具栏 1 个制表位、更多菜单三项、点标签只出 1 篇并带 chip，控制台无报错。
- 截图：`..\MarkVault-UX-Review\p0-shots\`（含 900px、深色、富文本、真机）。

### 未做 / 注意

- 900px 下三栏仍偏挤（标题会被徽标压缩），属报告里的 P1「响应式布局」，本轮未动。
- 安装包仍是旧版本；要让已安装的 0.1.5 生效需重新 `cargo tauri build` 并安装。
- 仓库根 `app.exe` 已用本轮 release 覆盖（0.1.5，2026-11-01 18:43）。

## 2026-10-25 修「文档拖不动」：Tauri 默认接管了拖放，需关 dragDropEnabled

用户报「文档还是不能拖动排序」。之前的探针全部在 harness 里跑：harness 是纯浏览器，
HTML5 拖拽天然可用，所以一直没暴露这个问题。真机上拖不动。

### 根因

Tauri 2 在 Windows 上默认把 WebView2 的拖放控制器接管为自己的 `DragDropEvent`
（wry 里调 `ICoreWebView2Controller4::SetAllowExternalDrop(false)`），HTML5 的
`dragstart/dragover/drop` 全部收不到。

`tauri-utils` 的注释写得很直白：

> Disabling it is required to use HTML5 drag and drop on the frontend on Windows since we
> replace the drag drop handler of WebView2.

对应配置项是 `app.windows[].dragDropEnabled`，默认 `true`。

### 修法

`src-tauri/tauri.conf.json` 的窗口配置加 `"dragDropEnabled": false`。

本项目没有用到 Tauri 的 `onDragDropEvent`（`grep onDragDropEvent` 在整个 `ui/` 与
`src-tauri/src/` 里零命中），关掉不会丢功能。

### 为什么旧探针没抓到

`tmp-tests/harness/` 用 `mock-tauri.js` 顶替 Tauri 桥，页面跑在普通 Chromium 里，
不存在 WebView2 拖放控制器。所有 `qa-*.py` 因此都对这个问题视而不见。

### 验证的困难与结论

真机复核改用操作系统级鼠标事件（`SendInput` + 绝对坐标）重放拖动，因为 Playwright 的
`mouse` 在 CDP 上生成的拖拽事件不经过 WebView2 的 OLE 拖放层，复现不出问题。

- 修前（0.1.4 已安装版）：root / 组内 / 文件夹三种拖动，`dragstart` 一次都不触发，
  事件日志全空。
- 修后（0.1.5）：同一脚本三种拖动都走通：
  `ROOT ['START','DROP','reorderNotes']`、
  `INNER ['START','DROP','reorderNotes']`、
  `FOLDER ['START','DROP','reorderFolder']`，顺序真的变了。

注：自动化桌面在测试中途被系统锁屏（前台窗口变成 `LockingWindow`），
后续的重复验证无法再做，已用修前/修后各一轮的对照结果定性。

### 版本与安装

- 0.1.4 → 0.1.5（同号的安装包已经发出去过，必须换号才能区分）。
- `cargo tauri build` 产出 `MarkVault_0.1.5_x64-setup.exe`（2.46 MiB）。
- 静默安装：`./MarkVault_0.1.5_x64-setup.exe /S`。**从 Git Bash 直接跑会弹图形安装向导**
  （参数被当成给 shell 的，没传进去），要写成 `cmd //c "完整路径\\setup.exe /S"`。
  装完注册表 `DisplayVersion` 为 `0.1.5`。

## 2026-10-25 升 0.1.4、重建打包、静默安装

上一轮的代码改动已提交（`fe65dcc`），但安装包还是 10-24 的 0.1.3，不含本轮功能。
这次把版本号升到 0.1.4 并重新打包安装。

### 改动

- `src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 版本号 0.1.3 → 0.1.4。
  同号重发会让装过的人分不清手里是新是旧版本。
- `cargo tauri build`：release 产物 49 秒；NSIS 产出
  `MarkVault_0.1.4_x64-setup.exe`（2.47 MiB）。
- NSIS 会对 release 产物再打一次 bundle 类型信息，所以打包后又把
  `target/release/app.exe` 重新 `cp` 回仓库根 `app.exe`。

### 验证

- `cargo test`：37 lib + 20 folders + 1 recycle = 58 项全过。
- 仓库根 `app.exe` 的 `FileVersion` / `ProductVersion` 均为 `0.1.4`。
- 打包前用 CDP 连真机：排序下拉含 `manual`、`state.order` 有值、`bindFolderDrag` /
  `syncGutterHeights` / `normalizeUrl` 均为 function、`get_order` 返回已存顺序。
- 静默安装 `./MarkVault_0.1.4_x64-setup.exe /S` 退出码 0，
  注册表 `DisplayVersion` 变为 `0.1.4`、`InstallLocation` 仍为 `〈安装目录〉`。
- 安装后再启动复核：同一组功能检查全部通过、13 篇笔记列出、顺序文件的三个文件夹名读回来了。

### 坑（沿用之前的记录）

- 安装后的 `app.exe` md5 与 `target/release/app.exe` 不同是预期行为（NSIS 写入 bundle 信息），
  **不能用 md5 判断装没装上，要看 `VersionInfo` 和注册表 `DisplayVersion`**。
- 强杀 app 会留孤儿 `msedgewebview2.exe`，占着 profile 锁时新实例约 3 秒后静默退出。
  安装/重启前先 `taskkill //IM msedgewebview2.exe //F`。

### 未做

- 仓库没有配置 remote，提交只在本地。
- 仍记录在案不修的三项：撤销图片插入后 `.assets/` 留孤儿文件、富文本图片无缩放/alt 编辑、
  粘贴 60 张图约 1.5 秒卡顿。

## 2026-10-25 续：富文本专项复查，再修 10 处

富文本方向的子代理跑完 144 项检查后回报了 6 个真缺陷和一批体验问题，逐条复核并修复。

### 缺陷

1. **有选区时粘贴图文不会替换选区**（P1）。`dangerouslyPasteHTML(index, …)` 只在光标处插入，
   不动 `range.length`，选中的文字原地留在新内容后面。改为先 `deleteText` 再插入。
2. **富文本里快速「全选 + 删除」后 Ctrl+Z 什么都回不去**（P1）。Quill 的历史按时间窗合并，
   打字后 1 秒内删除会并进同一组，合并后的条目不可撤销，2 秒后自动保存已经把空文档写盘。
   在删除按键到达 Quill 之前 `history.cutoff()` 截断当前批次（监听 keydown，不用 beforeinput）。
3. **旧的 Markdown 查找栏留到富文本笔记上**（P2）。切换笔记时查找栏带着上一篇的命中计数
   留在富文本页面上，Escape 也关不掉。切到富文本时直接关闭；富文本分支的 Escape 也会关；
   `closeFindBar()` 改为把焦点还给当前编辑器的 Quill 实例（原来聚焦隐藏的 textarea，
   等于把焦点丢给 body，之后的输入被静默吃掉）。
4. **Word 导出静默丢掉所有图片**（P2）。DOCX 生成器只写文字块。导出时若有图片，
   状态栏明说「Word 导出不含图片，图片请用 HTML 或 PDF 导出」。
5. **一张不支持的图片（webp）会让整次粘贴失败，连文字都丢**（P2）。
   `externalizeInlineImages()` 改为只丢掉那张图并提示，其余内容照常插入。
6. **链接地址原样落盘**（P2）。`   example.com/p  ` 写进 href 后浏览器当相对路径，
   点开是 `http://tauri.localhost/example.com/p`。新增 `normalizeUrl()`（去空白 + 补 https://），
   Markdown 侧插入与富文本链接气泡保存前都走它。
7. **顶栏在 900px 宽时把页面撑出横向滚动条**（P2）。顶栏按钮组宽 533px 不可收缩。
   加 `@media (max-width: 1024px)` 收紧间距并隐藏顶栏路径（编辑区标题行也能看到）。
   **不能**给 `.header-bar` 加 `overflow:hidden`——导出/视图下拉是它的绝对定位子元素，
   会被一起裁掉，`rich-e2e2` 立刻表现为「导出菜单点不到」。

### 体验

- 富文本大纲补滚动联动（原本只有点击才高亮），并补上 Markdown 侧已有的
  「显示全部层级 / 只看 H1–H3」切换。
- 富文本工具栏补撤销/重做按钮（原本只有快捷键，工具栏上没有入口）。
- 富文本编辑器里 Ctrl+Tab 现在能移出焦点（原来 Tab 只会插入制表符，纯键盘用户被困住）。
- 顶栏字数：纯英文文档显示「N 词」而不是「0 字」。

### 未做（记录在案）

- 撤销插入的图片会在 `.assets/` 留下孤儿文件。要修得延迟落盘或监听历史回滚，
  与现有「保存即写盘」的结构冲突，收益（一张几十 KB 的图）不抵风险。
- 富文本图片没有缩放/alt 编辑。
- 大批量粘贴 60 张图时约 1.5 秒卡顿，无进度反馈。

### 验证

- `cargo test` 58 项全过。
- 十套探针全 0 失败：`qa-audit` / `qa-order` / `qa-markdown` / `qa-library` / `qa-keys` /
  `qa-rich` / `rich-e2e` / `rich-e2e2` / `rich-layout` / `rich-link-geometry`，
  以及子代理的 `qa-user-rich.py`（144 项）。
- 真机（`app.exe` + CDP 9333）：富文本撤销按钮存在且可见、导出菜单只剩 html/docx/pdf、
  大纲「显示全部层级」开关在、顶栏字数为「1 词」。
- 已 `cargo build --release` 覆盖 `app.exe`。未提交。

## 2026-10-25 模拟真人操作排查，修复 11 处缺陷

按「模拟用户操作找 bug 并自动优化」的要求，开了四个子代理分别跑侧栏拖动、
Markdown 编辑、富文本、笔记库与性能（子代理被 429 限流打断多次，剩下的部分我自己接手跑完）。
新增的 `tmp-tests/qa-audit.py` 是最终保留的回归探针：每个断言都先手工复现确认过，
子代理原始探针里有若干错误预期（例如把"Ctrl+N 落在上次选中的文件夹"当 bug），已在代码里注明。

### 富文本

1. **富文本笔记可导出 Markdown / PNG，导出的却是上一篇 Markdown 的内容**（P0）。
   菜单项设了 `hidden`，但 `.dropdown-item { display:flex }` 盖掉了 `[hidden]` 的默认
   `display:none`，两项一直可见可点。`style.css` 补 `.dropdown-item[hidden] { display:none !important }`，
   `exportNote()` 再挡一层（防止旧入口/快捷键绕过）。
2. **切换富文本笔记后目录面板不刷新**，一直显示上一篇的标题（P1）。
   `richLoadHtml()` 换完内容没重建大纲；补 `if (state.outlineOpen) renderOutline()`。
3. **删掉正在编辑的富文本笔记后强制切回 Markdown**（P1）。用户接着打字，输入落到隐藏的
   textarea 里，看着是"打字没反应"，且新笔记存成 .md。改为保留当前类型，只清空内容。
4. **富文本模式下 Ctrl+F 打开了 Markdown 查找栏**（P1）。`typingInField()` 把 Quill 的
   contenteditable 当普通输入框，先一步吃掉了快捷键。改为富文本编辑器不算输入框，
   Ctrl+F 走"富文本不支持查找"的提示分支。
5. **点已选中的类型按钮报「创建后不可更改」**（P2）。锁定判断排在同值判断之前；
   把 `next === state.kind` 提前。

### 侧栏排序

6. **加/删标签后列表行不更新**（P1）。`updateRowMeta()` 只改标题和时间，标签胶囊要等下次整表刷新。
7. **搜索态下改正文，行该消失却留着**（P1）。同因：`updateRowMeta()` 只改这一行。
   搜索或文件夹筛选生效时改为整表刷新。
8. **文件夹改名后组内拖动顺序全部失效**（P1）。顺序表的桶键没换前缀，仍是 `旧名/xx.md`。
9. **文件夹筛选生效时拖文件夹，其余文件夹被挤出顺序表**（P1）。`reorderFolder()` 拿 DOM 当基准；
   改为以已保存顺序表为基准（与 `reorderNotes` 一致）。
10. **拖动未选中的行时，界面仍显示 3 项选中**（P2）。`state.selected` 收敛了但 DOM 和筛选条没同步。
11. **资源管理器里删掉/改名文件夹后，新建会把笔记写进已不存在的文件夹**（P1），
    保存时又把它重建出来——用户看到"删掉的文件夹自己回来了"。
    `refreshList()` 现在会复位失效的 `activeFolder` / `pendingNewFolder` / `folderFilter`。

### 性能与几何

12. **窗口缩放/拖分隔条后行号错位**（P1）。软换行变了但行号高度没重算，200 行时最多错开 13376px。
    改为用 `ResizeObserver` 盯编辑块宽度，变化后重算。
13. **取消「等于默认行高就跳过写入」的优化**：CSS 行高 22.390625px 与高亮层实测
    22.40625px 差 0.0156px，3000 行累计错开 46px。写入本身很便宜（6000 行约 3ms），
    贵的是中间夹着的读取，两趟读取已足够。
14. **`save_order` 冗余写入**：同一份顺序重复发。`persistOrder()` 现在比对上次写盘内容。
15. **删掉的文件夹在顺序文件里留下空桶**，越积越多。全量刷新时清理。

### 验证

- `cargo test`：37 lib + 20 folders + 1 recycle = 58 项全过。
- `tmp-tests/qa-audit.py` 12 组场景全过（重排/跨组/多选/写入次数/改名删夹/排序切换/
  筛选态/键盘/折叠/性能）。160 篇笔记时 `refreshList` 40ms、`openNote` 36ms、按键+保存 30ms。
- 既有九套探针全 0 失败。
- 真机（`app.exe` + CDP 9333）：13 篇笔记、3 个文件夹可拖；富文本笔记的导出菜单只剩
  html/docx/pdf；1053 行笔记行号偏移 0.0px，打开 0ms（缓存命中）。
- 已 `cargo build --release` 并覆盖仓库根 `app.exe`。未提交。

## 2026-10-24 侧栏拖动排序 + 长文打开卡顿

用户要求：文件夹之间可拖动排序；文件夹内笔记可拖动排序；根目录笔记可拖动排序；
修「文档内容多时，点左侧列表加载很慢」。

### 拖动排序

顺序不是笔记元数据，不写进 frontmatter；存在库根的 `.markvault-order.json`
（点开头，既不是笔记扩展名也不是文件夹，扫描时自然跳过）：

```json
{ "folders": ["工作", "灵感"], "notes": { "": ["a.md"], "工作": ["工作/x.md"] } }
```

- 后端 `store::VaultOrder` + `read_order` / `write_order`，命令 `get_order` / `save_order`。
  文件损坏或缺失读成空顺序，不报错也不拖垮启动。
- 排序下拉新增「自定义（拖动排序）」；拖动时自动切到自定义，
  否则刷新会按修改时间重排，用户看到拖完又跳回去。
- 文件夹顺序始终生效（与笔记排序方式无关）；笔记顺序只在自定义模式下生效。
- 拖动手势按 MIME 分成两种：`NOTE_MIME` 拖笔记（同组=排序，跨组=移动并插到落点），
  `FOLDER_MIME` 拖文件夹标头（改文件夹顺序，根目录标头不可拖）。
- `dragover` 阶段浏览器不允许读 `dataTransfer` 内容，因此拖拽对象另存内存
  （`draggingKeys` / `draggingFolder`）；插入位置用鼠标在行的上半/下半判断。
- 顺序表每次都跟磁盘对齐（新增项追加到末尾、消失项删除），但**只在无搜索无筛选时**裁剪：
  筛选态下列表是子集，按子集裁剪会把没显示的笔记从顺序表里删掉。
- 文件夹改名时顺序表的键一起搬，否则新名字掉到末尾。

### 打开长文卡顿

根因在 `renderHighlight()`：按高亮层每行真实高度拉伸行号，写成了边读边写——

```js
hlLines.forEach((el, i) => {
  const h = el.getBoundingClientRect().height;   // 读
  nums[i].style.height = h + 'px';               // 写，布局失效
});
```

每次写样式都让布局失效，下一轮读取又强制同步重排，总计 O(n) 次布局。
实测 6300 行时这一循环 28.8 秒、1400 行 0.8 秒——正是"内容多就慢"。改两趟：
先读完所有高度再统一写入。另外高度等于默认行高的行不写内联样式（九成行没有软换行），
写入量再降一个数量级。同一篇真机 1053 行：旧实现 513 ms，现 59 ms。

顺带两处同源浪费：

- `openNote()` 结尾无条件 `refreshList()`（重新扫库 + 重建全部行）。改为 `syncActiveRow()`，
  只切当前行高亮；行不在列表里时才退回整表刷新。
- `doSave()` 保存后也整表刷新（自动保存每 2 秒一次）。自定义顺序下位置不受时间影响，
  改为 `updateRowMeta()` 只更新该行标题与时间；其余排序仍整表刷新，因为
  modified 变了要重新排序。

### 验证

- `cargo test`：37 lib + 20 folders + 1 recycle = 58 项全过（新增 4 项顺序文件测试）。
- 新增探针 `tmp-tests/qa-order.py`：10 组场景全过（组内排序、根目录排序、文件夹排序、
  跨组拖动插入、拖到标头移入、非自定义排序下文件夹顺序仍生效、搜索态不裁剪顺序表）。
- 既有探针全跑 0 失败：`qa-markdown` / `qa-library` / `qa-keys` / `qa-rich` /
  `rich-e2e` / `rich-e2e2` / `rich-layout` / `rich-link-geometry`。
- 真机（`app.exe` + CDP 9333）复核：13 篇笔记、3 个文件夹均可拖动、顺序写入
  `<vault>/.markvault-order.json`；折叠点击、悬停操作按钮不受 `draggable` 影响；
  5 万字符的笔记打开 239 ms。

## 2026-10-24 富文本工具栏中文化与悬停提示

用户要求：框内每个操作按钮悬停出气泡说明功能，交互与 Markdown 工具栏一致；
富文本所有按钮文字与相关提示文案全部中文，含设置链接的按钮。

### 改动

Quill 的 snow 主题只画图标、不给 `title`，悬停不出提示；标题下拉的 `Normal` /
`Heading 1..6` 与链接气泡的 `Enter link:` / `Visit URL:` / `Edit` / `Save` /
`Remove` 全部写死在 `quill.snow.css` 的伪元素 `content` 里。所以要分两处处理：

- `ui/app.js` 新增 `RICH_BUTTON_TIPS` / `RICH_HEADING_LABELS` 与
  `localizeRichToolbar()`，在 `ensureQuill()` 创建 Quill 后立即调用。
  给 11 个按钮补 `title` + `aria-label`（有序/无序按 `button.value` 区分），
  给段落下拉补 `title`/`aria-label` 与每项的中文名，
  并把链接气泡输入框的 `data-link` 属性改成「粘贴或输入链接地址」——
  Quill 每次打开气泡都用这个属性重设 `placeholder`，改 `placeholder` 会被覆盖。
- `ui/style.css` 用 `.rich-host .ql-snow ...` 覆盖伪元素文案：
  `正文` / `标题 1..6`、`链接地址：`、`访问链接：`、`编辑` / `保存` / `移除`。

### 验证

- harness 下发四个按钮的 `title`、下拉项文案、气泡四种状态（`::before`/`::after`
  计算值）全部中文，`data-link` 已改；无 JS 报错。
- 九套探针全部 0 失败（`qa-markdown` / `qa-rich` / `qa-library` / `qa-keys` /
  `rich-e2e` / `rich-e2e2` / `rich-layout` / `rich-link-geometry`；
  `rich-link-tooltip` 是几何诊断脚本，无断言）。
- 重新 `cargo build --release` + `cargo-tauri build` + 静默安装，真机 CDP 复核通过；
  截图见 `tmp-tests/rich-toolbar-zoom.png`、`rich-picker-zoom.png`。

## 2026-10-24 安装 0.1.3

用 `MarkVault_0.1.3_x64-setup.exe /S` 静默安装到 `〈安装目录〉`（覆盖 0.1.2 的安装产物）。

- 注册表 `HKCU\...\Uninstall\MarkVault` 的 `DisplayVersion` 已是 `0.1.3`，`InstallLocation` 为 `〈安装目录〉`，
  `uninstall.exe` 已更新。
- 安装后的 `app.exe` md5 是 `41da47ce`，与 `target/release/app.exe`（`73805488`）不同——
  NSIS 安装时会往 exe 里写入 bundle 类型信息，这是预期行为，不是装错版本
  （`VersionInfo` 的 `FileVersion` / `ProductVersion` 均为 `0.1.3`）。**因此不能用 md5 判断安装是否成功，改看版本信息。**
- 旧 identifier 的 `%LOCALAPPDATA%\net.markvault.app`（81M WebView2 缓存）已按确认删除；
  新目录 `net.markvault.desktop` 里的 Local Storage 完整，主题/布局/上次打开都在。

### 安装后实测

CDP 连真机：22 篇笔记、上次打开的富文本笔记自动载入、`kind=rich` 已锁定、
运行中的 `doSave` 源码含新文案、控制台无报错。

### 坑

- 静默安装从 Git Bash 直接 `./MarkVault_0.1.3_x64-setup.exe /S` 可以；
  用 `cmd //c "\"路径\" /S"` 会因引号转义失败，报「不是内部或外部命令」。
- 强杀 app 会留下孤儿 `msedgewebview2.exe` 进程；这些进程占着 profile 锁时再启动，
  新实例约 3 秒后以 exit code 0 自行退出（无任何报错、事件日志无记录）。
  清理办法：`taskkill //IM msedgewebview2.exe //F` 后再启动即正常。

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
  类型开关为锁定态、笔记库指向 `〈安装目录〉\src-tauri\target\debug\notes`、
  运行中的 `doSave` 源码已含新文案且旧文案不存在。

### 未完成

- 安装包未实际执行安装（`〈安装目录〉` 里是旧版 0.1.2 的安装产物，直接覆盖安装会重写 exe）。

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

- P0/P1/P2 全部改动已提交为 `25fedb3`（22 条问题，9 个文件，+2326 −315）。
- 「更多格式」空弹框的修复单独提交为 `a52a319`（`ui/style.css` + `ui/app.js` + `progress.md`）。
- 版本号三处（`Cargo.toml` / `tauri.conf.json` / `Cargo.lock`）此前留在工作区未提交，
  本轮直接改成 0.1.7 连同打包记录一起提交，0.1.6 从未单独入库。
- 仓库根 `app.exe` 已用本轮 0.1.7 release 覆盖，该文件被 `.gitignore` 忽略，不入库。
- 安装包 `src-tauri/target/release/bundle/nsis/` 在 `.gitignore` 覆盖范围内，不入库。
