<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-web-search-tavily-pool" alt="npm version" />
  <img src="https://img.shields.io/npm/dw/dsh-web-search-tavily-pool" alt="npm downloads" />
  <img src="https://img.shields.io/npm/l/dsh-web-search-tavily-pool" alt="license" />
</p>

<h1 align="center">dsh-web-search-tavily-pool</h1>

<p align="center">
  <strong>Tavily 搜索 · 多 Key 池管理 · 设置面板可视化增删启停</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-web-search-tavily-pool">npm</a>
  · <a href="https://github.com/jooey/dsh-web-search-tavily-pool">GitHub</a>
  · <a href="#安装--install">Install</a>
</p>

---

为 DSH（DeepSeek Harness）的 `ctx.web` 注册一个 `tavily` 搜索 provider：**多 Key 轮换 + Key 池管理面板**。每把 Key 独立测试、停用、删除，一次加一把——全部在设置页完成，保存即热生效，无需重启。

## 为什么需要 Key 池 / Why a pool

Tavily 免费额度按 Key 计。多把 Key 轮换 = 免费额度叠加；某把打满（HTTP 432/433 套餐配额）自动冷却换下一把，冷却期满自动回归——配额月月重置的 Key 留在池里等它复活就行，不用删。

## 功能 / Features

- **Key 池管理面板** — 设置 → *Tavily Keys*：每行一把 Key（打码显示），行内 `测试`（真实搜索探活）/ `停用·启用` / `删除`，底部输入框一次加一把（回车提交）
- **智能轮换** — 活跃 Key 间 round-robin；失败自动冷却：`432/433`（套餐配额）→ 30 分钟，`429` → 1 分钟，其他可重试错误 → 5 分钟；`重置冷却` 一键全部唤醒
- **停用 ≠ 删除** — 停用的 Key 留在池中不参与轮换，等月度配额重置后一键启用
- **热生效** — 任何变更立即重写内存池并持久化，不用重启 dsh web
- **凭据安全** — Key 只在主机端解析与打码，浏览器端永远只看到 `tvly-xxxx…xxxx`

## 先决条件 / Prerequisites

- 已安装 **DSH**（Node.js >= 20）：`npm install -g @deepseek-ai/dsh`
- 至少一把 [Tavily API Key](https://app.tavily.com/)（免费注册即送额度）

## 安装 / Install

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-web-search-tavily-pool
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: web-search-tavily
      name: 'dsh-web-search-tavily-pool'

- id: web
  config:
    searchProvider: tavily    # web_search 主力切到 tavily
```

重启 `dsh web`，打开设置 → **Tavily Keys** 开始管理。

无 pnpm 时手动安装：把 `lib/` + `package.json` 拷到 `~/.dsh/profiles/node_modules/dsh-web-search-tavily-pool/`，加同样的行。

## Key 从哪来 / Key sources

首次启动自动继承 `~/.dsh/.credentials.yaml` 里的 `TAVILY_API_KEYS`（逗号/空格分隔多把）或单把 `TAVILY_API_KEY`。之后池状态以 `~/.dsh/.dsh-web-search-tavily.json` 为准（含停用标记），并镜像回 credentials 的 `TAVILY_API_KEYS` 行（保持 600 权限）。删掉 JSON 文件即回退纯 credentials 模式。

## 组合行配置（可选）/ Config

```yaml
- insert:
    - id: web-search-tavily
      name: 'dsh-web-search-tavily-pool'
      config:
        baseURL: https://api.tavily.com/search   # 默认
        timeoutMs: 20000                          # 默认
        maxResults: 8                             # 默认
        searchDepth: basic                        # basic | advanced
```

## 搭配使用 / Pairs well with

| 插件 | 说明 |
|---|---|
| [`dsh-web-search-strategy`](https://npmjs.com/package/dsh-web-search-strategy) | fallback / 并行编排 tavily + bing，带策略面板 |
| [`dsh-web-search-bing`](https://npmjs.com/package/dsh-web-search-bing) | 免 Key 的 bing-cn / bing-intl 兜底源 |

## License

MIT
