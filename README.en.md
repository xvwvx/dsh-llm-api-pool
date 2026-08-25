# dsh-llm-api-pool

> An API pool built for **opencode go**: hot-manage and switch between different API keys based on balance.

Pool multiple opencode go subscriptions (each = one `{baseUrl, apiKey}`), track every key's official usage/balance in real time, and route model requests to the key with the most remaining quota — automatically falling through to the next key when one is exhausted or fails.

## Highlights

- **Multi-key pool**: entries are keyed by `{baseUrl, apiKey}`. Re-adding the same key updates it in place; a different key becomes a new subscription. Manage any number of opencode go subscriptions with no naming convention.
- **Official usage/balance with a pure API key (no org token)**: calls the gateway-native `GET https://opencode.ai/zen/go/v1/usage` per entry — official rolling (5h) / weekly / monthly triple-limit percent plus exact reset times. USD figures are `percent × cap` conversions for reference, not raw amounts returned by opencode.
- **Balance-driven hot switching**: routing prefers official usage pressure (`remotePressure`, `usageRemote` cached with a 5-minute TTL); before a chat, stale official usage is refreshed non-blockingly and the key with the most remaining quota is chosen; failures (429/5xx/timeout) cool that key for 60s and fall through to the next candidate.
- **Settings-page UI**: Settings → "LLM API 池": add/remove/toggle entries, probe models, per-card official limit bars (progress + converted USD + reset time), route preview.

## Install

```bash
dsh plugin --profile web add dsh-llm-api-pool
```

The package declares `dsh.bundle.patch` + `dsh.client`. `dsh plugin add` installs the package, appends it to `dsh.profile.bundles`, and the profile boot merges `cordis.patch.yml` (host half + `/llm-pool/api` JSON routes + `/llm-pool/v1` OpenAI-compatible endpoints + **automatic native DSH model-provider registration**) plus the browser half (settings page).

> Install/mount mechanics follow the official `dsh plugin` bundle flow; the published package's host half is guarded by `test/smoke-static.mjs`, and full Web mount + post-restart rendering should be checked once on first install.

## Usage

1. Open **Settings → LLM API 池**;
2. **+ 添加 API**: pick the OpenCode Go preset (fills `https://opencode.ai/zen/go/v1` and 5h $12 / week $30 / month $60 limits), paste an `OPENCODE_API_KEY` → add and auto-probe models;
3. On a card, **刷新限额 / 查询余额** calls the official `/usage` endpoint and shows `[官方] $x.xx / $cap (p%) · 重置 HH:MM:SS` (p% official, $ converted);
4. Add a second subscription (different key) → second card with its own balance; model requests route to the key with the most remaining quota and auto-switch on failure.

Model-facing pool tools: `llm_pool_list` / `llm_pool_add` / `llm_pool_remove` / `llm_pool_update` / `llm_pool_probe` / `llm_pool_usage` / `llm_pool_limits` / `llm_pool_route` / `llm_pool_chat` / `llm_pool_balance`.

## Use the pool as a native DSH provider (0.1.6, zero config)

On load the plugin **automatically** registers a model provider named **LLM API Pool (余额热切换)** with DSH:

- **It appears in the Model picker automatically**: its models are the union of every probed model across pool entries; selecting any of them routes through the pool (balance-driven hot switching takes over automatically); every model exposes a **reasoning effort picker** (low/medium/high/max) forwarded to the opencode go gateway as `reasoning_effort` ("off" is rejected by the gateway so it is not offered; unset uses the gateway default);
- **The Models settings page shows the provider row as ready**, with no fields to fill (baseURL/apiKey come from the pool, not from model settings);
- An empty pool exposes no models; the provider gains models as soon as the first key is added.

No manual provider setup, no baseURL/apiKey fields.

## Use the pool as an OpenAI-compatible provider (0.1.5)

The pool exposes OpenAI-compatible endpoints on the DSH web server port (default `127.0.0.1:3080`). Point any OpenAI client's baseUrl at it and it transparently enjoys balance-driven hot switching — apiKey is ignored (routing is decided by the pool's own entries):

- `GET  http://127.0.0.1:3080/llm-pool/v1/models` — union of all probed models across entries;
- `POST http://127.0.0.1:3080/llm-pool/v1/chat/completions` — OpenAI chat input → pool routing → OpenAI output; `stream:true` returns an SSE stream.

**DSH itself**: add a custom provider in model settings with baseUrl = `http://127.0.0.1:3080/llm-pool/v1`, any apiKey, and a model id already probed in the pool (e.g. `deepseek-chat`).

**opencode CLI** (official route: custom provider with a baseURL override, see the [opencode providers docs](https://opencode.ai/docs/providers/)):

```jsonc
// opencode.json
{
  "provider": {
    "dsh-pool": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DSH LLM API Pool",
      "options": {
        "baseURL": "http://127.0.0.1:3080/llm-pool/v1",
        "apiKey": "any-value"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek Chat (pooled)" }
      }
    }
  }
}
```

**Any OpenAI SDK**: set `baseURL` to `http://127.0.0.1:3080/llm-pool/v1`, `apiKey` to any value, and `chat.completions.create({ model, messages })` is routed through the pool.

> The port follows the DSH web server (`webStartup.port`, default 3080); if you changed the web port, update the URLs above accordingly.

## Uninstall

```bash
dsh plugin --profile web remove dsh-llm-api-pool
```

The pool file (below) stays on disk; delete it manually if no longer needed.

## Data & security

- Entries persist to `sandboxPolicy.workspaceRoot/.dsh-llm-api-pool.json`: **plaintext API keys** (protected only by local file permissions), official usage cache, and the local ledger. Do not commit it.
- The host half makes read-only usage requests to `opencode.ai` / `console.opencode.ai`, and — only when you call `llm_pool_chat` — model requests to the entry baseUrl.

## Development & tests

```bash
npm test              # static smoke: 10 tools + /llm-pool/api + /llm-pool/v1 OpenAI endpoints + native provider registration/stream (20 assertions)
node ../llm-pool-test/e2e.test.mjs           # full E2E: 39 checks (host / provider registration / multi-sub routing / client render / live endpoint / real key)
LLM_POOL_TEST_KEY=sk-... node ../llm-pool-test/e2e.test.mjs  # real-key full lifecycle (CRUD + real balance + real chat)
```

The E2E suite lives outside the repo (`../llm-pool-test/`) and guards the dynamic logic that the published host half is byte-identical to (the package is the staticized conversion, separately smoke-tested).

## License

MIT