# Phase 3 状态面板 — 证据（client 插件 + 自定义 HTTP 路由）

- 日期：2026-10-03
- 分支：`develop`
- 模块：`lib/panel.js`（Host 侧路由）+ `client.js`（浏览器半）+ `lib/index.js` 装配 + `package.json`（`dsh.client`/`exports`/`files`）
- 意图：`dsh web` 会话 composer 上方出现一条面板，实时显示角色状态（读 `state.json`）。

## 为什么走自定义路由

浏览器**读不到** `DSH_HOME` 文件；本项目状态是 **host 文件派生**（读 `state.json` / `*.jsonl`），不是日志派生 → dsh 的 projection 机制不适用。故注册本机 HTTP 路由把状态与账本投影成 JSON（两条）：

- `/lepimemory/state`：当前状态；`/lepimemory/history?kind=&limit=&offset=`：历史账本分页。均 `webServer.register({ kind:'exact', path, handler:(req,res)=>… })`，返回 disposer（`ctx.effect` 包裹）。
- **信任栅栏**：自定义路由在 dsh 的 `/api/*` 栅栏之外，故**自行校验** Host/Origin 是本机 loopback（否则 `403`）。
- 响应：`{ ok:true, rendered: renderState(state), mood, relation, updatedAt }`；读失败 → `{ ok:false, error }`（200）。

## 关键实现点

1. **`webServer` 就绪时机**：插件 `apply` 时 `webServer` 通常**尚未就绪**（`ctx.get('webServer')` 为 `undefined`）→ 路由静默不注册。
   处置：用 **`ctx.inject(['webServer'], scope => …)`** 延迟到服务可用再注册。
   （首次实测用 `ctx.get` 即踩此坑：`GET /lepimemory/state` → 404。改用 `ctx.inject` 后 200。）
2. **client 半（手写 lazy-CJS）**：照 harness 夹具 `apps/web/tests/fixtures/plugins/fixture-live-client/client.js`：

```js
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-lepimemory-state',          // = 包名（client-modules 以包名作 boot 行 id）
  factory(require) {
    const React = require('react')                    // 只能 require 平台 seed
    return { inject:['slots','locale'], apply(ctx) {
      ctx.effect(() => ctx.locale.register('lepimemoryState', { zh:{…}, en:{…} }))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name:'conversation.input.dock', id:'lepimemory-state', order:5, locale:'lepimemoryState' }, Panel))
    } } },
})
```

   `Panel` 每 5s `fetch('/lepimemory/state')`；渲染 `s.rendered` + 一行 `心境 v/a · 信任 t · updatedAt`。
3. **`package.json`**：`exports["./client"]`；`dsh.client = { platform:'web', inject:[ui-renderer, ui-conversation, ui-session, locale] }`；`files` 加 `client.js`。
   （依据 `docs/subsystems/client-modules.md`：声明 `dsh.client` + `exports['./client']` 即入 boot 表；`inject` 是**包名依赖边**。）

## 实测（web `lepimemory` profile）

1. **结构**：`GET /lepimemory/state` → `{"ok":true,"rendered":"【内部状态…】\n- 与基线相比无明显偏移。","mood":{…},"relation":{…},"updatedAt":…}`。
2. **面板可见**：composer 上方出现面板；状态变化后**自动刷新**（如行动成功后显示「心境: 比平常略轻快 / 原因: 刚刚帮你把事办成了。」，熟悉度累积后显示「对用户: 比平常略熟悉」）。
3. **服务端 boot**：index HTML 的 `__DSH_BOOT__` 含 `dsh-lepimemory-state` 行（`dsh.client` 扫描成功）。
4. **信任栅栏**：`GET /lepimemory/state`（`Host: evil.example.com`）→ **403**。
5. **降级**：补丁层 `config.panel.enabled=false` → 重启后 `GET /lepimemory/state` → **404**（无路由），面板显示 **「State unavailable」**，无报错。

## 历史分页（`/lepimemory/history`，2026-10-03）

- **白名单**：`kind ∈ {audit, recall, retain, forget, action}` → 固定文件名（白名单即防路径穿越；未知 kind → **400**）。
- **参数**：`limit`（默认 10，钳 1..100）、`offset`（默认 0）；**最新在前**（读文件后反转）；坏行跳过（一行脏数据不毁整页）。
- **服务端出摘要**：每条返回 `{ at, summary, raw }`——摘要按 kind 生成（audit：`命中 <规则> · <维度 前→后>`；recall：`「<query>」候选 N · 入选 M`；retain：`写入「…」`/`跳过（原因）`；forget：`遗忘/恢复「…」 executed/planned`；action：`写便条《…》→ path`），前端只排版。
- **信任栅栏**：同 `/lepimemory/state`（本机 loopback，否则 403）。
- **前端**：面板「▸ History」可折叠；kind 标签页（审计/召回/写入/遗忘/行动）；列表 + `上一页/下一页` + `第 p/q 页 · 共 n 条`（10/页）；随 5s 轮询刷新；locale 有 zh/en。

实测：

- `GET /lepimemory/history?kind=audit&limit=3` → `{ok:true,total:8,entries:[…最新在前…]}`；`kind=../../etc/passwd` → **400**；伪造 Host → **403**。
- 浏览器：展开 History → 审计 8 条（时间 + 摘要）；切「召回」→ 列表变为召回条目；补足到 20 条后 `Page 1/2 → Next → Page 2/2`（Next 置灰）。

## 结论

- ✅ Host 路由 + 浏览器半面板打通：**状态实时可见**，且**审计/召回/写入/遗忘/行动五类账本可翻页回看**。
- ✅ 降级路径干净：无 `webServer` / 显式关闭 → 面板显示不可用、不影响其余功能。
- ✅ 历史分页（`/lepimemory/history`）：白名单 + 分页 + 信任栅栏 + 服务端出摘要；前端折叠面板 + 标签页 + 翻页。
- 未做（有意）：真实 Remote（走服务端事件）；面板**只读**——改状态仍走编辑 `state.json` 或 `write_note`，不从面板写。
