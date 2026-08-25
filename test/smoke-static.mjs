#!/usr/bin/env node
// Static-package smoke test: loads lib/index.js with a mocked ctx (webServer/tools/shell/fs),
// then drives the full API through the mounted /llm-pool/api route. Pass = the published
// package's host half is wired correctly (tools + JSON bridge + balance official path).
import { Readable } from 'node:stream';

const files = new Map();
const registered = [];
const routes = [];
const llmCalls = { configurable: null, adapter: null, discovery: null };
const settingsCalls = { ns: null };
const chatBodies = [];

function makeCtx() {
  return {
    shell: {
      resolve: (s) => s,
      async run(spec) {
        const url = spec.env.LLM_POOL_URL;
        if (url.includes('/models')) return { stdout: { text: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }] }) + '\n200' }, exitCode: 0 };
        if (url.includes('/usage')) return { stdout: { text: JSON.stringify({ usage: { rolling: { percent: 9, resetsAt: 't' }, weekly: { percent: 13, resetsAt: 't' }, monthly: { percent: 6, resetsAt: 't' } } }) + '\n200' }, exitCode: 0 };
        if (url.includes('/chat/completions')) {
          if (spec.stdin) { try { chatBodies.push(JSON.parse(String(spec.stdin))); } catch {} }
          return { stdout: { text: JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 500 }, choices: [{ message: { role: 'assistant', content: 'mock answer' }, finish_reason: 'stop' }] }) + '\n200' }, exitCode: 0 };
        }
        return { stdout: { text: 'nf\n404' }, exitCode: 0 };
      },
    },
    get: (k) => ({
      fs: {
        async resolve(p) { return p; },
        async stat(p) { return files.has(p) ? { size: 1 } : null; },
        async readText(p) { return files.get(p); },
        async writeText(p, t) { files.set(p, t); },
      },
      sandboxPolicy: { workspaceRoot: '/mem' },
      llm: {
        registerConfigurableProviders: (entries) => { llmCalls.configurable = entries; return () => {}; },
        registerAdapter: (providers, adapter) => { llmCalls.adapter = { providers, adapter }; return () => {}; },
        registerModelDiscovery: (ns, discover) => { llmCalls.discovery = { ns, discover }; return () => {}; },
      },
      settings: {
        register: (ns, schema) => { settingsCalls.ns = ns; return { get: () => schema }; },
      },
    }[k]),
    effect: (fn) => fn(),
    tools: { register: (def) => { registered.push(def.name); return () => {}; } },
    webServer: { register: (opts) => { routes.push(opts); return () => {}; } },
  };
}

function fakeRes() {
  const r = { status: 0, body: '' };
  r.writeHead = (s) => { r.status = s; };
  r.end = (b) => { r.body = b; };
  return r;
}
function post(route, path, body, method) {
  const req = new Readable({ read() {} });
  req.url = path;
  req.method = method || 'POST';
  req.push(JSON.stringify(body));
  req.push(null);
  const res = fakeRes();
  return route.handler(req, res).then(() => ({ status: res.status, body: res.body ? JSON.parse(res.body) : null }));
}
function getReq(route, path) {
  const req = new Readable({ read() {} });
  req.url = path;
  req.method = 'GET';
  req.push(null);
  const res = fakeRes();
  return route.handler(req, res).then(() => ({ status: res.status, body: res.body ? JSON.parse(res.body) : null }));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); } else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const { apply, name, VERSION, inject } = await import('../lib/index.js');
await apply(makeCtx());

check('exports (name/VERSION/inject)', name === 'dsh-llm-api-pool' && /^0\.1\./.test(VERSION) && inject.includes('webServer') && inject.includes('tools'), `${name}@${VERSION}`);
check('10 tools registered', registered.length === 10, 'got ' + registered.length);
check('routes mounted (/api + /v1)', routes.length === 2 && routes[0].path === '/llm-pool/api' && routes[1].path === '/llm-pool/v1', JSON.stringify(routes.map((r) => r.path)));

const route = routes[0];
const add = await post(route, '/llm-pool/api/add', { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test-000', preset: 'opencode-go' });
check('add via route → 200 + entry', add.status === 200 && add.body.ok && add.body.id === 'api-1' && add.body.existed === false, JSON.stringify(add.body));
check('add probed models', add.body.probe && add.body.probe.models.length === 2, JSON.stringify(add.body.probe));

const bal = await post(route, '/llm-pool/api/balance', { id: add.body.id });
check('balance via route → official /usage rolling 9%', bal.status === 200 && bal.body.ok && bal.body.result && bal.body.result.ok && bal.body.result.windows.rolling.percent === 9, JSON.stringify(bal.body));

const list = await post(route, '/llm-pool/api/list', {});
check('list via route → 1 entry, key masked', list.status === 200 && list.body.pool.length === 1 && /^\S*\*{4}\S*$/.test(list.body.pool[0].apiKey), JSON.stringify(list.body.pool));

// ---- OpenAI-compatible provider endpoints ----
const models = await getReq(routes[1], '/llm-pool/v1/models');
check('GET /v1/models union → both probed ids', models.status === 200 && models.body.object === 'list' && models.body.data.map((m) => m.id).includes('deepseek-v4-flash') && models.body.data.map((m) => m.id).includes('kimi-k3'), JSON.stringify(models.body));

// chat/completions
const chat = await post(routes[1], '/llm-pool/v1/chat/completions', { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });
check('openai chat/completions → content + usage', chat.status === 200 && chat.body.object === 'chat.completion' && chat.body.choices && chat.body.choices[0] && typeof chat.body.choices[0].message.content === 'string', JSON.stringify(chat.body));
check('openai chat usage token counts', chat.body.usage && chat.body.usage.total_tokens > 0, JSON.stringify(chat.body.usage));
check('openai chat pool metadata (api used)', chat.body.pool && chat.body.pool.api && chat.body.pool.api.id === 'api-1', JSON.stringify(chat.body.pool));

// unknown model → OpenAI-shaped error
const badModel = await post(routes[1], '/llm-pool/v1/chat/completions', { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] });
check('unknown model → openai error shape (502)', badModel.status === 502 && badModel.body.error && /covers model/.test(badModel.body.error.message), JSON.stringify(badModel.body));

// ---- DSH native provider registration ----
check('provider registered in directory', llmCalls.configurable && llmCalls.configurable.length === 1 && llmCalls.configurable[0].provider === 'dsh-llm-api-pool' && llmCalls.configurable[0].settingsNs === 'llm-api-pool', JSON.stringify(llmCalls.configurable));
check('adapter registered for provider', llmCalls.adapter && Array.isArray(llmCalls.adapter.providers) && llmCalls.adapter.providers.includes('dsh-llm-api-pool') && typeof llmCalls.adapter.adapter.stream === 'function', JSON.stringify(llmCalls.adapter && llmCalls.adapter.providers));
check('model discovery registered', llmCalls.discovery && llmCalls.discovery.ns === 'llm-api-pool', JSON.stringify(llmCalls.discovery));
check('settings ns registered (zero-config)', settingsCalls.ns === 'llm-api-pool', String(settingsCalls.ns));

// adapter behavior: model list = pool union
const adapter = llmCalls.adapter.adapter;
const adapterModels = await adapter.listModels('dsh-llm-api-pool');
check('adapter listModels → pool union', adapterModels.map((m) => m.id).includes('deepseek-v4-flash') && adapterModels.map((m) => m.id).includes('kimi-k3'), JSON.stringify(adapterModels));

// reasoning effort: resolveModel advertises efforts so the Model picker shows a selector
const rmeta = await adapter.resolveModel('dsh-llm-api-pool', 'deepseek-v4-flash');
check('resolveModel reasoning efforts (picker data)', rmeta.reasoning && Array.isArray(rmeta.reasoning.efforts) && rmeta.reasoning.efforts.length >= 3 && rmeta.reasoning.efforts.some((e) => e.id === 'low') && rmeta.reasoning.efforts.some((e) => e.id === 'high'), JSON.stringify(rmeta.reasoning));

// full LlmRuntime-facing surface: every method the runtime invokes on an adapter instance
// (providerInfo/providerRetryPolicy/listModels/resolveModel/prepareCall/stream — a missing
// one surfaces at request time as "registration.adapter.X is not a function")
check('adapter surface complete (runtime contract)', ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream'].every((m) => typeof adapter[m] === 'function'), Object.fromEntries(['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream'].map((m) => [m, typeof adapter[m]])));
const prepared = await adapter.prepareCall('dsh-llm-api-pool', 'deepseek-v4-flash');
check('prepareCall → {model(with reasoning), stream fn}', prepared && prepared.model && prepared.model.id === 'deepseek-v4-flash' && Array.isArray(prepared.model.reasoning && prepared.model.reasoning.efforts) && typeof prepared.stream === 'function', JSON.stringify({ model: prepared && prepared.model, streamType: typeof (prepared && prepared.stream) }));

// adapter stream: DSH GenerateOptions → pool routing → StreamChunks
const chunks = [];
for await (const chunk of adapter.stream({
  provider: 'dsh-llm-api-pool',
  model: 'deepseek-v4-flash',
  system: 'be brief',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) chunks.push(chunk);
const kinds = chunks.map((c) => c.type);
check('adapter stream → block-start/text-delta/block-end/usage/finish', kinds.includes('block-start') && kinds.includes('text-delta') && kinds.includes('block-end') && kinds.includes('usage') && kinds.includes('finish'), kinds.join(','));
const finish = chunks.find((c) => c.type === 'finish');
check('adapter stream finish → stop', finish && finish.reason && finish.reason.kind === 'stop', JSON.stringify(finish));
const usage = chunks.find((c) => c.type === 'usage');
check('adapter stream usage tokens', usage && usage.usage && usage.usage.inputTokens === 1000 && usage.usage.outputTokens === 500, JSON.stringify(usage))

// reasoning effort forwards to the upstream OpenAI body
for await (const c of adapter.stream({
  provider: 'dsh-llm-api-pool', model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) void c;
check('stream forwards reasoning_effort=high', chatBodies.some((b) => b.reasoning_effort === 'high'), JSON.stringify(chatBodies));

console.log(failures === 0 ? '\nsmoke: ALL GREEN' : `\nsmoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);