# dsh-workplan v1.8.2 — 首页说人话版 / a clearer front page

## 中文

这一版只改文档，不改代码。

**首页第一句现在直接讲两个卖点：**

1. 安全证据按 **ISO/IEC 15408:2026（CC）** 公开，5 条命令自己验 —— 明说没有证书，也绝不宣称"通过认证"；
2. 安装只要**一条命令**，**零第三方运行时依赖**。

顺手把首屏的铺陈删了：原来要滚过大段标准科普才看到卖点，现在前 5 行讲完；`1.5.0`/`1.4.3` 的历史说明折叠收起，内容没删。

安装：

```bash
dsh plugin --profile web add dsh-workplan@1.8.2
```

## English

Documentation only — no code changes.

**The first line of the README now states both selling points:**

1. An **ISO/IEC 15408:2026 (CC)** evidence pack you can verify with 5 commands — no certificate is claimed, and we never say "certified";
2. A **one-command install** with **zero runtime dependencies**.

The front page was also de-bloated: the selling points used to sit below a long standards explainer; now they appear in the first 5 lines, and the 1.5.0/1.4.3 history sections are collapsed (nothing deleted).

Install:

```bash
dsh plugin --profile web add dsh-workplan@1.8.2
```
