# 富文本笔记：实现记录

## 需求（用户确认）

编辑页加「文档类型」切换：Markdown / 富文本，默认 Markdown。
**一篇文档的类型在创建时确定，落盘后不可更改**——用户原话：「一篇文档不会进行格式切换，刚开始选择 markdown 或者富文本后，输入文本后不再支持变更格式」。

用户选定的方案 A：富文本笔记落盘为独立 `.html` 文件，不作为 `.md` 内嵌 HTML。

## 关键设计决定

| 决定 | 理由 |
|------|------|
| 类型由**磁盘扩展名**判定，不写进 frontmatter | 文件被重命名/移动后，元数据不会与事实矛盾。`store::kind_of_name()` 是唯一判定处 |
| `.md` / `.markdown` / `.html` / `.htm` 都算笔记 | 保持对既有 7 篇 `.md` 完全兼容；`.html` 是新增类型 |
| 富文本编辑器用 **Quill 2.0.3**，vendor 单文件 | 工程无构建步骤（无 package.json），marked/DOMPurify/dom-to-image 都走同一路线。TipTap 要打包器，装不进来 |
| Quill 2 **自带** `modules/table`，只是 snow 主题不给按钮 | 注册 `modules: { table: true }` 后用自建按钮调 `getModule('table').insertTable()`，落盘是 `<table><tbody><tr><td>`，重开可继续编辑 |
| 富文本模式没有独立预览 | 所见即所得本身就是成品，布局强制单栏，视图切换置灰 |
| 富文本笔记**不提供「导出 Markdown」和「导出 PNG」** | HTML → Markdown 有损，不给半截结果；PNG 导出截的是 `#preview`，富文本模式没有预览区。导出菜单里这两项隐藏 |
| 富文本图片：DOM 里存 data URL，落盘换回 `.assets/` 相对路径 | WebView2 加载不到相对路径。**全程字符串替换**，不把 `.assets/` 写进任何 DOM 节点的 src——浏览器会真发请求，离线克隆节点也一样 |

## 改动清单

### Rust

`src-tauri/src/store.rs`
- `NoteMeta` 加 `kind: String`（"md" / "rich"），`skip_serializing_if = "String::is_empty"`
- 新增 `KIND_MD` / `KIND_RICH` 常量、`ext_for_kind()`、`kind_of_name()`、`strip_note_ext()`
- `collect_notes`：扩展名白名单从 `.md` 放宽到四种；`kind` 按扩展名填
- `read_note`：同样按扩展名填 `kind`，frontmatter 里的 kind 一律不采信
- `serialize_note`：序列化前清空 `kind`，不落进 frontmatter
- `strip_note_ext` 带 `is_char_boundary` 检查（中文文件名多字节，直接切片会 panic）

`src-tauri/src/commands.rs`
- `save_note` 新增 `kind: Option<String>` 参数，新建文件按 `ext_for_kind` 生成扩展名
- `dedup_name` 保留原扩展名（原来硬编码 `.md`，会把富文本笔记改回 `.md`）
- `import_one` 保留源文件扩展名
- `import_note` 文件选择框加 html/htm
- 新增 `strip_html_tags()`：搜索前把富文本正文的 HTML 标签剥掉，否则搜 "strong" 会命中所有加粗笔记

`src-tauri/src/config.rs`
- `dedup_path` 同上保留扩展名
- `migrate_notes` 迁移时也搬 `.html`/`.htm`

`src-tauri/src/export.rs`
- 默认文件名用 `strip_note_ext` 而非 `trim_end_matches(".md")`，避免导出成「标题.html.docx」

### 前端

`ui/vendor/quill.js`、`ui/vendor/quill.snow.css`（新增，Quill 2.0.3）

`ui/index.html`
- 标签行加 `.kind-switch`（Markdown / 富文本两个按钮）
- 编辑块加 `#rich-host > #rich-editor`
- 引入 Quill 的 css 与 js

`ui/style.css`
- `.kind-switch`（含 `.locked` 只读态）
- `.rich-host` 及 Quill 工具栏/编辑器的主题覆盖
- `.main.is-rich` / `.editor-block.is-rich`：强制单栏、隐藏 Markdown 工具栏
- `@media print` 补富文本分支（PDF 导出打印编辑器正文）
- `#note-list .nt-kind` 富文本徽标

`ui/app.js`
- `state.kind` / `state.kindLocked` / `state.rich` / `state.richAssets`
- `isRich()`、`currentContent()`、`applyKind(kind, locked)`、`updateExportMenu()`
- Quill 相关：`ensureQuill()`、`richInsertAsset()`、`richImageHandler()`、`richImagePaste()`、`richHtmlForSave()`、`richLoadHtml()`、`richHtmlForExport()`、`buildDocxPayloadFromHtml()`、`renderRichWordCount()`、`renderRichOutline()`
- `doSave` 用 `currentContent()`，并把 `kind` 传给后端；落盘后调 `applyKind(..., true)` 锁定
- `openNote` 按 `note.kind` 分流载入
- `newNote` 按 `LS.get('kind')` 决定默认类型，未落盘时可切换
- 类型切换按钮：锁定后点击给提示；未锁定时若已有正文，先弹确认（切换会清空）
- `setLayout(mode, persist)` 加第二参数，富文本强制单栏时不覆盖用户原布局偏好
- `render()` / `renderOutline()` / `renderWordCount()` 加富文本分支
- 富文本模式下 `Ctrl+F/H` 明确提示不支持（无源码文本可定位）
- `editor` 的 keydown 在富文本模式直接返回，交给 Quill

### 测试

`src-tauri/src/store.rs` 新增 2 个单元测试；`commands.rs` 新增 1 个：
- `test_kind_from_extension_and_not_serialized`
- `test_list_notes_sees_html_and_md`
- `html_content_is_stripped_before_matching`

`tmp-tests/rich-e2e.py`（Playwright，29 项检查）
`tmp-tests/rich-e2e2.py`（Playwright，19 项检查，覆盖图片/导出/搜索/徽标）

harness（`tmp-tests/harness/`）已同步：mock 桥支持 `.html`、`kind` 字段、扩展名感知的 dedup。

## 验证结果

- `node --check ui/app.js` 通过
- `cargo test`：53 项全过（33 lib + 20 folders + 1 recycle，另有 0 项测试集）
- `rich-e2e.py`：29/29
- `rich-e2e2.py`：19/19
- 无 JS 报错（favicon 404 与功能无关，已从断言中排除）

## 尚未完成

- 没重新构建 `app.exe`（Tauri 把前端嵌进二进制，改前端必须 `cargo build --release`）
- 没提交（用户未要求）
- Quill 的撤销栈与 Markdown 模式的 `execCommand` 撤销栈互不相通，这是两个编辑器的固有差异，未做统一

## 2026-11-19 优化：新建格式弹窗 + 排序 + 工具栏扩充

### 1. 新建先选格式（`#new-note-modal`）

类型落盘后不可改，所以选择提前到「建文档之前」：

- 点「＋ 新建笔记」/ `Ctrl+N` / 菜单「新建笔记」/ 文件夹「在此新建文档」，都先弹窗选 Markdown 或富文本。
- 默认选中上次用过的类型（`localStorage.mv_kind`），挂「上次使用」角标；回车＝用默认值创建，`Esc`/取消＝什么都不变（不新建、不丢当前正文、清掉 `pendingNewFolder`）。
- 弹窗顶部写明落点（根目录 / 某个文件夹），解决「点新建后不知道会存到哪」。
- 取消后 `state.current` 保持原样；原先靠标签行那个开关选类型，但那开关在落盘后就隐藏，新用户根本发现不了。
- 焦点管理复用 `trapFocus()`；`anyModalOpen()` 加入该弹窗，弹窗开着时全局快捷键让路。

### 2. 新建笔记排在分组最前面

- `doSave` 首次落盘时调 `prependToOrder(folder, key)`：把新键 unshift 进 `.markvault-order.json` 对应桶，于是「自定义顺序」下立刻在最前。
- Rust `sort_metas()` 三种排序都加 `file_name` 兜底（文件名前缀是创建时间戳），并列项不再每次刷新随机跳动；「按修改时间 / 创建时间」下新笔记本来就该在最前。

### 3. 富文本工具栏从 12 项扩到 20 个按钮 + 4 个下拉

新增（对照 Typora / 语雀 / Notion / 飞书常用项）：文字颜色、背景颜色、对齐方式（左/中/右/两端）、
减少/增加缩进、上标/下标、任务列表（勾选）、插入表格、插入分隔线。

- 表格用 Quill 自带 `modules/table`；分隔线自己注册 `divider` blot（`<hr>`）+ clipboard matcher，粘贴 `<hr>` 不丢。
- 点击勾选框时 `ql-ui` 只有字形左侧一小块可点（`getBoundingClientRect().width === 0`），已实测确认可用。
- 工具栏改 `display:flex; flex-wrap:wrap`：900px 最小窗口下换行而不是裁切，实测 900/1100/1280/1600 四档无裁切、无横向滚动、无死按钮。
- 编辑器内补样式：表格边框、`hr`、勾选态删除线、`ql-align-*`（snow 只在工具栏侧定义过对齐）。
- 富文本保存/重开：表格、分隔线、对齐、颜色、待办全部原样回来（`tmp-tests/_r7_roundtrip.py` 15 项全过）。
- 修 `closeTablePicker()`：先还焦点再隐藏弹窗，否则焦点落到 body。

### 4. 顺手修掉的既有问题

- `openNote()` 切换类型时只清了目标侧编辑器：打开富文本笔记后隐藏的 textarea 里还留着上一篇 Markdown 全文，导出/字数/查找会读到它；反向同理。现在两侧都清并清撤销栈。
- `newNote()` 同样两侧都清；`render('')` 之后补 `renderRichWordCount()`，避免字数按 Markdown 口径显示 0。

### 验证

- `node --check ui/app.js`；`cargo test` 60 项（39 + 20 + 1）全过；`cargo build --release` 成功。
- harness（8791）：`qa-rich.py` / `rich-e2e.py` 34 / `rich-e2e2.py` 19 / `rich-layout.py` 20 / `p2_*.py` 全绿。
- 真机 CDP（9222）：新建弹窗、落点提示、两个格式选项、取消不落盘、富文本 20 按钮无裁切无死按钮、菜单回归、无 JS 报错；真实新建一篇后确认排在根目录第一位并写入顺序表，随后删除并清理顺序表残留键。
- 既有失败与本次无关（改动前后同结果）：`qa-keys.py` 3 项、`qa-order.py` 3 项、`qa-audit.py` 9 项（HTML5 drag 合成事件在该环境不触发）、`qa-markdown.py` 的 `#btn-save` 陈旧选择器。

## 回归注意

Markdown 路径的行为未变。唯一的行为变化：
- 列表扫描现在也会收 `.html` 文件（若有同名 `.html` 散落在笔记库则会出现）
- 搜索对 `.html` 笔记剥标签后匹配
- `save_note` 多一个可选参数（不传时按 `md` 处理，向后兼容）
