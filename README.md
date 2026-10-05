# Pigger Switch

Usage statistics for **Claude Code** and **Codex**: how many tokens you use, what they would cost at API prices, where they go, and how close you are to your plan limits.

[English](README.md) | [中文](README_ZH.md)

Pigger Switch reads the session logs that Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) already write on your computer. It needs no proxy, API key or change to either tool.

## Features

- **Dashboard**: total cost, requests, tokens and cache hit rate for any time range, compared with the previous period. A Claude vs Codex split, a trend chart and a yearly heatmap.
- **Projects**: usage grouped by the folder each session ran in. Click a project to filter the whole dashboard.
- **Sessions**: the most expensive sessions with Claude Code's own session titles. Click one to see every request in it.
- **Models**: usage and cost per model, with an editable price table that can sync from [models.dev](https://models.dev).
- **Active hours**: a weekday × hour heatmap of when you use the tools most.
- **Plan limits**: 5-hour and weekly windows for your Claude (Pro / Max) plan and your ChatGPT plan used by Codex, with reset countdowns. The plan is detected from your login (for example "Max 5x" or "Team").
- **Alerts**: desktop notifications when a limit window reaches a chosen percentage, or when daily or monthly spend passes a budget.
- **Tray**: today's spend per tool, this month's total and your plan limits, right in the menu bar or system tray.
- **CSV export**: daily totals, projects, models, sessions or every request.
- **Import from CC Switch**: brings in older history from an existing CC Switch database (`~/.cc-switch/cc-switch.db`). Days that are already counted are skipped.

Costs are **API-equivalent**: what the tokens would cost at the per-model API prices. On a subscription this is the value you got out of the plan, not what you were charged.

## Privacy

Everything stays on your computer, in `~/.pigger-switch/`. The app makes only these network requests:

- Plan limits: `api.anthropic.com` and `chatgpt.com`, using the logins Claude Code and Codex already have (read-only).
- Price sync from `models.dev`, only if you turn it on.

## Build

Requirements: Node.js 22+, pnpm 10, Rust 1.95 and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm dev          # run in development
pnpm build        # build installers into src-tauri/target/release/bundle
pnpm test:unit    # frontend tests
cd src-tauri && cargo test   # backend tests
```

## Credits

Pigger Switch is a trimmed-down fork of [CC Switch](https://github.com/farion1231/cc-switch) by Jason Young. It keeps CC Switch's usage-statistics engine and drops everything else. Licensed under MIT.
