# dsh-llm-api-pool

DeepSeek Harness (DSH) LLM API 池管理插件 —— 多 LLM API 订阅的统一管理、官方余额/用量查询与用量感知热切换。

- **多订阅**:条目主键 = `{baseUrl, apiKey}`。同一个 key 重复添加 = 原地更新配置;不同 key = 新订阅。可以同时管理任意多个 opencode go 订阅。
- **官方余额/用量(纯 API Key)**:对 opencode go 条目调用网关原生 `GET {baseUrl}/usage`(opencode.ai/zen/go/v1),返回**官方** rolling(5h)/weekly(周)/monthly(月)百分比 + 精确重置时刻。无需 org token。
- **用法感知热切换**:`usageScore` 优先用官方用量压力(`remotePressure`,`usageRemote` 缓存 5 分钟 TTL);chat 多候选时非阻塞刷新过期官方用量,选出**余量最大**的订阅;失败(429/5xx/超时)冷却该条目 60 秒并自动尝试下一个。
- **设置页 UI**:设置 →「LLM API 池」:添加/删除/启停条目、探查模型、每张卡片独立展示官方限额(进度条 + 美元 + 重置时刻)、路由预览。

## 安装

```bash
dsh plugin --profile web add dsh-llm-api-pool
```

包声明了 `dsh.bundle.patch` + `dsh.client`,`dsh plugin add` 会:
1. 把包加入 profile 依赖;
2. 发现 `dsh.bundle.patch` → 自动把 `dsh-llm-api-pool` 追加进 `dsh.profile.bundles`;
3. 启动时合成 `cordis.patch.yml`,host 半(shell 池管理逻辑 + `/llm-pool/api` JSON 路由)挂进 host 组合;`dsh.client` 声明让 client 半(设置页)被 web shell 装载。

## 使用

1. 打开 **设置 → LLM API 池**;
2. **+ 添加 API**:预设选 OpenCode Go(自动填入 zen/go/v1 与 5h $12 / 周 $30 / 月 $60 限额),粘贴 OPENCODE_API_KEY → 添加并自动探查模型;
3. 卡片上 **「刷新限额 / 查询余额」** 调用官方 `/usage` 端点,显示 `[官方] $x.xx / $cap (p%) · 重置 HH:MM:SS`;
4. 添加第二个订阅(不同 key)→ 第二张卡片,独立限额;模型请求自动优先路由到余量最大的订阅。

模型也可直接调用池工具:`llm_pool_list` / `llm_pool_add` / `llm_pool_remove` / `llm_pool_update` / `llm_pool_probe` / `llm_pool_usage` / `llm_pool_limits` / `llm_pool_route` / `llm_pool_chat` / `llm_pool_balance`。

## 数据存储

条目持久化在 `sandboxPolicy.workspaceRoot/.dsh-llm-api-pool.json`(含掩码 key、官方用量缓存、本地账本)。

## 开发

```bash
# host/client 半由 llm-pool-test/e2e.test.mjs 端到端测试守护:
# (T1 host 逻辑 / T1b 多订阅路由 / T2 client 渲染 / T3 live 端点 / T4 真实 key 全生命周期)
node llm-pool-test/e2e.test.mjs          # 无 key:32 项含 SKIP
LLM_POOL_TEST_KEY=sk-... node llm-pool-test/e2e.test.mjs   # 真实全生命周期
```

## License

MIT