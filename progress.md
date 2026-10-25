# 当前进度

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
  注册表 `DisplayVersion` 变为 `0.1.4`、`InstallLocation` 仍为 `D:\MarkVault`。
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

用 `MarkVault_0.1.3_x64-setup.exe /S` 静默安装到 `D:\MarkVault`（覆盖 0.1.2 的安装产物）。

- 注册表 `HKCU\...\Uninstall\MarkVault` 的 `DisplayVersion` 已是 `0.1.3`，`InstallLocation` 为 `D:\MarkVault`，
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
