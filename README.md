# dsh-web-search-tavily-pool

Tavily search provider for the [DeepSeek Harness](https://npmjs.com/package/@deepseek-ai/dsh) (DSH) web seam, with a **managed multi-key pool**: add, remove, disable, and test each key individually from the Settings UI — changes apply hot, no restart.

## Key pool features

- **Per-key management UI** — Settings → *Tavily Keys*: every key row has 测试 (probe with one real search), 停用/启用 (toggle rotation without deleting — ideal while waiting for a monthly quota reset), and 删除. Add keys one at a time below the list; Enter submits.
- **Rotation** — round-robin across active keys; on failure the key cools down and the next one takes over: HTTP 432/433 (plan quota) → 30 min, 429 → 1 min, other retryable codes → 5 min. Cooldowns can be cleared with one click (重置冷却).
- **Disabled keys stay in the pool** but never rotate until re-enabled; a quota-dead key can rest for a month without deleting it.
- **Hot persistence** — the pool lives in `~/.dsh/.dsh-web-search-tavily.json` (`{ keys: [{ key, disabled }] }`) and mirrors to the `TAVILY_API_KEYS` line of `~/.dsh/.credentials.yaml` (owner-only mode preserved). Every mutation re-warms all live provider instances immediately.
- First run adopts whatever `TAVILY_API_KEYS` / `TAVILY_API_KEY` already holds; the JSON state file becomes authoritative once it exists. Delete it to fall back to credentials-only.

## Install (web profile)

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-web-search-tavily-pool
```

Then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: web-search-tavily
      name: 'dsh-web-search-tavily-pool'

- id: web
  config:
    searchProvider: tavily   # make it the web_search primary
```

Restart `dsh web` and open Settings → **Tavily Keys**.

Manual install without pnpm: copy `lib/` + `package.json` to `~/.dsh/profiles/node_modules/dsh-web-search-tavily-pool/` and add the same rows.

## Composition config (optional)

```yaml
- insert:
    - id: web-search-tavily
      name: 'dsh-web-search-tavily-pool'
      config:
        baseURL: https://api.tavily.com/search   # default
        timeoutMs: 20000                          # default
        maxResults: 8                             # default
        searchDepth: basic                        # basic | advanced
```

## Pairs well with

- [`dsh-web-search-strategy`](https://npmjs.com/package/dsh-web-search-strategy) — chain/parallel orchestration of tavily + bing backends with its own Settings panel.

## License

MIT
