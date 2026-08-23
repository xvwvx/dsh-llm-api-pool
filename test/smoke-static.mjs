#!/usr/bin/env node
// Static-package smoke test: loads lib/index.js with a mocked ctx (webServer/tools/shell/fs),
// then drives the full API through the mounted /llm-pool/api route. Pass = the published
// package's host half is wired correctly (tools + JSON bridge + balance official path).
import { Readable } from 'node:stream';

const files = new Map();
const registered = [];
const routes = [];

function makeCtx() {
  return {
    shell: {
      resolve: (s) => s,
      async run(spec) {
        const url = spec.env.LLM_POOL_URL;
        if (url.includes('/models')) return { stdout: { text: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }] }) + '\n200' }, exitCode: 0 };
        if (url.includes('/usage')) return { stdout: { text: JSON.stringify({ usage: { rolling: { percent: 9, resetsAt: 't' }, weekly: { percent: 13, resetsAt: 't' }, monthly: { percent: 6, resetsAt: 't' } } }) + '\n200' }, exitCode: 0 };
        if (url.includes('/chat/completions')) return { stdout: { text: JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 500 } }) + '\n200' }, exitCode: 0 };
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
function post(route, path, body) {
  const req = new Readable({ read() {} });
  req.url = path;
  req.method = 'POST';
  req.push(JSON.stringify(body));
  req.push(null);
  const res = fakeRes();
  return route.handler(req, res).then(() => ({ status: res.status, body: JSON.parse(res.body) }));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); } else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const { apply, name, VERSION, inject } = await import('../lib/index.js');
await apply(makeCtx());

check('exports (name/VERSION/inject)', name === 'dsh-llm-api-pool' && VERSION === '0.1.0' && inject.includes('webServer') && inject.includes('tools'), `${name}@${VERSION}`);
check('10 tools registered', registered.length === 10, 'got ' + registered.length);
check('route /llm-pool/api mounted', routes.length === 1 && routes[0].path === '/llm-pool/api', JSON.stringify(routes.map((r) => r.path)));

const route = routes[0];
const add = await post(route, '/llm-pool/api/add', { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test-000', preset: 'opencode-go' });
check('add via route → 200 + entry', add.status === 200 && add.body.ok && add.body.id === 'api-1' && add.body.existed === false, JSON.stringify(add.body));
check('add probed models', add.body.probe && add.body.probe.models.length === 2, JSON.stringify(add.body.probe));

const bal = await post(route, '/llm-pool/api/balance', { id: add.body.id });
check('balance via route → official /usage rolling 9%', bal.status === 200 && bal.body.ok && bal.body.result && bal.body.result.ok && bal.body.result.windows.rolling.percent === 9, JSON.stringify(bal.body));

const list = await post(route, '/llm-pool/api/list', {});
check('list via route → 1 entry, key masked', list.status === 200 && list.body.pool.length === 1 && /^\S*\*{4}\S*$/.test(list.body.pool[0].apiKey), JSON.stringify(list.body.pool));

console.log(failures === 0 ? '\nsmoke: ALL GREEN' : `\nsmoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);