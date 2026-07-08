<div align="right">
  <h5><a href="./README.md">🌐 &nbsp;English</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

<p align="center"><em>用 crosscheck 构建 crosscheck。</em></p>

# crosscheck

**为使用 Claude Code 和 Codex 的开发者打造的自动化 AI Code Review——按你的方式配置，零额外基础设施。**

当你的 AI Agent 提交 PR 时，另一个 AI 负责审查。发现问题后，原作者 Agent 自动修复并提交跟进 PR。整个流程运行在你已有的订阅上，一条命令即可启动。

---

## 核心亮点

- **可定制的审查工作流** — 灵活配置完整流水线：仅审查、审查 + 自动修复，或审查 + 修复 + 复查。每个步骤均可定制审查指令，无需手动编辑 Prompt。
- **跨供应商模式与单供应商模式** — 跨供应商模式将每个 PR 路由给对手 AI 进行独立审查；单供应商模式则使用你拥有的任意一个 AI。一行配置即可切换。
- **订阅驱动，无需按 token 计费** — 通过 `claude` 和 `codex` 命令行工具运行，使用你已有的 Claude Pro/Max 和 ChatGPT Plus/Pro 订阅。无需 API Key，无额外审查费用。
- **`watch` 持续监听** — `crosscheck watch` 自动建立隧道并注册 webhook，PR 到达即审查。加 `--only-review` 则只发审查、不自动修复。

---

## 快速开始

```bash
# 1. 安装 crosscheck 及 Agent CLI
npm install -g @humanbased/crosscheck
npm install -g @anthropic-ai/claude-code && claude        # 需要 Claude Pro/Max 订阅
npm install -g @openai/codex && codex login --device-auth # 需要 ChatGPT Plus/Pro 订阅
brew install gh && gh auth login                          # GitHub CLI

# 2. 引导式配置——选择仓库、供应商模式、工作流流水线
crosscheck onboard

# 3. 启动监听
crosscheck watch                # 持续审查到达的 PR
crosscheck watch --only-review  # 只发审查，不自动修复
```

`crosscheck onboard` 将引导你完成仓库选择、供应商模式、流水线步骤和隧道选择。完成后，运行 `watch` 即可。

---

## 运行效果

```
$ crosscheck watch

  "Move fast and review things."

  profile   personal · cross-vendor · balanced
  users     your-github-login (5 repos)
  auto-fix  on_issues · same-as-author · pull_request
  config    ./crosscheck.config.yml

  ✓ 隧道已就绪: https://abc123.lhr.life
  ✓ 已为 your-org/your-repo 注册 Webhook
  等待 PR 事件 — 按 Ctrl+C 停止。

PR #47 opened: add retry logic for flaky network calls
  origin=claude  reviewer=codex
  codex reviewing... (12s)
  NEEDS WORK
  auto-fix  claude fixing...
  fix PR #48 opened → github.com/your-org/your-repo/pull/48

PR #49 opened: implement caching layer
  origin=codex  reviewer=claude
  claude reviewing... (18s)
  APPROVE
```

---

## 命令列表

```bash
crosscheck init                     # 检查环境，生成初始配置文件
crosscheck onboard                  # 引导式配置——选择仓库、模式和流水线
crosscheck review <pr-urls...>      # 审查一个或多个 PR（逗号列表、区间、跨仓库）
crosscheck run <pr-urls...>         # 运行完整流水线：review → (fix → recheck) × max_rounds
crosscheck recheck|fix|resolve <pr-urls...>   # 对一个或多个 PR 强制执行某个工作流步骤
crosscheck watch                    # 持续监听——隧道 + 自动 Webhook + 本地监听
crosscheck watch --only-review      # 持续监听，只发审查、不自动修复
crosscheck status                   # 查看认证状态、配置摘要、CLI 版本
```

**多 PR 语法**：`run`、`review`、`recheck`、`fix`、`resolve` 的 PR 参数支持展开为多个 PR 的 **spec**——由逗号分隔的完整 URL、纯数字、`N-M` 区间组成。首个 token 必须是完整 URL（纯数字会继承最近一个仓库），最多展开 100 个 PR，多个 PR 默认并发执行（用 `--concurrent <n>` / `--sequential` / `--stagger <ms>` 控制）。

```bash
.../pull/245,255      # 同一仓库的两个 PR
.../pull/245-256      # 区间（含端点）
.../repo/pull/245,https://github.com/o/other/pull/3   # 跨仓库
```

**持续改进** *（实验性）*

```bash
crosscheck diagnose                 # 从审查日志中提取失败模式
crosscheck optimize [--apply]       # 根据 diagnose 输出重写审查指令
crosscheck impact [--money]         # 节省时间、发现问题、代码质量趋势报告
crosscheck issue                    # 从近期错误日志起草并提交 Bug 报告
```

---

## 配置说明

配置文件位于 `~/.crosscheck/config.yml`，一个文件覆盖所有仓库。运行 `crosscheck init` 生成，或通过 `crosscheck onboard` 自动写入。项目根目录下的 `crosscheck.config.yml` 或 `.crosscheck.yml` 仅在 home 配置缺失时作为回退使用。

```yaml
orgs:
  - your-org

routing:
  allowed_authors:
    - your-github-login

quality:
  tier: balanced          # fast（快速）| balanced（均衡）| thorough（深度）

post_review:
  auto_fix:
    enabled: true
    trigger: on_issues    # on_issues | always | never
    fixer: same-as-author
    delivery:
      mode: pull_request
```

完整配置参考：[get-started.zh.md](./get-started.zh.md)

---

## 部署方式

**`crosscheck watch`** — 通过 `localhost.run` 建立 SSH 隧道，无需端口转发，无需云账号，自动注册 Webhook 并在退出时清理。隧道断开时健康检查会自动重连。可运行在笔记本，也可运行在常驻机器上持续监听。

**`crosscheck watch --only-review`** — 仅审查模式：只发审查评论，绝不执行 fix / recheck / conflict-resolve，也不向 PR 推送任何提交。适合想要审查意见、但自己动手修复的场景。

---

## 系统要求

| | 最低版本 |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | 最新版 — `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | 最新版 — `npm install -g @openai/codex` |
| GitHub CLI | 2.65+ — `brew install gh` |

运行 `gh auth login` 后，`GITHUB_TOKEN` 会自动获取，无需手动导出。

---

## 文档

| | |
|---|---|
| **[get-started.zh.md](./get-started.zh.md)** | 完整安装指南——前置条件、所有命令与参数、完整配置参考、常见问题 |
| **[crosscheck.config.example.yml](./crosscheck.config.example.yml)** | 带注释的配置文件示例（每个选项均有说明） |
| **[CHANGELOG.md](./CHANGELOG.md)** | 版本发布记录 |

---

## 参与贡献

欢迎提交 Issue 和 PR：[github.com/humanbased-ai/crosscheck](https://github.com/humanbased-ai/crosscheck)

---

## 许可证

[MIT](./LICENSE) — Copyright (c) 2025–2026 Humanbased PTE LTD.
