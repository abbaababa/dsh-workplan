# dsh-workplan 对外宣传短文案（双语）｜Bilingual promo copy

> 用途：GitHub 仓库描述、Release 说明、社区帖子均可直接复制。
> Usage: copy-paste for the GitHub repo description, release notes, or community posts.
>
> 措辞约束：只引用 2026-11-03 独立复检报告的「通过」项；保留 ATE_IND.1 / AVA_VAN.2+ 残留披露；不宣称 CC 认证。
> Wording constraint: only "pass" items from the independent recheck of 2026-11-03; the ATE_IND.1 / AVA_VAN.2+ residual disclosure is kept; no claim of CC certification.

---

## 一句话版 / One-liner

**中文**：给 AI 助手装上「先出计划、再派活、随时看进度」的能力——安全证据对齐 ISO/IEC 15408:2026 结构，一条命令安装，5 条命令自己验证。

**English**: Give your AI assistant "plan first, dispatch real subagents, watch progress live" — security evidence aligned with the ISO/IEC 15408:2026 structure, one-command install, five commands to verify it yourself.

## 短段落版 / Short paragraph

**中文**：dsh-workplan 是 DeepSeek Harness 的一个插件：你给一个任务，它先在对话里写出一份完整计划（分几步、谁来做、什么算做完），确认后真的派最多 5 个子 Agent 并行去做，你在侧栏随时看进度。它公开了整套安全自评证据（安全目标、设计、配置管理、测试、脆弱性分析），结构对齐最新的 ISO/IEC 15408:2026；470 项自动化测试一条命令复跑。**如实说明：这不是 CC 认证**——按规则，认证里的实验室测试（ATE_IND.1）与独立渗透评测（AVA_VAN.2+）只能由认可实验室完成，这两项作为固有残留永久披露。安装就一条命令，不懂技术也能照着 README 操作。

**English**: dsh-workplan is a plugin for DeepSeek Harness. Give it a task and it first writes a full plan into the conversation (steps, owners, acceptance criteria); once confirmed it dispatches up to 5 real subagents in parallel while you watch progress in the sidebar. It publishes a complete security self-assessment pack (security target, design, configuration management, tests, vulnerability analysis) aligned with the latest ISO/IEC 15408:2026 structure, and 470 automated tests re-run with one command. **Honest disclosure: this is not CC certification** — by the rules, the lab-witnessed testing (ATE_IND.1) and independent penetration evaluation (AVA_VAN.2+) can only be done by an accredited lab, and these two residuals stay disclosed permanently. Install is one command, and the README is written so a non-technical reader can follow it.

## 卖点清单 / Bullet selling points

- **安全有据可查**：全套自评证据公开在仓库里，任何人都能自己核对，不用信任何人的口头承诺。/ **Verifiable security**: the full self-assessment pack is public in the repo — check it yourself instead of trusting anyone's word.
- **版本口径诚实**：对齐 2026 结构、认证体系现行受理 CC:2022；不说「已认证」。/ **Honest version framing**: 2026 structure, schemes currently accept CC:2022; we never claim certification.
- **安装一条命令**：`dsh plugin --profile web add dsh-workplan@1.12.0`，重启即用。/ **One-command install** with a restart, nothing else.
- **零第三方运行时依赖**：不写磁盘、不外发数据、面板要登录。/ **Zero third-party runtime dependencies**: no disk writes, no outbound traffic, the panel requires login.
- **小白友好**：README 用大白话解释每一步，照抄命令即可。/ **Beginner-friendly**: the README explains every step in plain language; copy the commands as-is.

## 安装三步 / Install in 3 steps

```bash
# 1. 安装 / install
dsh plugin --profile web add dsh-workplan@1.12.0

# 2. 重启 DSH Web（或刷新页面）/ restart DSH Web (or reload the page)

# 3. 正常发一个任务，等【任务分解】出现 / just send a task and wait for the plan block
```

自己验证安全证据 / verify the evidence yourself:

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
npm ci && npm run verify        # 期望 / expect: tests 470 / pass 470 / fail 0
```
