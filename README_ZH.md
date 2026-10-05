# Pigger Switch

**Claude Code** 和 **Codex** 的用量统计：用了多少 token、按 API 价格折算值多少钱、花在了哪些项目上、离订阅额度上限还有多远。

[English](README.md) | 中文

Pigger Switch 读取 Claude Code（`~/.claude/projects`）和 Codex（`~/.codex/sessions`）本来就会写在电脑上的会话日志，不需要代理，不需要 API Key，也不改动这两个工具的任何配置。

## 功能

- **概览**：任意时间段的花费、请求数、token 数、缓存命中率，并和上一个同样长的时段对比；Claude / Codex 花费占比、趋势图、年度热力图。
- **项目**：按会话所在的目录统计用量，点一个项目就把整个面板筛到它。
- **会话**：最贵的会话（带 Claude Code 自己起的标题），点进去看这个会话的每一条请求。
- **模型**：按模型统计用量和花费；价格表可以手改，也可以从 [models.dev](https://models.dev) 同步。
- **活跃时段**：星期 × 小时热力图，看你什么时候用得最多。
- **订阅额度**：Claude（Pro / Max）和 Codex 用的 ChatGPT 方案的 5 小时、每周额度，带重置倒计时；方案从登录信息里识别（如 "Max 5x"、"Team"）。
- **提醒**：额度用到设定的比例、或者当天 / 当月花费超过预算时发桌面通知。
- **托盘**：菜单栏 / 系统托盘里直接看今天两个工具各花了多少、本月合计和订阅额度。
- **导出 CSV**：每日汇总、项目、模型、会话或每一条请求。
- **从 CC Switch 导入**：从已有的 CC Switch 数据库（`~/.cc-switch/cc-switch.db`）导入更早的历史，已经统计过的日子会跳过。

花费是**按 API 价格折算**的：这些 token 按各模型的 API 单价值多少钱。用订阅的话，这是订阅给你带来的价值，不是实际扣的钱。

## 隐私

所有数据都留在本机的 `~/.pigger-switch/` 里。只有这些网络请求：

- 订阅额度：用 Claude Code、Codex 已有的登录信息只读地查询 `api.anthropic.com` 和 `chatgpt.com`。
- 从 `models.dev` 同步价格（打开了才会同步）。

## 构建

需要 Node.js 22+、pnpm 10、Rust 1.95，以及所在系统的 [Tauri 2 依赖](https://tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm dev          # 开发模式运行
pnpm build        # 打包安装包到 src-tauri/target/release/bundle
pnpm test:unit    # 前端测试
cd src-tauri && cargo test   # 后端测试
```

## 致谢

Pigger Switch 是 Jason Young 的 [CC Switch](https://github.com/farion1231/cc-switch) 的精简分支：保留了 CC Switch 的用量统计引擎，去掉了其余功能。MIT 许可证。
