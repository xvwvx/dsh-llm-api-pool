window.__ModuleLoader__.load({
  id: "dsh-llm-api-pool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    // clang-format off
    //#region llm-api-pool client half
    /**
     * Client half of dsh-llm-api-pool: the "LLM API 池" settings page.
     *
     * Registers one occupant of the additive settings.section list slot; the
     * page renders every pool entry as a card (masked key, probed models,
     * triple-limit bars) and talks to the host half exclusively through
     * POST /llm-pool/api/<method> JSON routes (no host.call RPC — this is the
     * static bundle form; the dynamic runner's host.call face does not exist
     * here).
     *
     * Official usage: clicking 刷新限额/查询余额 calls host balance (gateway
     * /usage with the pure API key) and the returned windows are rendered as
     * [官方] rows with percent/USD/reset time; without a refresh the cards
     * show the local-estimate fallback.
     */

    const inject = ["slots"];

    const PLUGIN = "dsh-llm-api-pool";
    const VERSION = "0.1.7";

    // ---- tiny fetch bridge to the host JSON API ----
    function callHost(method, args) {
      return fetch("/llm-pool/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args || {})
      }).then((res) => {
        if (!res.ok) return res.json().then((j) => Promise.reject(new Error((j && j.error) || ("HTTP " + res.status))));
        return res.json();
      });
    }

    // ---- styles injected as a plain <style> tag (static bundle: no styles.insert face) ----
    function insertStyles(css) {
      if (typeof document === "undefined") return () => {};
      const tagId = PLUGIN + "/styles";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => { try { if (tag.parentNode) tag.parentNode.removeChild(tag); } catch {} };
    }

    const CSS =
      ".lp-root{display:flex;flex-direction:column;gap:14px;padding:2px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}" +
      ".lp-head{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
      ".lp-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}" +
      ".lp-btn:hover{border-color:var(--dsw-alias-brand-primary)}" +
      ".lp-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".lp-msg{padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-all}" +
      ".lp-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}" +
      ".lp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".lp-name{font-weight:600}" +
      ".lp-muted{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".lp-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}" +
      ".lp-chip{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}" +
      ".lp-limits{display:flex;flex-direction:column;gap:5px}" +
      ".lp-limit{display:grid;grid-template-columns:70px 1fr 200px;align-items:center;gap:8px;font-size:12px}" +
      ".lp-bar{height:8px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}" +
      ".lp-fill{height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary)}" +
      ".lp-fill.warn{background:var(--dsw-alias-state-warn-primary)}" +
      ".lp-fill.exh{background:var(--dsw-alias-state-error-primary)}" +
      ".lp-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}" +
      ".lp-field{display:flex;flex-direction:column;gap:3px}" +
      ".lp-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}" +
      ".lp-field input,.lp-field select{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:12px}" +
      ".lp-field.full{grid-column:1 / -1}" +
      ".lp-hint{font-size:11px;color:var(--dsw-alias-state-warn-primary)}";

    function PoolSettings() {
      const [pool, setPool] = react.useState(null);
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState("");
      const [formOpen, setFormOpen] = react.useState(false);
      const [form, setForm] = react.useState({ preset: "", baseUrl: "", apiKey: "", usagePath: "", h5Usd: "12", weekUsd: "30", monthUsd: "60" });
      const [removeArmed, setRemoveArmed] = react.useState(null);
      const [routeModel, setRouteModel] = react.useState("");
      const [routeResult, setRouteResult] = react.useState(null);
      const [remoteMap, setRemoteMap] = react.useState({});

      const refresh = react.useCallback(() => {
        return callHost("list", {}).then(
          (r) => { setPool(r); return r; },
          (e) => { setMsg("加载失败: " + String(e && e.message || e)); }
        );
      }, []);
      react.useEffect(() => { refresh(); }, [refresh]);

      const markRemote = (entryId, res) => {
        setRemoteMap((m) => Object.assign({}, m, { [entryId]: { windows: res.windows || null, source: res.source || null, fetchedAt: new Date().toLocaleTimeString() } }));
      };

      const run = (label, p) => {
        setBusy(label);
        setMsg("");
        return Promise.resolve(p).then(
          (r) => { if (r && r.msg) setMsg(String(r.msg)); refresh(); },
          (e) => setMsg(label + " 失败: " + String(e && e.message || e))
        ).finally(() => setBusy(""));
      };

      const applyPreset = (presetName) => {
        if (presetName === "opencode-go") {
          setForm({ preset: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "", usagePath: "", h5Usd: "12", weekUsd: "30", monthUsd: "60" });
        } else {
          setForm({ preset: "", baseUrl: "", apiKey: "", usagePath: "", h5Usd: "12", weekUsd: "30", monthUsd: "60" });
        }
      };
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));

      const submitAdd = () => {
        const payload = {
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          limits: { h5Usd: Number(form.h5Usd) || 0, weekUsd: Number(form.weekUsd) || 0, monthUsd: Number(form.monthUsd) || 0 },
          probe: true
        };
        if (form.usagePath.trim()) payload.usagePath = form.usagePath.trim();
        if (form.preset === "opencode-go") payload.preset = "opencode-go";
        run("添加", callHost("add", payload).then((r) => { setFormOpen(false); setForm({ preset: "", baseUrl: "", apiKey: "", usagePath: "", h5Usd: "12", weekUsd: "30", monthUsd: "60" }); if (r && r.existed) return { msg: "该 API key 已存在,配置已更新(id=" + String(r.id) + ")" }; return r; }));
      };

      const toggleEntry = (entry) => run("切换", callHost("update", { id: entry.id, enabled: !entry.enabled }));
      const probeEntry = (entry) => run("探查", callHost("probe", { id: entry.id }));
      const balanceEntry = (entry) => run("余额", callHost("balance", { id: entry.id }).then((r) => {
        if (r && r.ok && r.result) {
          const res = r.result;
          if (res.ok && res.windows) {
            markRemote(entry.id, res);
            const p = (w) => (w && typeof w.percent === "number" ? w.percent + "%" : "?");
            return { msg: "官方 " + (res.source || "") + ": 5h " + p(res.windows.rolling) + " · 周 " + p(res.windows.weekly) + " · 月 " + p(res.windows.monthly) };
          }
          return { msg: "官方端点不可达: " + String(res.error || "unknown") };
        }
        return r;
      }));
      const limitsEntry = (entry) => run("限额", callHost("limits", { id: entry.id, refresh: true }).then((r) => {
        const row = r && r.results && r.results[0];
        const remote = row && row.remote;
        if (remote && remote.ok && remote.windows) {
          markRemote(entry.id, remote);
          return { msg: "官方 " + (remote.source || "") + " 限额已更新,重置时刻见卡片" };
        }
        if (remote) return { msg: "官方端点不可达,回退本地估算: " + String(remote.error || "") };
        return r;
      }));
      const removeEntry = (entry) => {
        if (removeArmed !== entry.id) { setRemoveArmed(entry.id); return; }
        setRemoveArmed(null);
        run("删除", callHost("remove", { id: entry.id }));
      };
      const doRoute = () => {
        if (!routeModel.trim()) return;
        setRouteResult("...");
        callHost("route", { model: routeModel.trim() }).then(
          (r) => setRouteResult(r),
          (e) => setRouteResult(String(e && e.message || e))
        );
      };

      const entries = pool && pool.pool ? pool.pool : [];
      const elems = [
        react.createElement("div", { key: "head", className: "lp-head" },
          react.createElement("span", { className: "lp-name" }, "LLM API 池" + (pool ? " (" + entries.length + ")" : "")),
          react.createElement("button", { className: "lp-btn", disabled: !!busy, onClick: () => setFormOpen(!formOpen) }, formOpen ? "收起表单" : "+ 添加 API"))
      ];
      if (msg) elems.push(react.createElement("div", { key: "msg", className: "lp-msg" }, String(msg)));
      if (busy) elems.push(react.createElement("div", { key: "busy", className: "lp-msg" }, busy + " …"));
      if (Object.keys(remoteMap).length === 0 && !busy) {
        elems.push(react.createElement("div", { key: "hint", className: "lp-hint" }, "提示:点击卡片上的「刷新限额 / 查询余额」会调用官方 /usage 端点(纯 API Key),百分比与美元即服务端实时数值;未点击时显示本地估算。"));
      }

      if (formOpen) {
        elems.push(react.createElement("div", { key: "form", className: "lp-form" },
          react.createElement("div", { className: "lp-field full" }, react.createElement("label", null, "预设"), react.createElement("select", { value: form.preset, onChange: (e) => applyPreset(e.target.value) },
            react.createElement("option", { value: "" }, "自定义"),
            react.createElement("option", { value: "opencode-go" }, "OpenCode Go (zen/go/v1, 5h $12 / 周 $30 / 月 $60)")
          )),
          react.createElement("div", { className: "lp-field" }, react.createElement("label", null, "baseUrl *"), react.createElement("input", { value: form.baseUrl, onChange: (e) => setField("baseUrl", e.target.value), placeholder: "https://api.deepseek.com" })),
          react.createElement("div", { className: "lp-field full" }, react.createElement("label", null, "apiKey *"), react.createElement("input", { value: form.apiKey, onChange: (e) => setField("apiKey", e.target.value), placeholder: "sk-…", type: "password" })),
          react.createElement("div", { className: "lp-field" }, react.createElement("label", null, "5h 限额 (USD)"), react.createElement("input", { value: form.h5Usd, onChange: (e) => setField("h5Usd", e.target.value) })),
          react.createElement("div", { className: "lp-field" }, react.createElement("label", null, "周限额 (USD)"), react.createElement("input", { value: form.weekUsd, onChange: (e) => setField("weekUsd", e.target.value) })),
          react.createElement("div", { className: "lp-field" }, react.createElement("label", null, "月限额 (USD)"), react.createElement("input", { value: form.monthUsd, onChange: (e) => setField("monthUsd", e.target.value) })),
          react.createElement("div", { className: "lp-field" }, react.createElement("label", null, "usagePath (可选)"), react.createElement("input", { value: form.usagePath, onChange: (e) => setField("usagePath", e.target.value), placeholder: "/user/balance" })),
          react.createElement("div", { className: "lp-field full" },
            react.createElement("button", { className: "lp-btn", disabled: !!busy || !form.baseUrl.trim() || !form.apiKey.trim(), onClick: submitAdd }, "添加并自动探查模型")
          )
        ));
      }

      for (const entry of entries) {
        const remote = remoteMap[entry.id] || null;
        const rw = (remote && remote.windows) || null;
        // Normalize official window keys (rolling/weekly/monthly) to card keys (h5/week/month)
        const limits = (rw ? { h5: rw.rolling || null, week: rw.weekly || null, month: rw.monthly || null } : null) || entry.limitsStatus || null;
        const official = !!rw;
        const limElems = [];
        if (limits && (limits.h5 || limits.week || limits.month)) {
          const rows = [
            ["5h", limits.h5], ["周", limits.week], ["月", limits.month]
          ];
          limElems.push(react.createElement("div", { key: "lim", className: "lp-limits" }, rows.map((r) => {
            const st = r[1];
            if (!st || !st.capUsd) return react.createElement("div", { key: r[0], className: "lp-limit" }, react.createElement("span", null, r[0]), react.createElement("span", { className: "lp-muted" }, "未设上限"));
            const pctRaw = typeof st.percent === "number" ? st.percent : Math.min(100, Math.round((st.usedUsd || 0) / st.capUsd * 100));
            const pct = Math.min(100, Math.max(0, pctRaw));
            const fillCls = pct >= 100 ? "lp-fill exh" : pct >= 80 ? "lp-fill warn" : "lp-fill";
            const reset = official && st.resetsAt ? " · 重置 " + new Date(st.resetsAt).toLocaleTimeString() : "";
            return react.createElement("div", { key: r[0], className: "lp-limit" },
              react.createElement("span", null, r[0]),
              react.createElement("div", { className: "lp-bar" }, react.createElement("div", { className: fillCls, style: { width: pct + "%" } })),
              react.createElement("span", { className: "lp-mono" }, (official ? "[官方] " : "[估算] ") + "$" + (st.usedUsd || 0).toFixed(2) + " / $" + st.capUsd + " (" + pct + "%)" + reset));
          })));
          if (official) {
            limElems.push(react.createElement("div", { key: "src", className: "lp-muted" }, "来源 " + (remote.source || "") + " · 查询于 " + (remote.fetchedAt || "")));
          }
        } else {
          limElems.push(react.createElement("div", { key: "lim", className: "lp-muted" }, "未配置限额"));
        }
        const chips = (entry.models || []).slice(0, 12).map((m) => react.createElement("span", { key: m, className: "lp-chip" }, m));
        const usage = entry.usage || {};
        elems.push(react.createElement("div", { key: entry.id, className: "lp-card" },
          react.createElement("div", { className: "lp-row" },
            react.createElement("span", { className: "lp-name" }, entry.name || entry.apiKey),
            react.createElement("label", { className: "lp-muted", style: { display: "flex", alignItems: "center", gap: 4 } },
              react.createElement("input", { type: "checkbox", checked: !!entry.enabled, onChange: () => toggleEntry(entry) }), "启用"),
            entry.cooling ? react.createElement("span", { className: "lp-chip", style: { color: "var(--dsw-alias-state-error-primary)" } }, "冷却中") : null
          ),
          react.createElement("div", { className: "lp-muted lp-mono" }, entry.baseUrl + "  " + entry.apiKey),
          chips.length > 0 ? react.createElement("div", { className: "lp-row" }, chips) : react.createElement("div", { className: "lp-muted" }, "未探查模型"),
          limElems,
          react.createElement("div", { className: "lp-muted" },
            "请求 " + (usage.requests || 0) + " · 输入 " + (usage.promptTokens || 0) + " tok · 输出 " + (usage.completionTokens || 0) + " tok · 错误 " + (usage.errors || 0)
          ),
          react.createElement("div", { className: "lp-row" },
            react.createElement("button", { className: "lp-btn", disabled: !!busy, onClick: () => probeEntry(entry) }, "探查模型"),
            react.createElement("button", { className: "lp-btn", disabled: !!busy, onClick: () => limitsEntry(entry) }, "刷新限额"),
            react.createElement("button", { className: "lp-btn", disabled: !!busy, onClick: () => balanceEntry(entry) }, "查询余额"),
            react.createElement("button", { className: "lp-btn danger", disabled: !!busy, onClick: () => removeEntry(entry) }, removeArmed === entry.id ? "确认删除?" : "删除")
          )
        ));
      }

      elems.push(react.createElement("div", { key: "route", className: "lp-card" },
        react.createElement("div", { className: "lp-name" }, "路由预览"),
        react.createElement("div", { className: "lp-row" },
          react.createElement("input", { value: routeModel, onChange: (e) => setRouteModel(e.target.value), placeholder: "deepseek-chat", style: { flex: 1, background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-primary)", borderRadius: 6, padding: "5px 8px" } }),
          react.createElement("button", { className: "lp-btn", onClick: doRoute }, "预测")
        ),
        routeResult ? react.createElement("div", { className: "lp-msg" }, typeof routeResult === "string" ? routeResult : JSON.stringify(routeResult, null, 2)) : null
      ));

      return react.createElement("div", { className: "lp-root" }, elems);
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const disposeStyles = insertStyles(CSS);
      ctx.effect(() => disposeStyles);
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "llm-pool", order: 12, label: () => "LLM API 池" },
        PoolSettings
      ));
    }
    //#endregion
    // clang-format on
    module.exports = { inject, apply, PLUGIN, VERSION };
    return module.exports;
  }
});