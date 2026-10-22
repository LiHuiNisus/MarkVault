# MarkVault 工作约定

## 上下文预算

本项目装了自动守护 `.sdd/hooks/ctx-guard.cjs`（config: `.sdd/hooks/ctx-guard.json`）：

- 每轮开头会收到 `[ctx-guard] 上下文 NN%（已用 / 窗口）`。百分比就是当前真实占用。
- 超过 `warnAt`（默认 55%）起，脚本会自己往 `.sdd/context-handoff.md` 写快照，
  记录本轮指令、改过的文件、跑过的命令、`git status`。**不需要你手动维护这个文件。**
- `PreCompact` 时脚本会输出一段压缩指令，要求摘要保住未完成的需求、改动清单、
  验证结果与失败原文、剩余事项、已排除的方案。
- 压缩后 `SessionStart(source=compact)` 会把快照喂回来。看到快照就直接用，
  不要再全量重读项目文件。

百分比到 70% 时按收尾节奏走，到 82% 时只做落盘与总结，然后明确建议用户 `/compact`。

## 省 token 的硬规则

1. **读文件先定位再读片段**。大文件用 `Grep -n` 找行号，再 `Read offset/limit`。
   不要为了"了解结构"整份读完再动手。
2. **长输出先过滤**。测试、构建、日志类命令一律接 `| tail -n` 或 `| grep -E "error|warning|result"`，
   不把几万行原始输出灌进上下文。
3. **搜索交给子代理**。跨多文件"某功能在哪"这类问题发 `Explore` 子代理，
   只要结论和 `file:line`，不要自己把十几个文件塞进来。
4. **同一文件不重复读**。Edit 之后不需要再 Read 验证；工具失败会报错。
5. **不重复叙述已定结论**。上下文里已经确认过的事实不再复述。

## 落盘节奏

每完成一个「能验证」的小步，就往 `.sdd/progress.md` 追加一节：改了什么、为什么、怎么验证的。
不要攒到最后。这份文件是压缩后恢复的主要依据，比任何口头总结都可靠。

## 验证要求

改 `ui/` 下文件后：

```bash
node --check ui/app.js
cp ui/app.js tmp-tests/harness/app.js   # harness 是 ui/ 的副本，必须同步
```

涉及 Rust 改动时跑 `cargo test --manifest-path src-tauri/Cargo.toml`。
改完前端要重新构建 exe 才会生效（Tauri 把前端嵌入二进制）：
`cd src-tauri && cargo build --release`，再 `cp target/release/app.exe ../app.exe`。

## 提交

只在用户明确要求时提交。提交信息用中文，说明改了什么、为什么改。
