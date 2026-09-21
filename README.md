# dsh-llm-api-pool

> 为 **opencode go** 设计的 API 池:根据余额热管理切换不同 API key。

把多个 opencode go 订阅(每个 = 一个 `{baseUrl, apiKey}`)收进一个池,实时掌握每个 key 的官方用量/余额,并按"余量最大者优先"自动路由模型请求;一个 key 用满或失败时,自动热切换到下一个。

## 核心能力

- **多 API key 池**:条目主键 = `{baseUrl, apiKey}`。同一个 key 重复添加 = 原地更新配置;不同 key = 新订阅。同时管理任意多个 opencode go 订阅,无需命名约定。
- **官方余额/用量查询(纯 API Key,无需 org token)**:对每个 opencode 条目调用网关原生 `GET https://opencode.ai/zen/go/v1/usage`,返回**官方** rolling(5h)/weekly(周)/monthly(月)三重限额的用量百分比与精确重置时刻。美元数值 = `百分比 × 限额` 的换算供参考,不是 opcode 官方返回的原始金额。
- **请求顺序可选**:卡片顶部「请求顺序」二选一 —— **按用量最少优先**(默认,按累计 token + 限额压力排序,冷却或已用满的自动沉底)或**按卡片顺序**(从上到下依次尝试,同样只有冷却/已用满的沉底);每张卡片带 **↑ / ↓** 可调整上下顺序,该顺序即时持久化,即「按卡片顺序」模式的优先级。策略与顺序都写在池文件里(`routing` 字段 + 条目数组顺序),重启后保持。
- **余额驱动热切换**:路由决策优先使用官方用量压力(`remotePressure`,`usageRemote` 缓存 5 分钟 TTL);多订阅时模型请求前会先刷新过期(>5 分钟)的官方用量(有界等待,受请求超时约束),选出**余量最大**的订阅;失败(429/5xx/超时)冷却该 key 60 秒并自动尝试下一个。
- **设置页 UI**:设置 →「LLM API 池」:添加/删除/启停/排序条目、切换请求顺序、探查模型、每张卡片独立展示官方限额(进度条 + 换算美元 + 重置时刻)、路由预览。

## 安装

```bash
dsh plugin --profile web add dsh-llm-api-pool
```

包声明了 `dsh.bundle.patch` + `dsh.client`,`dsh plugin add` 会:
1. 把包加入 profile 依赖;
2. 发现 `dsh.bundle.patch` → 自动把 `dsh-llm-api-pool` 追加进 `dsh.profile.bundles`;
3. 启动时合成 `cordis.patch.yml`:host 半(池管理 + `/llm-pool/api` JSON 路由 + `/llm-pool/v1` OpenAI 兼容端点 + **DSH 原生模型 provider 自动注册**)挂进 host 组合;`dsh.client` 声明让 client 半(设置页)被 web shell 装载。

> 安装/挂载的机制引用自 dsh 官方 CLI 协调流程;发布包自身通过 `test/smoke-static.mjs` 守护 host 半的注册与路由回路,完整 Web 挂载与重启后的设置页渲染请在首次安装后核对。

## 使用

1. 打开 **设置 → LLM API 池**;
2. **+ 添加 API**:预设选 OpenCode Go(自动填入 `https://opencode.ai/zen/go/v1` 与 5h $12 / 周 $30 / 月 $60 限额),粘贴 `OPENCODE_API_KEY` → 添加并自动探查模型列表;
3. 卡片上 **「刷新限额 / 查询余额」** 调用官方 `/usage` 端点,显示 `[官方] $x.xx / $cap (p%) · 重置 MM-DD HH:MM:SS`(p% 为官方百分比,$ 为换算值;重置时刻为**本地时区**的带日期时间,跨年时额外带年份);官方结果会持久化缓存,重开设置页仍按官方数值显示,官方端点不可达时才回退 `[估算]`(本地账本 token × 模型价格);
4. 添加第二个订阅(不同 key)→ 第二张卡片,各自独立余额;模型请求自动优先路由到余量最大的订阅,失败自动切换。
5. 需要固定优先级时,把顶部 **请求顺序** 切到「按卡片顺序」,再用每张卡片的 **↑ / ↓** 排出你要的顺序(自上而下 = 请求优先级);切回「按用量最少优先」即恢复自动均衡。卡片上的 `#n` 就是当前顺序。

模型也可直接调用池工具:`llm_pool_list` / `llm_pool_add` / `llm_pool_remove` / `llm_pool_update` / `llm_pool_probe` / `llm_pool_usage` / `llm_pool_limits` / `llm_pool_config` / `llm_pool_route` / `llm_pool_chat` / `llm_pool_balance`。其中 `llm_pool_config` 用于读/改请求顺序策略(`routing`:`score` | `listed`)以及直接给出卡片顺序(`order`:id 数组)。

## 作为 DSH 原生 provider 使用(0.1.6,零配置)

装载后插件**自动**向 DSH 注册一个名为 **LLM API Pool (余额热切换)** 的模型 provider:

- **模型选择器自动出现**:模型列表 = 池内所有条目探查到的模型并集,选中任何一个即走池路由(余额热切换自动接管);每个模型带 **reasoning effort 选择器**(low/medium/high/max),选择经池透传给 opencode go 网关(`reasoning_effort`;off 被网关拒绝故不提供,未选时用网关默认);
- **模型设置页自动显示该 provider 行**:显示为已就绪,没有任何需要填写的字段(baseUrl/apiKey 都来自池,不在模型设置里);
- 池为空时 provider 的模型列表为空,添加第一个 key 后自动出现。

无需手动添加 provider、无需填 baseUrl/apiKey。

## 作为 OpenAI 兼容 provider 接入(0.1.5)

池本身暴露了 OpenAI 兼容端点,复用 DSH Web 服务端口(默认 `127.0.0.1:3080`),任何 OpenAI 客户端把 baseUrl 指过来即可透明享受余额热切换——apiKey 任意(路由由池内的条目决定):

- `GET  http://127.0.0.1:3080/llm-pool/v1/models` — 池内所有条目探查到的模型并集;
- `POST http://127.0.0.1:3080/llm-pool/v1/chat/completions` — OpenAI chat 输入 → 池路由 → OpenAI 输出;`stream:true` 时返回 SSE 流。

**DSH 自身**:模型设置中新增自定义 provider,baseUrl = `http://127.0.0.1:3080/llm-pool/v1`,apiKey 任意,模型名填池内已探查的模型(如 `deepseek-chat`)。

**opencode CLI**(官方做法:自定义 provider 覆写 baseURL,参考 [opencode providers 文档](https://opencode.ai/docs/providers/)):

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

**任意 OpenAI SDK**:`baseURL` 指向 `http://127.0.0.1:3080/llm-pool/v1`,`apiKey` 填任意值,`chat.completions.create({ model, messages })` 即走池路由。

> 端口跟随 DSH Web 服务(`webStartup.port`,默认 3080);若改动过 Web 端口,请同步替换上文 URL。

## 卸载

```bash
dsh plugin --profile web remove dsh-llm-api-pool
```

移除后池文件(见下)保留在磁盘,如不再需要可手动删除。

## 数据与安全

- 条目持久化在 `sandboxPolicy.workspaceRoot/.dsh-llm-api-pool.json`:含 **API key 明文**(本机文件权限保护)、官方用量缓存、本地账本。请勿将该文件提交到版本库。
- 插件在 host 进程内会向 `opencode.ai` / `console.opencode.ai` 发起只读的用量查询请求,并在你主动调用 `llm_pool_chat` 时向条目 baseUrl 发送模型请求。
- HTTP 传输默认走 host 进程的全局 `fetch`(Node ≥18),**不经过 shell**;仅在宿主没有全局 `fetch`,或显式设置 `LLM_POOL_TRANSPORT=curl` 时才回退 `curl`。Windows 上回退路径使用 `curl.exe` 并遵循 PowerShell 变量语法(`$env:NAME`)——PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名,POSIX 风格的 `curl -sS -m 120 …` 会直接以"参数名 'm' 歧义"失败;而 dsh 沙箱内的 `curl.exe` 还可能因 schannel 无法获取凭证(`SEC_E_NO_CREDENTIALS`)而 TLS 失败,因此 `fetch` 是 Windows 上唯一可靠的传输方式。

## 开发与测试

```bash
npm test          # 静态包冒烟:mock ctx 下跑通 10 工具注册 + /llm-pool/api + /llm-pool/v1 OpenAI 端点 + DSH 原生 provider 注册/stream(20 项断言)
node ../llm-pool-test/e2e.test.mjs             # 完整 E2E:39 项(T1 host / T1c provider 注册 / T1b 多订阅路由 / T2 client 渲染 / T3 live 端点 / T4 真实 key)
LLM_POOL_TEST_KEY=sk-... node ../llm-pool-test/e2e.test.mjs   # 真实 key 全生命周期(增查改删 + 真实余额 + 真实 chat)
```

E2E 套件位于仓库外(`../llm-pool-test/`),守护的动态逻辑与发布包 host 半逐字一致(发布包已静态化转换并单独冒烟)。

## License

MIT