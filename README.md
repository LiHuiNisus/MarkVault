# MarkVault

本地优先的 Markdown / 富文本笔记桌面应用。基于 Tauri 2 + Rust 后端 + 原生 JavaScript 前端，无打包器、无 `node_modules`；笔记以纯文件形式存在你自己的文件夹里，不上传、不加密、不锁定。

## 特性

**笔记与编辑器**

- 双文档类型：Markdown（`.md`）与富文本（`.html`）。类型在新建时选定，落盘后不可更改——避免格式来回转换导致的内容损失。
- Markdown 编辑：实时预览、源码高亮、标题目录、编辑与预览双栏滚动同步。
- 富文本编辑：基于 Quill 2.0.3，20 个格式按钮 + 4 个下拉（文字颜色、背景色、对齐、缩进、上标/下标、任务列表、表格、分隔线等）。
- 自动保存（防抖 2 秒）+ 手动保存，状态实时显示在顶栏。
- 图片粘贴 / 拖入：写入笔记同级的 `.assets/` 目录，正文存相对路径，可随笔记一起迁移。

**文件管理**

- 笔记库即普通文件夹，可随时更换。
- 文件夹分类、拖动排序（文件夹间 / 组内 / 根目录）、批量多选移动与删除。
- 标签：多标签、按标签筛选、改名、合并、删除。
- 排序：按修改时间 / 创建时间 / 标题 / 自定义顺序。
- 删除走系统回收站（网络盘等回收站不可用时退回永久删除，界面会如实提示）。
- 搜索：一次搜索覆盖标题、正文和标签；带查找替换栏，↑ / ↓ 跳转命中，支持替换当前与全部替换。

**导出**

| 格式 | 说明 |
|------|------|
| HTML | 保留样式，可再编辑 |
| Markdown | 纯文本源文件 |
| Word (.docx) | 标准 OOXML，可直接编辑。Rust 侧生成，不依赖 Office |
| PDF | 调 WebView2 `PrintToPdfStream` 原生输出，A4 纵向、约 1cm 边距 |
| PNG | 截当前预览区；超长内容会截断 |

> 富文本笔记只提供 HTML / DOCX / PDF 导出：HTML → Markdown 有损，PNG 截的是预览区而富文本没有预览区，因此菜单里自动隐藏这两项。

**界面**

- 深色 / 浅色主题切换。
- 三种布局：编辑 + 预览双栏、纯编辑、纯预览；侧栏可收起，窗口最小宽度 900px。
- 完整键盘操作：列表方向键导航、空格预览、F2 重命名、Delete 删除、Ctrl+A 全选。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+N` | 新建笔记（先选格式） |
| `Ctrl+S` | 立即保存 |
| `Ctrl+P` | 聚焦搜索框 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 查找替换 |
| `Ctrl+Tab` | 切换到最近打开的笔记（`Shift` 反向） |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | 加粗 / 斜体 / 插入链接（Markdown 模式） |
| `Ctrl+Shift+L` | 切换布局 |
| `Ctrl+Shift+T` | 切换深色 / 浅色主题 |
| `Ctrl+Alt+E` | 焦点跳到正文 |
| `F6` | 收起 / 展开笔记列表 |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri 2.7 |
| 后端 | Rust（edition 2024，rustc 1.90+） |
| 前端 | 原生 JavaScript，无构建步骤 |
| Markdown 渲染 | marked + DOMPurify |
| 富文本编辑器 | Quill 2.0.3（vendor 单文件引入） |
| 截图导出 | dom-to-image-more |
| PDF | WebView2 `ICoreWebView2_16::PrintToPdfStream` |
| 打包 | NSIS 安装包 |

前端没有 `package.json`、没有打包器。所有第三方库以单文件形式放在 `ui/vendor/`，改完 JS 直接生效。

## 笔记格式

每篇笔记是一个独立文件，开头带 YAML front matter：

```markdown
---
{"file_name":"20261009-131744-笔记.md","title":"笔记标题","tags":["工作"],"created":"2026-10-09T13:17:44","modified":"2026-10-09T14:20:01"}
---
正文从这里开始……
```

- 类型由扩展名判定（`.md` / `.markdown` / `.html` / `.htm`），不写进 front matter——文件被重命名或移动后元数据不会与事实矛盾。
- 图片存在笔记库同级的 `.assets/` 目录，正文用相对路径引用。

## 从源码运行

前置条件：

- [Rust 工具链](https://rustup.rs/) 1.90+
- [Tauri 2 系统依赖](https://tauri.app/start/prerequisites/)（Windows 需要 WebView2，Win10 1803+ / Win11 自带）
- Node.js 不是必需的

```bash
git clone https://github.com/LiHuiNisus/MarkVault.git
cd MarkVault
cd src-tauri && cargo build --release
```

前端已嵌在二进制中，构建完成后运行 `src-tauri/target/release/app.exe` 即可。

开发时热启动：

```bash
cd src-tauri && cargo tauri dev
```

## 构建安装包

```bash
cd src-tauri
cargo tauri build
```

产物在 `src-tauri/target/release/bundle/nsis/`。静默安装：`MarkVault_x.y.z_x64-setup.exe /S`。

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml
node --check ui/app.js
```

Rust 侧 60 项测试覆盖文件名去重、文件夹迁移、路径校验、排序、回收站、富文本类型判定等。前端语法检查用 `node --check`，无需测试框架。

## 项目结构

```
MarkVault/
├── src-tauri/          Rust 后端
│   ├── src/
│   │   ├── commands.rs    Tauri 命令（笔记增删改查、搜索、导入导出、标签、文件夹）
│   │   ├── store.rs       笔记落盘、front matter 序列化、类型判定、排序
│   │   ├── config.rs      笔记库路径配置、旧版本迁移
│   │   ├── export.rs      DOCX 生成、PDF / PNG 导出
│   │   ├── clipboard.rs   Windows 剪贴板文件写入（CF_HDROP）
│   │   └── lib.rs         应用入口
│   └── tests/          集成测试
├── ui/                 前端（无构建步骤）
│   ├── index.html
│   ├── app.js          全部界面逻辑
│   ├── style.css
│   └── vendor/         第三方库单文件
├── docs/               设计记录
├── .sdd/               开发流程记录（进度、走查报告、上下文守护 hook）
├── CLAUDE.md           工程约定
└── progress.md         开发进度日志
```

## 设计取舍

- **类型不可变**：一篇文档的类型在创建时确定。来回转换 Markdown ↔ 富文本必然有损，与其给一个有损的双向按钮，不如在开头让用户选清楚。
- **文件即数据**：不引入数据库。笔记就是文件，用任何编辑器都能打开，出问题时用文件管理器就能救回来。
- **无构建步骤**：前端不依赖 npm 生态。牺牲了模块化和 tree-shaking，换来「改完刷新就生效」和「十年后还能构建」。
- **Rust 侧包干重活**：文件读写、格式转换、DOCX 打包、PDF 生成全在后端完成。前端只做界面和编辑。

更详细的设计记录见 [`docs/rich-text-notes.md`](docs/rich-text-notes.md)。

## 许可

未指定许可证。仓库为私有项目，保留所有权利。
