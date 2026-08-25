import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

/**
 * dsh-llm-api-pool host half — multi-subscription LLM API pool manager.
 *
 * Entries are keyed by {baseUrl, apiKey}: re-adding the same key updates that
 * entry in place (existed:true), a different key creates a new subscription.
 * For opencode go entries the gateway-native GET {baseUrl}/usage answers with
 * official rolling/weekly/monthly percent + resetsAt using the pure API key;
 * that usage is cached as usageRemote (5 min TTL) and drives usage-aware
 * routing — least official pressure first, exhaustion sinks, failures cool
 * 60s and fall through to the next candidate.
 *
 * Mount: one `insert` row from cordis.patch.yml via `dsh plugin add
 * dsh-llm-api-pool`; client half served from package.json `dsh.client`.
 */

/** Plugin identity for cordis.yml rows. */
const name = 'dsh-llm-api-pool';

/** Services required before mounting. */
const inject = ['webServer', 'tools'];

/** Provider route this plugin registers as a DSH native model provider. */
const PROVIDER = 'dsh-llm-api-pool';

/** Settings namespace for the provider (registered lazily when settings exist). */
const NS = 'llm-api-pool';

/**
 * Reasoning efforts advertised for every pool model. opencode go's OpenAI
 * gateway accepts `reasoning_effort` = low | medium | high | max and rejects
 * "off" (deserialize error), so "off" is deliberately absent — the gateway's
 * own default applies when the user does not pick one.
 */
const POOL_REASONING_EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
];

/** Plugin version, kept in sync with package.json `version`. */
const VERSION = '0.1.7';

/** Collect a request body as UTF-8 text (node IncomingMessage). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
    });
    req.on('end', () => {
      const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      resolve(new TextDecoder().decode(merged));
    });
    req.on('error', reject);
  });
}

/** JSON reply helper. */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body));
}

async function apply(ctx) {
  // ---- static-surface compat: dynamic body calls these names ----
  const allHandlers = {};
  const harness = {
    defineTool: (opts) => defineTool(opts),
    registerTool: (_ctx, def) => ctx.effect(() => ctx.tools.register(def), 'dsh-llm-api-pool: register tool ' + def.name),
    handle: (method, fn) => { allHandlers[method] = fn; },
  };

    const shell = ctx.shell;
    const fs = ctx.get('fs');
    const sandboxPolicy = ctx.get('sandboxPolicy');
    const workspaceRoot = sandboxPolicy ? sandboxPolicy.workspaceRoot : undefined;

    // ---- opencode go authoritative model prices (USD per 1M tokens, from opencode-ai 1.18.16) ----
    const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1';
    const OPENCODE_GO_LIMITS = { h5Usd: 12, weekUsd: 30, monthUsd: 60 };
    const OPENCODE_CONSOLE = 'https://console.opencode.ai';
    const OPENCODE_GO_COSTS = {
      'qwen3.7-plus': { in: 0.4, out: 1.6, cacheIn: 0.04 },
      'glm-5': { in: 1.0, out: 3.2, cacheIn: 0.2 },
      'qwen3.5-plus': { in: 0.2, out: 1.2, cacheIn: 0.02 },
      'glm-5.1': { in: 1.4, out: 4.4, cacheIn: 0.26 },
      'mimo-v2-omni': { in: 0.4, out: 2.0, cacheIn: 0.08 },
      'deepseek-v4-flash': { in: 0.07, out: 0.14, cacheIn: 0.0014 },
      'kimi-k2.5': { in: 0.6, out: 3.0, cacheIn: 0.1 },
      'minimax-m2.7': { in: 0.3, out: 1.2, cacheIn: 0.06 },
      'glm-5.2': { in: 1.4, out: 4.4, cacheIn: 0.26 },
      'qwen3.7-max': { in: 2.5, out: 7.5, cacheIn: 0.5 },
      'kimi-k2.6': { in: 0.95, out: 4.0, cacheIn: 0.16 },
      'mimo-v2-pro': { in: 1.0, out: 3.0, cacheIn: 0.2 },
      'minimax-m3': { in: 0.3, out: 1.2, cacheIn: 0.06 },
      'deepseek-v4-pro': { in: 0.435, out: 0.87, cacheIn: 0.003625 },
      'qwen3.8-max': { in: 2.0, out: 6.0, cacheIn: 0.25 },
      'mimo-v2.5': { in: 0.14, out: 0.28, cacheIn: 0.0028 },
      'minimax-m2.5': { in: 0.3, out: 1.2, cacheIn: 0.03 },
      'gpt-5.6-luna': { in: 0.1, out: 0.6, cacheIn: 0.01 },
      'grok-4.5': { in: 2.0, out: 6.0, cacheIn: 0.5 },
      'kimi-k2.7-code': { in: 0.95, out: 4.0, cacheIn: 0.19 },
      'kimi-k3': { in: 3.0, out: 15.0, cacheIn: 0.3 },
      'mimo-v2.5-pro': { in: 0.435, out: 0.87, cacheIn: 0.003625 },
      'qwen3.6-plus': { in: 0.5, out: 3.0, cacheIn: 0.05 },
    };

    // ---- persistence ----
    const FILE_NAME = '.dsh-llm-api-pool.json';
    const poolPath = workspaceRoot ? workspaceRoot.replace(/[\\/]+$/, '') + '/' + FILE_NAME : FILE_NAME;
    let state = { version: 2, entries: [] };
    let writeChain = Promise.resolve();

    async function load() {
      if (!fs) return;
      try {
        const target = await fs.resolve(poolPath);
        const info = await fs.stat(target);
        if (info) {
          const text = await fs.readText(target);
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.entries)) state = { version: 2, entries: parsed.entries };
        }
      } catch (err) {
        console.error('[llm-pool] load failed: ' + (err && err.message || String(err)));
      }
    }

    function persist() {
      if (!fs) return Promise.resolve();
      writeChain = writeChain.then(async () => {
        try {
          const target = await fs.resolve(poolPath);
          await fs.writeText(target, JSON.stringify(state, null, 2));
        } catch (err) {
          console.error('[llm-pool] persist failed: ' + (err && err.message || String(err)));
        }
      });
      return writeChain;
    }

    // ---- helpers ----
    function mask(key) {
      if (!key) return '(empty)';
      if (key.length <= 8) return key.slice(0, 2) + '****';
      return key.slice(0, 4) + '****' + key.slice(-4);
    }
    function truncate(text, n) {
      if (typeof text !== 'string') return String(text || '');
      return text.length <= n ? text : text.slice(0, n) + '…(truncated)';
    }
    function parseJsonOrNull(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    }
    function safeUrl(value, allowEmpty) {
      const s = String(value || '').trim();
      if (!s && allowEmpty) return s;
      if (s.startsWith('http://') || s.startsWith('https://')) {
        if (/["\$`]/.test(s)) throw new Error('URL contains unsupported characters');
        return s.replace(/\/+$/, '');
      }
      if (allowEmpty && s.startsWith('/')) {
        if (/["\$`\s]/.test(s)) throw new Error('path contains unsupported characters');
        return s;
      }
      throw new Error('baseUrl must start with http:// or https://');
    }
    function ensureModelUsage(entry, model) {
      if (!entry.modelUsage) entry.modelUsage = {};
      if (!entry.modelUsage[model]) entry.modelUsage[model] = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
      if (!entry.usage) entry.usage = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
    }
    function estimateUsd(entry, model, usage) {
      const costs = entry.costs || {};
      const c = costs[model];
      if (!c) return 0;
      const prompt = (usage && usage.prompt_tokens) || 0;
      const completion = (usage && usage.completion_tokens) || 0;
      const details = usage && usage.prompt_tokens_details || null;
      const cached = details && details.cached_tokens || 0;
      const uncached = Math.max(0, prompt - cached);
      return (uncached / 1e6) * (c.in || 0) + (cached / 1e6) * (c.cacheIn || 0) + (completion / 1e6) * (c.out || 0);
    }
    function recordUsage(entry, model, code, parsed) {
      ensureModelUsage(entry, model);
      const usage = parsed && parsed.usage || {};
      const pt = Number(usage.prompt_tokens) || 0;
      const ct = Number(usage.completion_tokens) || 0;
      const ok = code >= 200 && code < 300;
      entry.usage.requests += 1;
      entry.usage.promptTokens += pt;
      entry.usage.completionTokens += ct;
      entry.usage.lastUsedAt = new Date().toISOString();
      const mu = entry.modelUsage[model];
      mu.requests += 1;
      mu.promptTokens += pt;
      mu.completionTokens += ct;
      if (!ok) { entry.usage.errors += 1; mu.errors += 1; return; }
      const usd = estimateUsd(entry, model, usage);
      if (!entry.usageLog) entry.usageLog = [];
      entry.usageLog.push({ ts: Date.now(), usd, model, promptTokens: pt, completionTokens: ct });
      const cutoff = Date.now() - 31 * 24 * 3600 * 1000;
      if (entry.usageLog.length > 5000) entry.usageLog = entry.usageLog.filter((r) => r && r.ts >= cutoff);
    }
    function limitsStatus(entry) {
      const limits = entry.limits || null;
      if (!limits) return null;
      const now = Date.now();
      const log = entry.usageLog || [];
      let h5 = 0, week = 0, month = 0;
      for (const r of log) {
        if (!r || typeof r.ts !== 'number') continue;
        if (r.ts >= now - 5 * 3600 * 1000) h5 += r.usd || 0;
        if (r.ts >= now - 7 * 24 * 3600 * 1000) week += r.usd || 0;
        if (r.ts >= now - 30 * 24 * 3600 * 1000) month += r.usd || 0;
      }
      const pct = (used, cap) => cap > 0 ? Math.round(used / cap * 1000) / 10 : (used > 0 ? 999 : 0);
      return {
        configured: true,
        h5: { capUsd: limits.h5Usd || 0, usedUsd: Math.round(h5 * 100) / 100, pct: pct(h5, limits.h5Usd) },
        week: { capUsd: limits.weekUsd || 0, usedUsd: Math.round(week * 100) / 100, pct: pct(week, limits.weekUsd) },
        month: { capUsd: limits.monthUsd || 0, usedUsd: Math.round(month * 100) / 100, pct: pct(month, limits.monthUsd) },
      };
    }
    function remotePressure(entry) {
      const r = entry.usageRemote;
      if (!r || !r.windows || !r.fetchedAt) return -1;
      const age = Date.now() - new Date(r.fetchedAt).getTime();
      if (!Number.isFinite(age) || age > 5 * 60 * 1000) return -1; // stale -> local fallback
      const pcts = [r.windows.rolling, r.windows.weekly, r.windows.monthly]
        .map((w) => (w && typeof w.percent === 'number') ? w.percent : null)
        .filter((x) => x !== null);
      if (pcts.length === 0) return -1;
      return Math.max.apply(null, pcts) / 100;
    }
    function cooldown(entry, reason) {
      entry.cooldownUntil = Date.now() + 60000;
      entry.cooldownReason = reason;
    }
    function usageScore(entry, model) {
      const mu = entry.modelUsage && entry.modelUsage[model];
      const base = mu || entry.usage || {};
      const tokens = (base.promptTokens || 0) + (base.completionTokens || 0);
      const requests = base.requests || 0;
      const errPenalty = (base.errors || 0) * 1000;
      const cooldownPenalty = entry.cooldownUntil && entry.cooldownUntil > Date.now() ? 1e9 : 0;
      let limitPenalty = 0;
      const pressure = remotePressure(entry);
      if (pressure >= 0) {
        if (pressure >= 1) limitPenalty = 2e9;
        else limitPenalty = pressure * 5e6;
      } else {
        const lim = limitsStatus(entry);
        if (lim) {
          const p = Math.max(lim.h5.pct, lim.week.pct, lim.month.pct) / 100;
          if (p >= 1) limitPenalty = 2e9;
          else limitPenalty = p * 5e6;
        }
      }
      return tokens + requests * 10 + errPenalty + cooldownPenalty + limitPenalty;
    }
    function candidatesFor(model) {
      return state.entries
        .filter((e) => e.enabled && Array.isArray(e.models) && e.models.indexOf(model) !== -1)
        .map((e) => ({ entry: e, score: usageScore(e, model) }))
        .sort((a, b) => a.score - b.score);
    }
    function summaryView() {
      return state.entries.map((e) => ({
        id: e.id,
        name: e.name,
        baseUrl: e.baseUrl,
        apiKey: mask(e.apiKey),
        enabled: !!e.enabled,
        models: e.models || [],
        modelsFetchedAt: e.modelsFetchedAt || null,
        lastProbeError: e.lastProbeError || null,
        cooldownUntil: e.cooldownUntil || null,
        cooldownReason: e.cooldownReason || null,
        limits: e.limits || null,
        limitsStatus: limitsStatus(e),
        usageRemote: e.usageRemote ? { fetchedAt: e.usageRemote.fetchedAt, windows: e.usageRemote.windows } : null,
        usage: {
          requests: (e.usage && e.usage.requests) || 0,
          promptTokens: (e.usage && e.usage.promptTokens) || 0,
          completionTokens: (e.usage && e.usage.completionTokens) || 0,
          errors: (e.usage && e.usage.errors) || 0,
          lastUsedAt: (e.usage && e.usage.lastUsedAt) || null,
        },
      }));
    }

    // ---- http via curl (sandbox disables fetch) ----
    async function curlJson(entry, method, path, bodyObj, signal) {
      const base = safeUrl(entry.baseUrl);
      const url = base + path;
      const bodyFlag = bodyObj !== undefined ? ' --data-binary @-' : '';
      const command = 'curl -sS -m 120 -w "\\n%{http_code}" -X ' + method +
        ' "$LLM_POOL_URL" -H "Authorization: Bearer $LLM_POOL_KEY"' +
        ' -H "Content-Type: application/json"' + bodyFlag;
      const spec = shell.resolve({
        command,
        env: { LLM_POOL_URL: url, LLM_POOL_KEY: entry.apiKey },
        stdin: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
        stdoutMaxBytes: 8 * 1024 * 1024,
        timeoutMs: 120000,
        signal,
      });
      const result = await shell.run(spec);
      const text = result.stdout.text || '';
      const idx = text.lastIndexOf('\n');
      const codeStr = (idx >= 0 ? text.slice(idx + 1) : text).trim();
      const bodyText = idx >= 0 ? text.slice(0, idx) : '';
      const code = parseInt(codeStr, 10);
      if (!Number.isFinite(code)) {
        const stderr = (result.stderr && result.stderr.text || '').trim();
        throw new Error('curl failed: exit=' + result.exitCode + (stderr ? ' stderr=' + truncate(stderr, 300) : ''));
      }
      return { code, body: bodyText };
    }

    async function probeEntry(entry, signal) {
      try {
        const res = await curlJson(entry, 'GET', '/models', undefined, signal);
        if (res.code === 200) {
          const parsed = parseJsonOrNull(res.body);
          const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
          const models = data.map((m) => typeof m === 'string' ? m : (m && m.id)).filter(Boolean);
          entry.models = models;
          entry.modelsFetchedAt = new Date().toISOString();
          entry.lastProbeError = null;
          return { id: entry.id, name: entry.name, ok: true, models };
        }
        entry.lastProbeError = 'HTTP ' + res.code + ': ' + truncate(res.body, 200);
        entry.models = entry.models || [];
        return { id: entry.id, name: entry.name, ok: false, error: entry.lastProbeError };
      } catch (err) {
        entry.lastProbeError = String(err && err.message || err);
        entry.models = entry.models || [];
        return { id: entry.id, name: entry.name, ok: false, error: entry.lastProbeError };
      }
    }


    function isCsvish(text) {
      return typeof text === 'string' && text.length > 0 && (text.indexOf(',') !== -1 || text.split('\n').length > 1) && text.indexOf('{') === -1;
    }
    async function curlOpen(entry, pathQuery, signal) {
      const url = OPENCODE_CONSOLE + pathQuery;
      const command = 'curl -sS -m 30 -w "\n%{http_code}" "$LLM_POOL_URL" -H "Authorization: Bearer $LLM_POOL_KEY" -H "Content-Type: application/json"';
      const spec = shell.resolve({
        command,
        env: { LLM_POOL_URL: url, LLM_POOL_KEY: entry.apiKey },
        stdoutMaxBytes: 8 * 1024 * 1024,
        timeoutMs: 30000,
        signal,
      });
      const result = await shell.run(spec);
      const text = result.stdout.text || '';
      const idx = text.lastIndexOf('\n');
      const codeStr = (idx >= 0 ? text.slice(idx + 1) : text).trim();
      const bodyText = idx >= 0 ? text.slice(0, idx) : '';
      const code = parseInt(codeStr, 10);
      if (!Number.isFinite(code)) {
        const stderr = (result.stderr && result.stderr.text || '').trim();
        throw new Error('curl failed: exit=' + result.exitCode + (stderr ? ' stderr=' + truncate(stderr, 300) : ''));
      }
      return { code, body: bodyText };
    }
    async function checkBalance(entry, endpointOverride, signal) {
      // Tier 0: gateway-native /usage (verified live on opencode zen/go/v1: pure API key -> official
      // rolling/weekly/monthly percent + resetsAt). Tier 1: console.opencode.ai routes (public usage
      // export works with the OPENCODE_API_KEY bearer; summary/balance need an org actor token).
      if (!endpointOverride && !entry.usagePath && entry.baseUrl && entry.baseUrl.indexOf('opencode.ai') !== -1) {
        const tried = [];
        // Tier 0: {baseUrl}/usage
        try {
          const res = await curlJson(entry, 'GET', '/usage', undefined, signal);
          tried.push('/usage');
          if (res.code === 200) {
            const parsed = parseJsonOrNull(res.body);
            const u = parsed && parsed.usage;
            if (u && typeof u === 'object' && (u.rolling || u.weekly || u.monthly)) {
              const limits = entry.limits || OPENCODE_GO_LIMITS;
              const win = (w, cap) => {
                if (!w || typeof w !== 'object') return null;
                const pct = typeof w.percent === 'number' ? w.percent : null;
                return {
                  status: w.status || null,
                  percent: pct,
                  capUsd: cap,
                  usedUsd: pct !== null ? Math.round(cap * pct / 100 * 100) / 100 : null,
                  resetsAt: w.resetsAt || null,
                };
              };
              const windows = {
                rolling: win(u.rolling, limits.h5Usd || 12),
                weekly: win(u.weekly, limits.weekUsd || 30),
                monthly: win(u.monthly, limits.monthUsd || 60),
              };
              entry.usageRemote = { fetchedAt: new Date().toISOString(), windows };
              await persist();
              return {
                id: entry.id, name: entry.name, ok: true,
                source: 'opencode.ai/zen/go/v1/usage', path: '/usage', official: true,
                windows,
                balance: parsed,
              };
            }
          }
        } catch { /* fall through to console routes */ }
        // Tier 1: console.opencode.ai official routes
        const officialPaths = [
          '/api/v1/usage/export?scope=service_account&range=24h',
          '/api/usage/summary?range=24h',
          '/api/billing/balance/summary',
        ];
        for (const p of officialPaths) {
          tried.push(p);
          try {
            const res = await curlOpen(entry, p, signal);
            if (res.code === 200) {
              const parsed = parseJsonOrNull(res.body);
              if (parsed !== null || isCsvish(res.body)) {
                return { id: entry.id, name: entry.name, ok: true, source: 'console.opencode.ai', path: p, balance: parsed !== null ? parsed : res.body, official: true };
              }
            }
            if (res.code === 401) continue; // unauthenticated: try next official route
          } catch { /* try next */ }
        }
        if (tried.length > 0) {
          // Official routes reachable but unauthenticated -> report honestly with local estimate fallback
          return { id: entry.id, name: entry.name, ok: false, official: true, tried, error: 'official usage routes unreachable (gateway /usage and console.opencode.ai all failed; /usage needs a valid key, export accepts the API key, summary/balance need the console org token)', estimated: limitsStatus(entry) };
        }
      }
      const paths = endpointOverride ? [endpointOverride] : (entry.usagePath ? [entry.usagePath] : ['/user/balance', '/api/v1/auth/key', '/v1/usage', '/dashboard/billing/usage']);
      const tried = [];
      for (const p of paths) {
        tried.push(p);
        try {
          const res = await curlJson(entry, 'GET', p, undefined, signal);
          if (res.code === 200) {
            const parsed = parseJsonOrNull(res.body);
            return { id: entry.id, name: entry.name, ok: true, path: p, balance: parsed !== null ? parsed : res.body };
          }
        } catch { /* try next */ }
      }
      const estimated = limitsStatus(entry);
      return {
        id: entry.id, name: entry.name, ok: false, tried,
        error: 'no usage/balance endpoint answered with 200',
        estimated,
      };
    }

    async function maybeRefreshRemote(entry, signal) {
      if (!entry.baseUrl || entry.baseUrl.indexOf('opencode.ai') === -1) return;
      const r = entry.usageRemote;
      const fresh = r && r.fetchedAt && (Date.now() - new Date(r.fetchedAt).getTime()) < 5 * 60 * 1000;
      if (fresh) return;
      try {
        const res = await checkBalance(entry, undefined, signal);
        if (res && res.ok && res.windows) {
          entry.usageRemote = { fetchedAt: new Date().toISOString(), windows: res.windows };
          await persist();
        }
      } catch { /* non-blocking */ }
    }

    async function chatThrough(model, messages, chatArgs, signal) {
      const body = { model, messages };
      if (chatArgs.temperature !== undefined) body.temperature = chatArgs.temperature;
      if (chatArgs.max_tokens !== undefined) body.max_tokens = chatArgs.max_tokens;
      if (chatArgs.top_p !== undefined) body.top_p = chatArgs.top_p;
      if (chatArgs.stream !== undefined) body.stream = chatArgs.stream;
      if (chatArgs.extra && typeof chatArgs.extra === 'object') Object.assign(body, chatArgs.extra);

      const candidates = candidatesFor(model);
      if (candidates.length === 0) {
        return { ok: false, error: 'no-api-covers-model', model, pool: summaryView() };
      }
      // Multi-subscription routing: refresh stale official usage (non-blocking) so the
      // least-consumed subscription wins even when the local ledger is empty.
      if (candidates.length > 1) {
        const stale = candidates.some((c) => {
          const r = c.entry.usageRemote;
          return !r || !r.fetchedAt || (Date.now() - new Date(r.fetchedAt).getTime()) > 5 * 60 * 1000;
        });
        if (stale) await Promise.all(candidates.map((c) => maybeRefreshRemote(c.entry, signal).catch(() => {})));
      }
      const attempts = [];
      for (const cand of candidates) {
        const entry = cand.entry;
        try {
          const res = await curlJson(entry, 'POST', '/chat/completions', body, signal);
          const parsed = parseJsonOrNull(res.body);
          recordUsage(entry, model, res.code, parsed);
          if (res.code >= 200 && res.code < 300) {
            await persist();
            return {
              ok: true,
              model,
              api: { id: entry.id, name: entry.name, baseUrl: entry.baseUrl },
              usage: {
                promptTokens: (entry.modelUsage[model].promptTokens || 0) + 0,
                completionTokens: (entry.modelUsage[model].completionTokens || 0) + 0,
                requests: entry.usage.requests,
              },
              limits: limitsStatus(entry),
              responded: parsed !== null ? parsed : res.body,
              tried: attempts,
            };
          }
          const hint = parsed && parsed.error ? (typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error))) : ('HTTP ' + res.code);
          attempts.push({ id: entry.id, name: entry.name, code: res.code, error: truncate(String(hint), 200) });
          entry.usage.lastError = truncate(String(hint), 300);
          cooldown(entry, 'HTTP ' + res.code + (typeof hint === 'string' ? ' ' + truncate(hint, 120) : ''));
        } catch (err) {
          const message = String(err && err.message || err);
          attempts.push({ id: entry.id, name: entry.name, error: truncate(message, 200) });
          entry.usage = entry.usage || { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
          entry.usage.errors += 1;
          entry.usage.lastError = truncate(message, 300);
          cooldown(entry, 'transport');
        }
      }
      await persist();
      return { ok: false, error: 'all-api-failed', model, attempts };
    }

    // ---- entry identity: natural key = baseUrl + apiKey; id is a stable counter ----
    function nextEntryId() {
      let max = 0;
      for (const e of state.entries) {
        const n = parseInt(String(e.id || '').replace(/^api-/, ''), 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      return 'api-' + (max + 1);
    }

    // ---- tools ----
    const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    const tools = [
      {
        name: 'llm_pool_list',
        description: 'List the LLM API pool: every entry (id, name, baseUrl, masked apiKey, enabled), its discovered models, cooldown state, per-entry usage totals, and triple-limit status (5h/week/month USD) when configured. Never returns a full apiKey.',
        parameters: {},
        async execute(args, exec) {
          await persist();
          return { pool: summaryView(), path: poolPath };
        },
      },
      {
        name: 'llm_pool_add',
        description: 'Add or update an API entry in the pool. The natural identity is {baseUrl, apiKey}: re-adding the same key+base updates that entry in place (returns existed:true); a different key creates a new entry. name is an optional display alias, not the identity. Auto-probes GET {baseUrl}/models. Accepts preset:"opencode-go" to fully configure an OpenCode Go entry: baseUrl https://opencode.ai/zen/go/v1, triple limits 5h $12 / week $30 / month $60, and the authoritative 23-model USD price table for local quota estimation. Returns the entry id (masked) and models found.',
        parameters: {
          name: { type: 'string', description: 'Optional display alias. Never the identity: identity is {baseUrl, apiKey}.' },
          baseUrl: { type: 'string', description: 'OpenAI-compatible base URL, e.g. https://api.deepseek.com or https://opencode.ai/zen/go/v1 (do not include /v1 for opencode go).', required: true },
          apiKey: { type: 'string', description: 'API key for this entry (the OPENCODE_API_KEY token for opencode go).', required: true },
          enabled: { type: 'boolean', description: 'Whether the entry participates in routing. Default true.' },
          usagePath: { type: 'string', description: 'Optional provider-specific usage/balance path (e.g. /user/balance).' },
          probe: { type: 'boolean', description: 'Probe /models after add. Default true.' },
          preset: { type: 'string', enum: ['opencode-go'], description: 'Optional preset that overrides baseUrl/limits/costs. opencode-go = 5h $12 / week $30 / month $60 with authoritative model prices.' },
          limits: { type: 'object', additionalProperties: true, description: 'Optional triple limits in USD: {h5Usd, weekUsd, monthUsd}. Used for quota tracking and hot-switch pressure.' },
        },
        async execute(args, exec) {
          const apiKey = String(args.apiKey || '').trim();
          if (!apiKey) throw new Error('apiKey is required');
          let baseUrl = args.baseUrl ? safeUrl(args.baseUrl) : undefined;
          let presetCosts = null;
          let presetLimits = null;
          if (args.preset === 'opencode-go') {
            baseUrl = OPENCODE_GO_BASE;
            presetCosts = OPENCODE_GO_COSTS;
            presetLimits = OPENCODE_GO_LIMITS;
          }
          if (!baseUrl) throw new Error('baseUrl is required (or use preset)');
          const alias = args.name ? String(args.name).trim() : null;
          const existed = !!state.entries.find((e) => e.baseUrl === baseUrl && e.apiKey === apiKey);
          let entry = state.entries.find((e) => e.baseUrl === baseUrl && e.apiKey === apiKey);
          if (entry) {
            if (alias) entry.name = alias;
            if (args.enabled !== undefined) entry.enabled = !!args.enabled;
            if (args.usagePath !== undefined) entry.usagePath = safeUrl(args.usagePath, true);
            if (args.limits) entry.limits = normalizeLimits(args.limits);
            else if (presetLimits) entry.limits = presetLimits;
            if (presetCosts) entry.costs = presetCosts;
          } else {
            entry = {
              id: nextEntryId(),
              name: alias,
              baseUrl,
              apiKey,
              enabled: args.enabled === undefined ? true : !!args.enabled,
              models: [],
              usage: { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 },
              modelUsage: {},
              usageLog: [],
            };
            if (args.usagePath !== undefined) entry.usagePath = safeUrl(args.usagePath, true);
            entry.limits = args.limits ? normalizeLimits(args.limits) : (presetLimits || null);
            if (presetCosts) entry.costs = presetCosts;
            state.entries.push(entry);
          }
          await persist();
          if (args.probe === false) return { id: entry.id, existed, baseUrl, apiKey: mask(apiKey), limits: entry.limits, models: entry.models || [] };
          const probe = await probeEntry(entry, exec.signal);
          await persist();
          return { id: entry.id, existed, baseUrl, apiKey: mask(apiKey), limits: entry.limits, probe };
        },
      },
      {
        name: 'llm_pool_remove',
        description: 'Remove an API entry from the pool permanently by id.',
        parameters: { id: { type: 'string', description: 'Entry id (from llm_pool_list)', required: true } },
        async execute(args, exec) {
          const before = state.entries.length;
          state.entries = state.entries.filter((e) => e.id !== String(args.id));
          await persist();
          return { removed: state.entries.length < before, remaining: state.entries.length };
        },
      },
      {
        name: 'llm_pool_update',
        description: 'Update an entry in place: toggle enabled, rename, re-key, or change triple limits. Only provided fields change.',
        parameters: {
          id: { type: 'string', description: 'Entry id.', required: true },
          enabled: { type: 'boolean', description: 'Participate in routing?' },
          name: { type: 'string', description: 'New display name.' },
          apiKey: { type: 'string', description: 'New api key.' },
          limits: { type: 'object', additionalProperties: true, description: 'Triple limits {h5Usd, weekUsd, monthUsd}.' },
        },
        async execute(args, exec) {
          const entry = state.entries.find((e) => e.id === String(args.id));
          if (!entry) throw new Error('entry not found: ' + args.id);
          if (args.enabled !== undefined) entry.enabled = !!args.enabled;
          if (args.name) entry.name = String(args.name);
          if (args.apiKey) entry.apiKey = String(args.apiKey);
          if (args.limits) entry.limits = normalizeLimits(args.limits);
          await persist();
          return { updated: entry.id, entry: summaryView().find((v) => v.id === entry.id) };
        },
      },
      {
        name: 'llm_pool_probe',
        description: 'Re-discover available models for pool entries by calling GET {baseUrl}/models. With id, only that entry; without, all enabled entries.',
        parameters: { id: { type: 'string', description: 'Optional entry id to probe only.' } },
        async execute(args, exec) {
          const targets = state.entries.filter((e) => !args.id || e.id === String(args.id));
          const results = [];
          for (const entry of targets) results.push(await probeEntry(entry, exec.signal));
          await persist();
          return { results };
        },
      },
      {
        name: 'llm_pool_usage',
        description: 'Query the local usage ledger. Optionally filter by entry id, by model name, or reset (zero the counters). Returns requests, prompt/completion tokens and errors, per entry and per model, plus the triple-limit USD windows when configured.',
        parameters: {
          id: { type: 'string', description: 'Optional entry id filter.' },
          model: { type: 'string', description: 'Optional model-name filter for per-model rows.' },
          reset: { type: 'boolean', description: 'True to zero the counters (and the USD usage log) for the filtered scope (default false).' },
        },
        async execute(args, exec) {
          const scope = state.entries.filter((e) => !args.id || e.id === String(args.id));
          if (args.reset) {
            for (const e of scope) {
              e.usage = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
              e.usageLog = [];
              for (const key of Object.keys(e.modelUsage || {})) {
                const mu = e.modelUsage[key];
                mu.requests = 0; mu.promptTokens = 0; mu.completionTokens = 0; mu.errors = 0;
              }
            }
            await persist();
          }
          const rows = scope.map((e) => ({
            id: e.id, name: e.name, usage: e.usage, limits: limitsStatus(e),
            models: Object.keys(e.modelUsage || {})
              .filter((m) => !args.model || m === String(args.model))
              .map((m) => ({ model: m, ...e.modelUsage[m] })),
          }));
          return { reset: !!args.reset, rows };
        },
      },
      {
        name: 'llm_pool_limits',
        description: 'Query triple-limit status (5h rolling / week / month USD) for pool entries. For OpenCode entries, first tries the gateway-native official endpoint GET {baseUrl}/usage — pure API key, returns rolling/weekly/monthly percent + resetsAt (verified live). Then the console.opencode.ai routes (/api/v1/usage/export with the API key bearer, /api/usage/summary and /api/billing/balance/summary with the org token); falls back to the local estimated ledger (response usage × model price) when unauthenticated. With refresh, probes remote routes; returns configured caps, used USD, and use percentage per window.',
        parameters: {
          id: { type: 'string', description: 'Optional entry id; default all.' },
          refresh: { type: 'boolean', description: 'True to also attempt remote usagePath probes (default false).' },
        },
        async execute(args, exec) {
          const targets = state.entries.filter((e) => !args.id || e.id === String(args.id));
          const results = [];
          for (const entry of targets) {
            const estimated = limitsStatus(entry);
            let remote = null;
            if (args.refresh && (entry.usagePath || entry.baseUrl.indexOf('opencode.ai') !== -1)) {
              remote = await checkBalance(entry, undefined, exec.signal);
            }
            results.push({ id: entry.id, name: entry.name, estimated, remote });
          }
          return { results, note: 'OpenCode Go official (pure API key): GET https://opencode.ai/zen/go/v1/usage returns rolling/weekly/monthly percent + resetsAt; percent × limit = used USD (e.g. 8% of $12 = $0.96). console.opencode.ai /api/v1/usage/export?scope=service_account&range=24h (API key) returns CSV rows with costMicroCents; /api/usage/summary and /api/billing/balance/summary need the console org token. Local estimated windows are usage tokens × model price from responses.' };
        },
      },
      {
        name: 'llm_pool_route',
        description: 'Predict which pool entry would serve a model today, i.e. the hot-switch decision without sending a request. Candidates are sorted by effective usage score — least-used wins; errors penalize; cooling and exhausted (>=100% of any limit window) entries sink to the end. Returns scores, cooling flags, and limit pressure.',
        parameters: {
          model: { type: 'string', description: 'Model name, e.g. deepseek-chat.', required: true },
          count: { type: 'integer', description: 'Optional number of candidates to return (default all).' },
          withScores: { type: 'boolean', description: 'Include the raw score per candidate (default true).' },
        },
        async execute(args, exec) {
          const model = String(args.model);
          const candidates = candidatesFor(model);
          const list = candidates.map((c) => ({
            id: c.entry.id,
            name: c.entry.name,
            baseUrl: c.entry.baseUrl,
            score: args.withScores === false ? undefined : c.score,
            cooling: !!(c.entry.cooldownUntil && c.entry.cooldownUntil > Date.now()),
            limits: limitsStatus(c.entry),
          }));
          const sliced = args.count && args.count > 0 ? list.slice(0, args.count) : list;
          return { model, chosen: sliced.length > 0 ? sliced[0].id : null, candidates: sliced };
        },
      },
      {
        name: 'llm_pool_chat',
        description: 'Send a chat/completions request through the pool with usage-based hot-switching: candidates for the model are tried in least-usage order; on failure (429/5xx/timeout/transport) that entry is cooled for 60s and the next candidate is tried. Successful responses are recorded into the usage ledger with token counts and, when a cost table exists, a USD estimate for triple-limit tracking. Use exact model ids discovered by llm_pool_probe.',
        parameters: {
          model: { type: 'string', description: 'Model id as probed (e.g. deepseek-chat).', required: true },
          messages: { type: 'array', items: { type: 'json' }, description: 'OpenAI chat messages: [{role, content}, ...].', required: true },
          temperature: { type: 'number', description: 'Sampling temperature.' },
          max_tokens: { type: 'integer', description: 'Max completion tokens.' },
          top_p: { type: 'number', description: 'Nucleus sampling p.' },
          extra: { type: 'object', additionalProperties: true, description: 'Optional extra body fields merged into the request (e.g. {stream:false, response_format:{...}}).' },
        },
        async execute(args, exec) {
          const model = String(args.model);
          const messages = args.messages;
          if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must be a non-empty array');
          const chatArgs = {
            temperature: args.temperature,
            max_tokens: args.max_tokens,
            top_p: args.top_p,
            extra: args.extra,
          };
          return await chatThrough(model, messages, chatArgs, exec.signal);
        },
      },
      {
        name: 'llm_pool_balance',
        description: 'Query provider-side usage/balance. For OpenCode entries, first tries the official console.opencode.ai routes (/api/v1/usage/export?scope=service_account&range=24h with the API key bearer, then /api/usage/summary and /api/billing/balance/summary with the org token). For others, tries the entry-specific usagePath first, else common endpoints (/user/balance, /api/v1/auth/key, /v1/usage, /dashboard/billing/usage) and returns whichever answers 200. With id, only that entry; without, all enabled entries. When no endpoint answers, falls back to the local estimated triple-limit status.',
        parameters: {
          id: { type: 'string', description: 'Optional entry id.' },
          endpoint: { type: 'string', description: 'Optional endpoint path override (must start with /).' },
        },
        async execute(args, exec) {
          const endpoint = args.endpoint ? safeUrl(args.endpoint, true) : undefined;
          const targets = state.entries.filter((e) => e.enabled && (!args.id || e.id === String(args.id)));
          const results = [];
          for (const entry of targets) results.push(await checkBalance(entry, endpoint, exec.signal));
          return { results };
        },
      },
    ];

    function normalizeLimits(limits) {
      const l = limits || {};
      return {
        h5Usd: Number(l.h5Usd) || 0,
        weekUsd: Number(l.weekUsd) || 0,
        monthUsd: Number(l.monthUsd) || 0,
      };
    }

    for (const t of tools) {
      const def = harness.defineTool({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output,
        execute: t.execute,
      });
      harness.registerTool(ctx, def);
    }

    // ---- RPC face for the settings page ----
    function byId(id) { return state.entries.find((e) => e.id === String(id)); }
    harness.handle('llmPool.list', async () => ({ pool: summaryView(), path: poolPath, version: state.version }));
    harness.handle('llmPool.add', async (args) => {
      if (!args || typeof args !== 'object') return { ok: false, error: 'args object required' };
      const apiKey = String(args.apiKey || '').trim();
      if (!apiKey) return { ok: false, error: 'apiKey required' };
      try {
        let baseUrl = args.baseUrl ? safeUrl(String(args.baseUrl)) : undefined;
        if (args.preset === 'opencode-go') { baseUrl = OPENCODE_GO_BASE; }
        if (!baseUrl) return { ok: false, error: 'baseUrl required' };
        const alias = args.name ? String(args.name).trim() : null;
        const existed = !!state.entries.find((e) => e.baseUrl === baseUrl && e.apiKey === apiKey);
        let entry = state.entries.find((e) => e.baseUrl === baseUrl && e.apiKey === apiKey);
        if (entry) {
          if (alias) entry.name = alias;
          if (args.enabled !== undefined) entry.enabled = !!args.enabled;
          if (args.usagePath !== undefined) entry.usagePath = safeUrl(String(args.usagePath), true);
          if (args.limits) entry.limits = normalizeLimits(args.limits);
          if (args.preset === 'opencode-go') { entry.costs = OPENCODE_GO_COSTS; entry.limits = OPENCODE_GO_LIMITS; }
        } else {
          entry = {
            id: nextEntryId(), name: alias, baseUrl, apiKey,
            enabled: args.enabled === undefined ? true : !!args.enabled,
            models: [], usage: { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 },
            modelUsage: {}, usageLog: [],
          };
          if (args.usagePath !== undefined) entry.usagePath = safeUrl(String(args.usagePath), true);
          if (args.limits) entry.limits = normalizeLimits(args.limits);
          if (args.preset === 'opencode-go') { entry.costs = OPENCODE_GO_COSTS; entry.limits = OPENCODE_GO_LIMITS; }
          state.entries.push(entry);
        }
        await persist();
        const probe = await probeEntry(entry, undefined);
        await persist();
        return { ok: true, id: entry.id, existed, probe, limits: entry.limits };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    });
    harness.handle('llmPool.update', async (args) => {
      const entry = args && byId(args.id);
      if (!entry) return { ok: false, error: 'entry not found' };
      if (args.enabled !== undefined) entry.enabled = !!args.enabled;
      if (args.name) entry.name = String(args.name);
      if (args.apiKey) entry.apiKey = String(args.apiKey);
      if (args.limits) entry.limits = normalizeLimits(args.limits);
      await persist();
      return { ok: true, id: entry.id };
    });
    harness.handle('llmPool.remove', async (args) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((e) => e.id !== String(args && args.id));
      await persist();
      return { removed: state.entries.length < before, remaining: state.entries.length };
    });
    harness.handle('llmPool.probe', async (args) => {
      const entry = args && byId(args.id);
      if (!entry) return { ok: false, error: 'entry not found' };
      const probe = await probeEntry(entry, undefined);
      await persist();
      return { ok: true, ...probe };
    });
    harness.handle('llmPool.usage', async (args) => {
      const rows = state.entries.filter((e) => !args || !args.id || e.id === String(args.id)).map((e) => ({
        id: e.id, name: e.name, usage: e.usage, limits: limitsStatus(e),
      }));
      return { rows };
    });
    harness.handle('llmPool.limits', async (args) => {
      const targets = state.entries.filter((e) => !args || !args.id || e.id === String(args.id));
      const results = [];
      for (const entry of targets) {
        const estimated = limitsStatus(entry);
        let remote = null;
        if (args && args.refresh && (entry.usagePath || entry.baseUrl.indexOf('opencode.ai') !== -1)) {
          remote = await checkBalance(entry, undefined, undefined);
        }
        results.push({ id: entry.id, name: entry.name, estimated, remote });
      }
      return { results };
    });
    harness.handle('llmPool.route', async (args) => {
      const model = String(args && args.model || '');
      if (!model) return { ok: false, error: 'model required' };
      const candidates = candidatesFor(model);
      const list = candidates.map((c) => ({
        id: c.entry.id, name: c.entry.name, baseUrl: c.entry.baseUrl, score: c.score,
        cooling: !!(c.entry.cooldownUntil && c.entry.cooldownUntil > Date.now()),
        limits: limitsStatus(c.entry),
      }));
      return { model, chosen: list.length > 0 ? list[0].id : null, candidates: list };
    });
    harness.handle('llmPool.chat', async (args) => {
      if (!args || typeof args !== 'object') return { ok: false, error: 'args object required' };
      return await chatThrough(String(args.model || ''), Array.isArray(args.messages) ? args.messages : [], args, undefined);
    });
    harness.handle('llmPool.balance', async (args) => {
      const entry = args && byId(args.id);
      if (!entry) return { ok: false, error: 'entry not found' };
      const result = await checkBalance(entry, args.endpoint ? safeUrl(String(args.endpoint), true) : undefined, undefined);
      return { ok: true, result };
    });

    await load();
    console.log('[llm-pool] ready (v2): ' + state.entries.length + ' entries at ' + poolPath);

  // ---- JSON API bridge: settings page calls /llm-pool/api/<method> ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/llm-pool/api',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const m = /^\/llm-pool\/api\/([a-z]+)$/.exec(pathname);
      const method = m ? m[1] : null;
      const fn = method ? allHandlers['llmPool.' + method] : null;
      if (!fn || req.method !== 'POST') {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      let args = {};
      try {
        const text = await readBody(req);
        if (text) args = JSON.parse(text);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      try {
        sendJson(res, 200, await fn(args));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
      }
    }
  }), 'dsh-llm-api-pool: /llm-pool/api routes');

  // ---- OpenAI-compatible provider endpoints: the pool AS a provider ----
  // POST /llm-pool/v1/chat/completions  — OpenAI chat input -> pool routing ->
  //    OpenAI chat output (SSE when stream:true). Point any consumer's baseUrl
  //    at http://127.0.0.1:<webPort>/llm-pool/v1 (apiKey ignored/any) and all
  //    model traffic transparently enjoys balance-driven hot-switching.
  // GET  /llm-pool/v1/models             — union of probed models across entries.
  function openaiError(message, type) {
    return { error: { message: String(message), type: type || 'pool_error', code: 'llm_pool' } };
  }
  function entryModels() {
    const seen = new Set();
    for (const e of state.entries) {
      for (const m of (e.models || [])) if (!seen.has(m)) seen.add(m);
    }
    return Array.from(seen);
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/llm-pool/v1',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      if (req.method === 'GET' && pathname === '/llm-pool/v1/models') {
        sendJson(res, 200, {
          object: 'list',
          data: entryModels().map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'dsh-llm-api-pool' })),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/llm-pool/v1/chat/completions') {
        let body = {};
        try {
          const text = await readBody(req);
          if (text) body = JSON.parse(text);
        } catch {
          sendJson(res, 400, openaiError('invalid JSON body', 'invalid_request_error'));
          return;
        }
        const model = String(body.model || '');
        const messages = body.messages;
        if (!model || !Array.isArray(messages) || messages.length === 0) {
          sendJson(res, 400, openaiError('model and non-empty messages are required', 'invalid_request_error'));
          return;
        }
        const stream = body.stream === true;
        const chatArgs = {
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          top_p: body.top_p,
          stream: stream ? false : undefined,
          extra: body.extra,
        };
        try {
          const r = await chatThrough(model, messages, chatArgs, undefined);
          if (!r.ok) {
            sendJson(res, 502, openaiError(
              r.error === 'no-api-covers-model'
                ? 'none of the pool entries covers model "' + model + '" (probe first, or add an entry)'
                : (r.error || 'all-api-failed'),
              'pool_unavailable'
            ));
            return;
          }
          const content = r.responded && Array.isArray(r.responded.choices) && r.responded.choices[0]
            ? (r.responded.choices[0].message ? r.responded.choices[0].message.content : String(r.responded.choices[0].text || ''))
            : (typeof r.responded === 'string' ? r.responded : JSON.stringify(r.responded));
          const created = Math.floor(Date.now() / 1000);
          const id = 'chatcmpl-pool-' + Math.random().toString(36).slice(2, 10);
          const usage = {
            prompt_tokens: (r.usage && r.usage.promptTokens) || 0,
            completion_tokens: (r.usage && r.usage.completionTokens) || 0,
            total_tokens: ((r.usage && r.usage.promptTokens) || 0) + ((r.usage && r.usage.completionTokens) || 0),
          };
          const choice = {
            index: 0,
            message: { role: 'assistant', content: String(content ?? '') },
            finish_reason: 'stop',
          };
          if (stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: String(content ?? '') }, finish_reason: null }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          sendJson(res, 200, { id, object: 'chat.completion', created, model, choices: [choice], usage, pool: { api: r.api, tried: r.tried } });
        } catch (err) {
          sendJson(res, 500, openaiError(String(err && err.message || err), 'pool_error'));
        }
        return;
      }
      sendJson(res, 404, openaiError('not found', 'invalid_request_error'));
    }
  }), 'dsh-llm-api-pool: /llm-pool/v1 OpenAI provider routes');

  // ---- DSH native provider: the pool as a selectable model provider ----
  // Registers a provider route with the llm service so the Model picker surfaces
  // the pool-union models and any selection routes through chatThrough
  // (balance-driven hot switching, per-key cooldown, official usage pressure).
  // Zero user configuration: baseURL and apiKey live in the pool file, not in
  // model settings.
  function flatText(blocks) {
    return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  function serializePoolMessages(options) {
    const wire = [];
    if (options.system) wire.push({ role: 'system', content: String(options.system) });
    for (const message of options.messages || []) {
      const blocks = message.content || [];
      if (message.role === 'assistant') {
        const text = flatText(blocks);
        const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
        const toolCalls = blocks.filter((b) => b.type === 'tool-call').map((b) => ({
          id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
        }));
        wire.push({ role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      } else if (message.role === 'user') {
        const toolResults = blocks.filter((b) => b.type === 'tool-result');
        const text = flatText(blocks);
        if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
        for (const result of toolResults) wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flatText(result.content) || '(no output)' });
      } else if (message.role === 'system') {
        wire.push({ role: 'system', content: flatText(blocks) });
      }
    }
    return wire;
  }
  function poolStreamError(message, code) {
    const failure = Object.freeze({ message: String(message), code: String(code) });
    const error = new Error(String(message));
    try { Object.defineProperty(error, 'failure', { value: failure, enumerable: false }); error.code = code; } catch { /* best effort */ }
    return error;
  }
  function poolFinishReason(reason, empty) {
    switch (reason) {
      case 'stop':
        if (empty) return { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } };
        return { kind: 'stop' };
      case 'tool_calls': return { kind: 'tool-calls' };
      case 'length': return { kind: 'max-tokens' };
      default: return { kind: 'error', failure: { message: 'model stopped: ' + String(reason), code: String(reason || 'unknown').toUpperCase() } };
    }
  }
  const poolAdapter = {
    providerInfo: (provider) => ({ id: provider, name: 'LLM API Pool (余额热切换)' }),
    providerRetryPolicy: () => undefined,
    async listModels(provider) {
      return entryModels().map((id) => ({ provider: String(provider), id, name: id }));
    },
    async resolveModel(provider, model) {
      return {
        provider: String(provider),
        id: String(model),
        name: String(model),
        reasoning: { efforts: POOL_REASONING_EFFORTS },
      };
    },
    async *stream(options) {
      const extra = {};
      if (options.tools && options.tools.length) extra.tools = options.tools.map((t) => ({ type: 'function', function: t }));
      if (options.reasoningEffort) extra.reasoning_effort = String(options.reasoningEffort);
      const chatArgs = {
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        ...(Object.keys(extra).length ? { extra } : {}),
      };
      const r = await chatThrough(options.model, serializePoolMessages(options), chatArgs, options.signal);
      if (!r.ok) {
        throw poolStreamError(
          r.error === 'no-api-covers-model'
            ? 'pool has no entry covering model "' + options.model + '"; probe or add an entry first'
            : ('all pool entries failed for model "' + options.model + '"'),
          r.error === 'no-api-covers-model' ? 'NO_API_COVERS_MODEL' : 'POOL_UNAVAILABLE'
        );
      }
      const parsed = r.responded && typeof r.responded === 'object' ? r.responded : null;
      const choice = parsed && Array.isArray(parsed.choices) && parsed.choices[0] ? parsed.choices[0] : null;
      const message = choice && choice.message ? choice.message : {};
      const content = typeof message.content === 'string' ? message.content : '';
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      let index = 0;
      if (reasoning.length > 0) {
        yield { type: 'block-start', index, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index, text: reasoning };
        yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } };
        index += 1;
      }
      if (content.length > 0 || toolCalls.length === 0) {
        yield { type: 'block-start', index, blockType: 'text' };
        if (content.length > 0) yield { type: 'text-delta', index, text: content };
        yield { type: 'block-end', index, block: { type: 'text', text: content } };
        index += 1;
      }
      for (const call of toolCalls) {
        const fn = call.function || {};
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
        const id = String(call.id || 'call-' + index);
        const name = typeof fn.name === 'string' ? fn.name : '';
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args };
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } };
        index += 1;
      }
      if (parsed && parsed.usage && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens)) {
        yield { type: 'usage', usage: { inputTokens: parsed.usage.prompt_tokens || 0, outputTokens: parsed.usage.completion_tokens || 0 } };
      } else if (r.usage && (r.usage.promptTokens || r.usage.completionTokens)) {
        yield { type: 'usage', usage: { inputTokens: r.usage.promptTokens || 0, outputTokens: r.usage.completionTokens || 0 } };
      }
      yield { type: 'finish', reason: poolFinishReason(choice && choice.finish_reason, content.length === 0 && reasoning.length === 0 && toolCalls.length === 0) };
    },
  };
  try {
    const llm = ctx.get('llm');
    if (llm && typeof llm.registerAdapter === 'function') {
      llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'LLM API Pool (余额热切换)', settingsNs: NS, settingsPath: [] }]);
      llm.registerAdapter([PROVIDER], poolAdapter);
      if (typeof llm.registerModelDiscovery === 'function') {
        llm.registerModelDiscovery(NS, async () => entryModels().map((id) => ({ id, name: id })));
      }
    }
  } catch (err) {
    console.error('[dsh-llm-api-pool] provider registration skipped: ' + (err && err.message || err));
  }
  try {
    const settingsService = ctx.get('settings');
    const poolSettingsSchema = typeof z !== 'undefined' && z && typeof z.object === 'function' ? z.object({}) : null;
    if (settingsService && typeof settingsService.register === 'function' && poolSettingsSchema) {
      // 零配置段:模型设置页把该 provider 显示为已就绪,没有任何需要填写的字段。
      settingsService.register(NS, poolSettingsSchema, { base: {} });
    }
  } catch { /* non-fatal */ }

  await load();
  console.log('[dsh-llm-api-pool] ready v' + VERSION + ': ' + state.entries.length + ' entries at ' + poolPath);
}

export { apply, inject, name, VERSION };
