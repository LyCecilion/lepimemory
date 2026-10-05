/**
 * 浏览器半：`conversation.input.dock` 上的角色状态面板。
 *
 * 读宿主路由（共享契约）：
 *   - `GET  /lepimemory/state`                        当前状态（renderState + 数值 + core/status/counts 元数据），每 5s 刷新
 *   - `POST /lepimemory/state`                        操作者调整演示状态（body 仅 {mood,relation} 精确数值字段；原因固定由 host 落）
 *   - `GET  /lepimemory/history?kind=&limit=&offset=` 历史账本分页（最新在前）
 *   - `GET  /lepimemory/candidate?id=<uuid>[&reveal=1]` 批准快照/生命周期/来源链（reveal 仅审计，不恢复）
 *   - `POST /lepimemory/retry`                        {kind:'request'|'task', id} 显式重试（不自动重提）
 *
 * 手写 lazy-CJS（照抄 harness 夹具 apps/web/tests/fixtures/plugins/fixture-live-client/client.js）：
 * 经 `window.__ModuleLoader__.load({ id, factory })` 注册；`id` 必须是本包的 **bare 包名**
 * （client-modules 以包名作 boot 行 id）。`require` 只能取 **平台 seed**（react 等）。
 *
 * 设计要点：
 *   - 所有节点都用 React.createElement 渲染为**纯文本**，绝不使用 dangerouslySetInnerHTML；
 *   - 轮询按 kind/offset 绑定序号 + AbortController，effect cleanup 中止，跨切换不落陈旧响应；
 *   - 样式元素在组件 effect 内创建、dispose/hot-reload 时移除（不用 factory 级全局 append）；
 *   - 401/403 明确可见，且丢弃本地私有缓存（history/candidate）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-lepimemory-state',
  factory(require) {
    const React = require('react')

    const NS = 'lepimemoryState'
    const PAGE = 10

    /** 前五个既有标签 + task/control/consent 三个可达标签。 */
    const KINDS = [
      ['audit', 'tab_audit'],
      ['recall', 'tab_recall'],
      ['retain', 'tab_retain'],
      ['forget', 'tab_forget'],
      ['action', 'tab_action'],
      ['task', 'tab_task'],
      ['control', 'tab_control'],
      ['consent', 'tab_consent'],
    ]

    /**
     * 真实 store 状态 → 本地化文案 key。缺省显示原始状态串（绝不当作成功）。
     * 覆盖 plan 明确的枚举 + store 里实际会用到的其余枚举。
     */
    const STATUS_KEYS = {
      pending: 'st_pending',
      deferred: 'st_deferred',
      written: 'st_written',
      unknown: 'st_unknown',
      failed: 'st_failed',
      rejected: 'st_rejected',
      cancelled: 'st_cancelled',
      expired: 'st_expired',
      local_isolated: 'st_local_isolated',
      remote_pending: 'st_remote_pending',
      running: 'st_running',
      submitted: 'st_submitted',
      reconciled: 'st_reconciled',
      blocked: 'st_blocked',
      applied: 'st_applied',
      active: 'st_active',
      history_only: 'st_history_only',
      superseded: 'st_superseded',
      forgotten: 'st_forgotten',
      audit_only: 'st_audit_only',
      prepared: 'st_prepared',
      executed: 'st_executed',
      unavailable: 'st_unavailable',
    }

    /** 正向状态（只有真正可核对完成的才配。绝不按 !skipped 推断成功）。 */
    const OK_STATUS = new Set(['written', 'reconciled', 'executed', 'applied'])
    /** 进行中/等待。 */
    const PENDING_STATUS = new Set(['pending', 'deferred', 'running', 'submitted', 'prepared'])
    /** 负向/失败。 */
    const ERR_STATUS = new Set(['failed', 'rejected', 'cancelled', 'expired', 'unavailable', 'blocked'])

    /** 用 {k} 占位符做极简插值。 */
    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`))
    }

    /** 时间戳 → 本地时间串（解析失败则原样返回）。 */
    function fmtTime(at) {
      if (!at) return ''
      const d = new Date(at)
      return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleTimeString()
    }

    /** fetch → { status, ok, body }。body 缺失/非 JSON 则回退 {}。 */
    function fetchJson(url, init) {
      return fetch(url, init).then((resp) =>
        resp
          .json()
          .catch(() => null)
          .then((body) => ({ status: resp.status, ok: resp.ok, body: body || {} })),
      )
    }

    const CSS = [
      '.lep-state { margin: 0 auto 6px; max-width: 800px; padding: 6px 12px; font-size: 12px;',
      '  line-height: 1.5; white-space: pre-wrap; color: var(--dsw-alias-text-secondary, #8a8f98);',
      '  background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.06));',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2)); border-radius: 8px; }',
      '.lep-state__meta { margin-top: 4px; opacity: 0.75; }',
      '.lep-hist { margin-top: 6px; border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2)); padding-top: 4px; }',
      '.lep-hist__head { cursor: pointer; user-select: none; }',
      '.lep-hist__tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }',
      '.lep-tab { font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 6px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25)); background: transparent;',
      '  color: var(--dsw-alias-text-secondary, #8a8f98); }',
      '.lep-tab--on { background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.15)); color: inherit; }',
      '.lep-hist__list { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; }',
      '.lep-row { padding: 2px 0; white-space: normal; }',
      '.lep-row time { opacity: 0.6; margin-right: 6px; }',
      '.lep-hist__empty { opacity: 0.6; }',
      '.lep-hist__nav { display: flex; align-items: center; gap: 8px; margin-top: 4px; }',
      '.lep-btn { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 6px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25)); background: transparent; color: inherit; }',
      '.lep-btn:disabled { opacity: 0.4; cursor: default; }',
      '.lep-btn--mini { margin-left: 6px; padding: 0 6px; font-size: 10px; }',
      '.lep-badge { display: inline-block; font-size: 10px; padding: 0 5px; margin-right: 6px; border-radius: 5px;',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3)); }',
      '.lep-badge--ok { color: #2e7d32; border-color: #2e7d32; }',
      '.lep-badge--warn { color: #a06a00; border-color: #a06a00; }',
      '.lep-badge--err { color: #c62828; border-color: #c62828; }',
      '.lep-badge--muted { opacity: 0.7; }',
      '.lep-detail { margin: 2px 0 6px 12px; padding: 4px 8px; white-space: normal;',
      '  border-left: 2px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3)); }',
      '.lep-kv { display: flex; gap: 6px; white-space: normal; }',
      '.lep-kv b { font-weight: 600; opacity: 0.8; min-width: 72px; }',
      '.lep-sublist { list-style: none; margin: 0; padding: 0; }',
      '.lep-sublist li { white-space: normal; }',
      '.lep-snap-text { margin: 2px 0; padding: 4px 6px; white-space: pre-wrap; word-break: break-word;',
      '  background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.08)); border-radius: 6px; }',
      '.lep-form { margin: 2px 0 4px; }',
      '.lep-field { display: inline-flex; align-items: center; gap: 4px; margin: 2px 10px 2px 0; }',
      '.lep-field input { width: 66px; font: inherit; color: inherit; background: transparent;',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3)); border-radius: 5px; padding: 0 3px; }',
      '.lep-form__actions { display: flex; align-items: center; gap: 8px; margin-top: 3px; }',
      '.lep-note { opacity: 0.65; }',
      '.lep-err { color: #c62828; margin-top: 3px; white-space: normal; }',
      '.lep-receipts { margin: 3px 0; }',
      '.lep-receipts__title { opacity: 0.75; }',
      '.lep-receipts ul { list-style: none; margin: 0; padding: 0; max-height: 88px; overflow: auto; }',
      '.lep-receipts li time { opacity: 0.6; margin-right: 6px; }',
    ].join('\n')

    /** 状态 → 文案（legacy 记录加历史后缀；未知状态原样展示，绝不显示为成功）。 */
    function statusLabel(t, status, legacy) {
      const key = status ? STATUS_KEYS[status] : undefined
      let label = key ? t(key) : status ? String(status) : t('st_unknown')
      if (legacy === true) label += t('legacySuffix')
      return label
    }

    /** 状态 → 徽章配色类。 */
    function statusClass(status, legacy) {
      if (legacy === true && !OK_STATUS.has(status)) return status === 'failed' ? 'err' : 'muted'
      if (OK_STATUS.has(status)) return 'ok'
      if (PENDING_STATUS.has(status)) return 'warn'
      if (ERR_STATUS.has(status)) return 'err'
      return 'muted'
    }

    /** 详情行（标签 + 文本值）。 */
    function kv(label, value) {
      return React.createElement(
        'div',
        { className: 'lep-kv', key: label },
        React.createElement('b', null, label),
        React.createElement('span', null, value == null || value === '' ? '—' : String(value)),
      )
    }

    /** 详情列表（每条渲染为纯文本）。 */
    function listBlock(label, arr, fmt) {
      if (!Array.isArray(arr) || arr.length === 0) return kv(label, '—')
      return React.createElement(
        'div',
        { className: 'lep-kv', key: label },
        React.createElement('b', null, label),
        React.createElement(
          'ul',
          { className: 'lep-sublist' },
          arr.map((x, i) => React.createElement('li', { key: i }, fmt(x))),
        ),
      )
    }

    function lifecycleText(l) {
      if (!l || typeof l !== 'object') return '—'
      let s = String(l.status || '?')
      if (l.purpose) s += ' · ' + l.purpose
      if (l.grant_id) s += ' · grant ' + l.grant_id
      if (l.confirmed_by) s += ' · ' + l.confirmed_by
      if (l.updated_at) s += ' · ' + fmtTime(l.updated_at)
      return s
    }

    function sourceText(s) {
      if (!s || typeof s !== 'object') return '—'
      let out = String(s.id || '?')
      if (s.actor) out += ' · ' + s.actor
      if (s.kind) out += ' · ' + s.kind
      if (s.session_id) out += ' · session ' + s.session_id
      if (s.message_id) out += ' · message ' + s.message_id
      if (s.seq != null) out += ' · seq ' + s.seq
      if (s.block_index != null) out += ' · block ' + s.block_index + ':' + s.start + '-' + s.end
      if (s.at) out += ' · ' + fmtTime(s.at)
      return out
    }

    function rawText(r) {
      if (!r || typeof r !== 'object') return '—'
      let out = String(r.raw_id || '?')
      if (r.document_id) out += ' · document ' + r.document_id
      if (r.version_hash) out += ' · ' + String(r.version_hash).slice(0, 12)
      if (r.state) out += ' · ' + r.state
      if (r.verified_at) out += ' · ' + fmtTime(r.verified_at)
      return out
    }

    function taskText(t, k) {
      if (!k || typeof k !== 'object') return '—'
      let out = String(k.id || '?') + ' · ' + statusLabel(t, k.status, false)
      if (k.kind) out += ' · ' + k.kind
      if (k.error_code) out += ' · ' + k.error_code
      return out
    }

    function opText(o) {
      if (!o || typeof o !== 'object') return '—'
      return String(o.operation_id || '?') + ' · task ' + String(o.task_id || '?') + ' · ' + String(o.status || '?')
    }

    function grantText(g) {
      if (!g || typeof g !== 'object') return '—'
      let out = String(g.id || '?')
      if (g.scope != null) out += ' · ' + (typeof g.scope === 'string' ? g.scope : JSON.stringify(g.scope))
      if (g.expires_at) out += ' · exp ' + fmtTime(g.expires_at)
      if (g.revoked_at) out += ' · revoked ' + fmtTime(g.revoked_at)
      if (g.allow_inference != null) out += ' · inference=' + String(g.allow_inference)
      return out
    }

    /** 面板组件：状态每 5s 刷新；历史面板可折叠、按 kind 切换、翻页；支持详情/重试/操作者编辑。 */
    function Panel({ t }) {
      const [s, setS] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [kind, setKind] = React.useState('audit')
      const [offset, setOffset] = React.useState(0)
      const [hist, setHist] = React.useState(null)
      const [stateTick, setStateTick] = React.useState(0)
      const [histTick, setHistTick] = React.useState(0)
      const [expanded, setExpanded] = React.useState({})
      const [cand, setCand] = React.useState({})
      const [editorOpen, setEditorOpen] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [formError, setFormError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [retrying, setRetrying] = React.useState({})
      const [receipts, setReceipts] = React.useState([])

      const mounted = React.useRef(true)
      const candAbort = React.useRef(new Map())
      const receiptsRef = React.useRef(new Map())
      const privateEpoch = React.useRef(0)

      function clearPrivate() {
        privateEpoch.current += 1
        candAbort.current.forEach((controller) => controller.abort())
        candAbort.current.clear()
        receiptsRef.current.clear()
        setS({ ok: false, forbidden: true })
        setHist({ ok: false, forbidden: true })
        setCand({})
        setExpanded({})
        setReceipts([])
        setForm(null)
        setEditorOpen(false)
        setFormError('')
        setSaving(false)
        setRetrying({})
      }

      // 样式元素绑定组件生命周期：挂载创建、卸载/hot-reload 移除；不残留旧副本。
      React.useEffect(() => {
        const stale = document.querySelectorAll('style[data-plugin="@dsh-external/dsh-lepimemory-state"]')
        stale.forEach((n) => n.remove())
        const style = document.createElement('style')
        style.dataset.plugin = '@dsh-external/dsh-lepimemory-state'
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, [])

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          candAbort.current.forEach((c) => c.abort())
          candAbort.current.clear()
        }
      }, [])

      // 状态轮询：AbortController + 序号，dispose 中止；401/403 清空本地私有缓存。
      React.useEffect(() => {
        const ctrl = new AbortController()
        let alive = true
        let seq = 0
        const load = () => {
          const my = ++seq
          const epoch = privateEpoch.current
          fetchJson('/lepimemory/state', { signal: ctrl.signal })
            .then((r) => {
              if (!alive || my !== seq || epoch !== privateEpoch.current) return
              if (r.status === 401 || r.status === 403) { clearPrivate(); return }
              if (!r.ok || r.body.ok === false) { setS({ ok: false }); return }
              setS(r.body)
            })
            .catch((err) => { if (alive && my === seq && epoch === privateEpoch.current && err.name !== 'AbortError') setS({ ok: false }) })
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; ctrl.abort(); clearInterval(timer) }
      }, [stateTick])

      // 折叠时也读取最新审计回执；展开后按 kind/offset 分页，序号阻止陈旧响应。
      React.useEffect(() => {
        setHist(null)
        const selectedKind = open ? kind : 'audit'
        const selectedOffset = open ? offset : 0
        const ctrl = new AbortController()
        let alive = true
        let seq = 0
        const url = `/lepimemory/history?kind=${encodeURIComponent(selectedKind)}&limit=${PAGE}&offset=${selectedOffset}`
        const load = () => {
          const my = ++seq
          const epoch = privateEpoch.current
          fetchJson(url, { signal: ctrl.signal })
            .then((r) => {
              if (!alive || my !== seq || epoch !== privateEpoch.current) return
              if (r.status === 401 || r.status === 403) { clearPrivate(); return }
              if (!r.ok || r.body.ok === false) { setHist({ ok: false }); return }
              const body = r.body
              const entries = Array.isArray(body.entries) ? body.entries : []
              setHist({
                ok: true,
                kind: body.kind || selectedKind,
                total: typeof body.total === 'number' ? body.total : entries.length,
                offset: typeof body.offset === 'number' ? body.offset : selectedOffset,
                limit: typeof body.limit === 'number' ? body.limit : PAGE,
                entries,
              })
            })
            .catch((err) => { if (alive && my === seq && epoch === privateEpoch.current && err.name !== 'AbortError') setHist({ ok: false }) })
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; ctrl.abort(); clearInterval(timer) }
      }, [open, kind, offset, histTick])

      // 从历史记录汇聚系统回执：按 audit/request/task ID 去重（不触发任何模型调用）。
      React.useEffect(() => {
        if (!hist || hist.ok !== true) return
        let changed = false
        for (const e of hist.entries || []) {
          const type = e.type
          if (type !== 'control' && type !== 'consent' && type !== 'task' && type !== 'retain' && type !== 'forget' && type !== 'action') continue
          const key = e.task_id ? `task:${e.task_id}` : e.request_id ? `request:${e.request_id}` : `audit:${e.id}`
          const previous = receiptsRef.current.get(key)
          if (previous && previous.auditId >= e.id) continue
          receiptsRef.current.set(key, {
            key,
            at: e.at,
            auditId: e.id,
            text: `${statusLabel(t, e.status, e.data && e.data.legacy)} · ${e.summary || type}`,
          })
          changed = true
        }
        if (changed) publishReceipts()
      }, [hist, t])

      // 详情随真实历史轮询刷新；不能永久缓存遗忘前的正文或旧任务状态。
      React.useEffect(() => {
        const visible = new Set()
        if (open && hist && hist.ok === true) {
          for (const e of hist.entries || []) {
            if (e.candidate_id && expanded[`e${e.id}`]) visible.add(e.candidate_id)
            if (expanded[`e${e.id}`]) for (const chain of e.data?.chains || []) {
              for (const source of chain.sources || []) {
                if (source.candidate_id && expanded[`c${e.id}-${source.candidate_id}`]) visible.add(source.candidate_id)
              }
            }
          }
        }
        for (const [id, controller] of candAbort.current) {
          if (!visible.has(id)) { controller.abort(); candAbort.current.delete(id) }
        }
        for (const id of visible) loadCandidate(id, !!(cand[id] && cand[id].revealed))
      }, [open, hist, expanded])

      function publishReceipts() {
        const latest = Array.from(receiptsRef.current.values()).sort((a, b) => b.at - a.at).slice(0, PAGE)
        receiptsRef.current = new Map(latest.map((r) => [r.key, r]))
        setReceipts(latest)
      }

      function addReceipt(key, at, text) {
        receiptsRef.current.set(key, { key, at, text })
        publishReceipts()
      }

      function loadCandidate(id, reveal) {
        const ctrl = new AbortController()
        const prevCtrl = candAbort.current.get(id)
        if (prevCtrl) prevCtrl.abort()
        candAbort.current.set(id, ctrl)
        setCand((prev) => ({ ...prev, [id]: { loading: true, forbidden: false } }))
        const url = `/lepimemory/candidate?id=${encodeURIComponent(id)}${reveal ? '&reveal=1' : ''}`
        fetchJson(url, { signal: ctrl.signal })
          .then((r) => {
            if (candAbort.current.get(id) !== ctrl) return
            candAbort.current.delete(id)
            if (!mounted.current) return
            if (r.status === 401 || r.status === 403) { clearPrivate(); return }
            if (!r.ok || r.body.ok === false) { setCand((prev) => ({ ...prev, [id]: { ok: false, error: true } })); return }
            setCand((prev) => ({ ...prev, [id]: { ok: true, data: r.body, revealed: !!reveal } }))
          })
          .catch((err) => {
            if (err.name === 'AbortError') return
            if (candAbort.current.get(id) !== ctrl) return
            candAbort.current.delete(id)
            if (!mounted.current) return
            setCand((prev) => ({ ...prev, [id]: { ok: false, error: true } }))
          })
      }

      function toggleEntry(key, e) {
        setExpanded((prev) => {
          const next = { ...prev }
          if (next[key]) delete next[key]
          else next[key] = true
          return next
        })
        if (e.candidate_id) setCand((prev) => { const next = { ...prev }; delete next[e.candidate_id]; return next })
      }

      function doRetry(retryKind, id) {
        const btnKey = `${retryKind}:${id}`
        const epoch = privateEpoch.current
        setRetrying((prev) => ({ ...prev, [btnKey]: true }))
        fetchJson('/lepimemory/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: retryKind, id }),
        })
          .then((r) => {
            if (!mounted.current || epoch !== privateEpoch.current) return
            setRetrying((prev) => ({ ...prev, [btnKey]: false }))
            if (r.status === 401 || r.status === 403) { clearPrivate(); return }
            if (r.status === 404) { addReceipt(`retry:${btnKey}`, Date.now(), t('retryNotFound')); return }
            if (r.status === 409) {
              const resubmit = r.body && r.body.code === 'LEPI_INPUT_RESUBMIT_REQUIRED'
              addReceipt(`retry:${btnKey}`, Date.now(), resubmit ? t('retryResubmit') : t('retryForbidden'))
              return
            }
            if (!r.ok || r.body.ok === false) { addReceipt(`retry:${btnKey}`, Date.now(), t('retryFailed')); return }
            const doneId = r.body.request_id || r.body.task_id || r.body.id || id
            addReceipt(`${retryKind}:${doneId}`, Date.now(), t('retryQueued'))
            setHistTick((x) => x + 1)
          })
          .catch(() => {
            if (!mounted.current || epoch !== privateEpoch.current) return
            setRetrying((prev) => ({ ...prev, [btnKey]: false }))
            addReceipt(`retry:${btnKey}`, Date.now(), t('retryFailed'))
          })
      }

      // 操作者编辑：打开时以当前状态为初值（避免 5s 轮询覆盖正在编辑的字段）。
      React.useEffect(() => {
        if (!editorOpen) return
        if (!s || s.ok === false || !s.mood || !s.relation) return
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '')
        setForm({
          mood: { valence: num(s.mood.valence), arousal: num(s.mood.arousal) },
          relation: { trust: num(s.relation.trust), closeness: num(s.relation.closeness), familiarity: num(s.relation.familiarity) },
        })
        setFormError('')
      }, [editorOpen])

      function submitState(ev) {
        ev.preventDefault()
        if (!form) return
        const fields = [
          ['valence', form.mood.valence, -1, 1],
          ['arousal', form.mood.arousal, 0, 1],
          ['trust', form.relation.trust, 0, 1],
          ['closeness', form.relation.closeness, 0, 1],
          ['familiarity', form.relation.familiarity, 0, 1],
        ]
        for (const [name, v, lo, hi] of fields) {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
            setFormError(fill(t('formRange'), { field: name, lo, hi }))
            return
          }
        }
        setFormError('')
        setSaving(true)
        const epoch = privateEpoch.current
        // 精确 payload：只有数值字段。原因是 host 固定的「操作者调整演示状态」，不由前端提交。
        fetchJson('/lepimemory/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mood: { valence: form.mood.valence, arousal: form.mood.arousal },
            relation: { trust: form.relation.trust, closeness: form.relation.closeness, familiarity: form.relation.familiarity },
          }),
        })
          .then((r) => {
            if (!mounted.current || epoch !== privateEpoch.current) return
            setSaving(false)
            if (r.status === 401 || r.status === 403) { clearPrivate(); return }
            if (!r.ok || r.body.ok === false) { setFormError(t('saveFailed')); return }
            const idKey = r.body.audit_id != null ? r.body.audit_id : r.body.id != null ? r.body.id : r.body.request_id
            addReceipt(idKey != null ? `audit:${idKey}` : `state:${Date.now()}`, Date.now(), `${t('opCauseFixed')} · ${fmtTime(r.body.updatedAt || Date.now())}`)
            setStateTick((x) => x + 1)
          })
          .catch(() => { if (mounted.current && epoch === privateEpoch.current) { setSaving(false); setFormError(t('saveFailed')) } })
      }

      function field(label, value, onChange) {
        return React.createElement(
          'label',
          { className: 'lep-field', key: label },
          label,
          React.createElement('input', {
            type: 'number',
            step: '0.01',
            value: value === '' || value == null ? '' : value,
            onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
          }),
        )
      }

      function renderCandidate(id) {
        const c = cand[id]
        if (!c) return null
        if (c.loading) return React.createElement('div', { className: 'lep-kv' }, t('candLoading'))
        if (c.forbidden) return React.createElement('div', { className: 'lep-kv' }, t('candForbidden'))
        if (!c.ok) return React.createElement('div', { className: 'lep-kv' }, t('candFailed'))
        const d = c.data
        const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null
        const text = snap && typeof snap.text === 'string' ? snap.text : null
        const snapBlock = React.createElement(
          'div',
          { key: 'snapshot' },
          kv(t('snapshot'), snap ? `${snap.payload_hash ? String(snap.payload_hash).slice(0, 12) : '—'} · ${fmtTime(snap.created_at)}` : '—'),
          text
            ? React.createElement('div', { className: 'lep-snap-text' }, text)
            : React.createElement(
                'div',
                null,
                React.createElement('button', { type: 'button', className: 'lep-btn lep-btn--mini', onClick: () => loadCandidate(id, true) }, t('reveal')),
              ),
          c.revealed
            ? React.createElement('button', { type: 'button', className: 'lep-btn lep-btn--mini', onClick: () => loadCandidate(id, false) }, t('revealHide'))
            : null,
        )
        return React.createElement(
          'div',
          { className: 'lep-detail' },
          kv(t('candidateId'), d.candidate_id || id),
          kv(t('lifecycle'), lifecycleText(d.lifecycle)),
          snapBlock,
          listBlock(t('sources'), d.sources, sourceText),
          listBlock(t('rawLinks'), d.raw_links, rawText),
          listBlock(t('tasks'), d.tasks, (k) => taskText(t, k)),
          listBlock(t('operations'), d.operations, opText),
          listBlock(t('grants'), d.grants, grantText),
        )
      }

      function renderRecall(data, entryId) {
        if (!Array.isArray(data?.chains)) return null
        const selected = new Set((data.picked || []).flatMap(item => item.raw_ids || []))
        return React.createElement(
          'div',
          { className: 'lep-sources' },
          data.chains.map((chain, i) => React.createElement(
            'div',
            { key: i, className: 'lep-detail' },
            kv(t('refObservation'), chain.observation_id || '—'),
            (chain.sources || []).map((source, j) => {
              const candidateKey = `c${entryId}-${source.candidate_id}`
              const excluded = (data.excluded || []).find(item => item.id === source.raw_id)
              return React.createElement(
                'div',
                { key: j, className: 'lep-detail' },
                kv(t('refRaw'), source.raw_id),
                kv(t('refCandidate'), source.candidate_id || '—'),
                kv(t('refEvidence'), (source.evidence_ids || []).join(' · ') || '—'),
                kv(t('refVerdict'), selected.has(source.raw_id) ? t('recallSelected') : excluded?.code || t('recallNotSelected')),
                source.candidate_id ? React.createElement('button', {
                  type: 'button', className: 'lep-btn lep-btn--mini',
                  onClick: () => toggleEntry(candidateKey, { candidate_id: source.candidate_id }),
                }, expanded[candidateKey] ? t('collapse') : t('detail')) : null,
                source.candidate_id && expanded[candidateKey] ? renderCandidate(source.candidate_id) : null,
              )
            }),
          )),
          listBlock(t('recallExcluded'), data.excluded, item => `${item.id} · ${item.code}${item.observation_id ? ` · ${t('refObservation')} ${item.observation_id}` : ''}`),
        )
      }

      function renderEntry(e, i) {
        const key = e.id != null ? `e${e.id}` : `${e.at}-${i}`
        const isOpen = !!expanded[key]
        const legacy = !!(e.data && e.data.legacy)
        const badge = React.createElement(
          'span',
          { className: `lep-badge lep-badge--${statusClass(e.status, legacy)}` },
          statusLabel(t, e.status, legacy),
        )
        const refs = []
        const pushRef = (label, value) => { if (value != null && value !== '') refs.push(kv(label, value)) }
        pushRef(t('refSession'), e.session_id)
        pushRef(t('refTurn'), e.turn)
        pushRef(t('refStep'), e.step)
        pushRef(t('refCall'), e.call_id)
        pushRef(t('refRequest'), e.request_id)
        pushRef(t('refTask'), e.task_id)
        pushRef(t('refCandidate'), e.candidate_id)
        pushRef(t('refOperation'), e.operation_id)
        pushRef(t('refAction'), e.data?.action_id)
        for (const call of e.data?.action_calls || []) {
          refs.push(React.createElement('div', { key: call.action_id },
            kv(t('refAction'), call.action_id), kv(t('refStep'), call.step), kv(t('refCall'), call.call_id)))
        }
        const code = e.data && (e.data.code || e.data.error_code || e.data.reason_code)
        if (code != null) refs.push(kv(t('refCode'), code))
        if (e.type === 'retain' && e.status === 'admission' && e.data) {
          pushRef(t('refBackend'), e.data.backend)
          pushRef(t('refVerdict'), e.data.verdict)
          pushRef(t('refScore'), e.data.score)
          pushRef(t('refModel'), e.data.model)
          pushRef(t('refRevision'), e.data.revision)
          pushRef(t('refTruncated'), e.data.truncated)
        }
        const retryButtons = []
        if (e.request_id) retryButtons.push(React.createElement('button', { key: 'rq', type: 'button', className: 'lep-btn lep-btn--mini', disabled: !!retrying[`request:${e.request_id}`], onClick: () => doRetry('request', e.request_id) }, t('retryRequest')))
        if (e.task_id) retryButtons.push(React.createElement('button', { key: 'tk', type: 'button', className: 'lep-btn lep-btn--mini', disabled: !!retrying[`task:${e.task_id}`], onClick: () => doRetry('task', e.task_id) }, t('retryTask')))
        const hasDetail = refs.length > 0 || !!e.candidate_id || retryButtons.length > 0
        return React.createElement(
          'li',
          { key, className: 'lep-row' },
          React.createElement('time', null, fmtTime(e.at)),
          badge,
          React.createElement('span', null, e.summary || e.type || ''),
          hasDetail
            ? React.createElement('button', { type: 'button', className: 'lep-btn lep-btn--mini', onClick: () => toggleEntry(key, e) }, isOpen ? t('collapse') : t('detail'))
            : null,
          isOpen
            ? React.createElement('div', { className: 'lep-detail' }, refs, e.candidate_id ? renderCandidate(e.candidate_id) : null, renderRecall(e.data, e.id), retryButtons)
            : null,
        )
      }

      if (s === null) return null
      if (s.ok === false) {
        return React.createElement('div', { className: 'lep-state' }, s.forbidden ? t('forbidden') : t('unavailable'))
      }

      const total = hist && hist.ok === true ? hist.total : 0
      const pages = Math.max(1, Math.ceil(total / PAGE))
      const page = Math.floor(offset / PAGE) + 1

      const metaParts = []
      metaParts.push(`${t('mood')} ${s.mood ? `${s.mood.valence}/${s.mood.arousal}` : '—'}`)
      metaParts.push(`${t('relation')} ${s.relation ? `${s.relation.trust}/${s.relation.closeness}/${s.relation.familiarity}` : '—'}`)
      if (s.updatedAt) metaParts.push(String(s.updatedAt))
      if (s.core != null) metaParts.push(`${t('core')}=${s.core ? 'ok' : '—'}`)
      if (s.status && typeof s.status === 'object') {
        const bits = []
        if (s.status.running != null) bits.push(`running=${!!s.status.running}`)
        if (s.status.tasks != null) bits.push(`tasks=${JSON.stringify(s.status.tasks)}`)
        if (s.status.total != null) bits.push(`total=${s.status.total}`)
        if (s.status.last_error) bits.push(`last_error=${s.status.last_error}`)
        if (bits.length) metaParts.push(bits.join(' '))
      }
      if (s.counts && typeof s.counts === 'object') {
        const bits = Object.keys(s.counts).map((k) => `${k}=${JSON.stringify(s.counts[k])}`)
        if (bits.length) metaParts.push(`${t('counts')} ${bits.join(' ')}`)
      }

      const receiptsBlock = receipts.length
        ? React.createElement(
            'div',
            { className: 'lep-receipts' },
            React.createElement('div', { className: 'lep-receipts__title' }, t('receipts')),
            React.createElement(
              'ul',
              null,
              receipts.map((r) => React.createElement('li', { key: r.key }, React.createElement('time', null, fmtTime(r.at)), r.text)),
            ),
          )
        : null

      const history = !open
        ? null
        : React.createElement(
            'div',
            { className: 'lep-hist__body' },
            React.createElement(
              'div',
              { className: 'lep-hist__tabs' },
              KINDS.map(([k, key]) =>
                React.createElement(
                  'button',
                  {
                    key: k,
                    type: 'button',
                    className: 'lep-tab' + (k === kind ? ' lep-tab--on' : ''),
                    onClick: () => { setKind(k); setOffset(0) },
                  },
                  t(key),
                ),
              ),
            ),
            hist === null || hist.ok !== true
              ? React.createElement('div', { className: 'lep-hist__empty' }, hist && hist.forbidden ? t('forbidden') : t('unavailable'))
              : React.createElement(
                  'div',
                  null,
                  hist.entries.length === 0
                    ? React.createElement('div', { className: 'lep-hist__empty' }, t('empty'))
                    : React.createElement('ul', { className: 'lep-hist__list' }, hist.entries.map((e, i) => renderEntry(e, i))),
                  React.createElement(
                    'div',
                    { className: 'lep-hist__nav' },
                    React.createElement('button', { type: 'button', disabled: offset <= 0, onClick: () => setOffset(Math.max(0, offset - PAGE)) }, t('prev')),
                    React.createElement('span', null, fill(t('pageOf'), { p: page, q: pages, n: total })),
                    React.createElement('button', { type: 'button', disabled: offset + PAGE >= total, onClick: () => setOffset(offset + PAGE) }, t('next')),
                  ),
                ),
          )

      const editor = React.createElement(
        'div',
        { className: 'lep-hist' },
        React.createElement('div', { className: 'lep-hist__head', onClick: () => setEditorOpen(!editorOpen) }, `${editorOpen ? '▾' : '▸'} ${t('opTitle')}`),
        editorOpen && form
          ? React.createElement(
              'form',
              { className: 'lep-form', onSubmit: submitState },
              field(t('valence'), form.mood.valence, (v) => setForm((f) => ({ ...f, mood: { ...f.mood, valence: v } }))),
              field(t('arousal'), form.mood.arousal, (v) => setForm((f) => ({ ...f, mood: { ...f.mood, arousal: v } }))),
              field(t('trust'), form.relation.trust, (v) => setForm((f) => ({ ...f, relation: { ...f.relation, trust: v } }))),
              field(t('closeness'), form.relation.closeness, (v) => setForm((f) => ({ ...f, relation: { ...f.relation, closeness: v } }))),
              field(t('familiarity'), form.relation.familiarity, (v) => setForm((f) => ({ ...f, relation: { ...f.relation, familiarity: v } }))),
              React.createElement(
                'div',
                { className: 'lep-form__actions' },
                React.createElement('button', { type: 'submit', className: 'lep-btn', disabled: saving }, saving ? t('saving') : t('save')),
                React.createElement('span', { className: 'lep-note' }, t('opCauseFixed')),
              ),
              formError ? React.createElement('div', { className: 'lep-err' }, formError) : null,
            )
          : null,
      )

      return React.createElement(
        'div',
        { className: 'lep-state' },
        s.rendered,
        React.createElement('div', { className: 'lep-state__meta' }, metaParts.join(' · ')),
        receiptsBlock,
        React.createElement(
          'div',
          { className: 'lep-hist' },
          React.createElement('div', { className: 'lep-hist__head', onClick: () => setOpen(!open) }, `${open ? '▾' : '▸'} ${t('history')}`),
          history,
        ),
        editor,
      )
    }

    const dicts = {
      zh: {
        unavailable: '状态不可用',
        forbidden: '无权访问（权限已丢失）',
        history: '历史记录',
        empty: '（暂无记录）',
        prev: '上一页',
        next: '下一页',
        pageOf: '第 {p}/{q} 页 · 共 {n} 条',
        tab_audit: '审计',
        tab_recall: '召回',
        tab_retain: '写入',
        tab_forget: '遗忘',
        tab_action: '行动',
        tab_task: '任务',
        tab_control: '控制',
        tab_consent: '确认',
        st_pending: '待处理',
        st_deferred: '待判定',
        st_written: '已核实入库',
        st_unknown: '结果不明',
        st_failed: '处理失败',
        st_rejected: '已拒绝',
        st_cancelled: '已取消',
        st_expired: '已过期',
        st_local_isolated: '已停止使用',
        st_remote_pending: '后端清理待完成',
        st_running: '进行中',
        st_submitted: '已提交',
        st_reconciled: '已核实入库',
        st_blocked: '受阻',
        st_applied: '已应用',
        st_active: '有效',
        st_history_only: '仅历史',
        st_superseded: '已被取代',
        st_forgotten: '已遗忘',
        st_audit_only: '仅审计',
        st_prepared: '已准备',
        st_executed: '已执行',
        st_unavailable: '不可用',
        legacySuffix: '（历史记录）',
        detail: '详情',
        collapse: '收起',
        retryRequest: '重试请求',
        retryTask: '重试任务',
        retryNotFound: '未找到该记录',
        retryForbidden: '当前状态不允许重试',
        retryResubmit: '该输入已失效，请重新发起请求',
        retryQueued: '已受理，等待处理',
        retryFailed: '重试失败',
        opTitle: '操作者调整演示状态',
        opCauseFixed: '原因：操作者调整演示状态',
        mood: '心境',
        relation: '对用户',
        valence: '愉悦度',
        arousal: '唤醒度',
        trust: '信任',
        closeness: '亲近',
        familiarity: '熟悉',
        save: '保存',
        saving: '保存中…',
        saveFailed: '保存失败',
        formRange: '字段 {field} 必须在 {lo}..{hi}',
        reveal: '查看原始获准快照（仅审计，不恢复）',
        revealHide: '隐藏快照',
        candLoading: '读取中…',
        candFailed: '读取失败',
        candForbidden: '无权查看（已清除本地缓存）',
        candidateId: '候选',
        lifecycle: '生命周期',
        snapshot: '快照',
        sources: '来源',
        rawLinks: '原始链接',
        tasks: '任务',
        operations: '操作',
        grants: '授权',
        receipts: '系统回执',
        core: '核心',
        counts: '计数',
        refSession: '会话',
        refTurn: '轮次',
        refStep: '步骤',
        refCall: '调用',
        refRequest: '请求',
        refTask: '任务',
        refCandidate: '候选',
        refOperation: '操作',
        refAction: '行动',
        refCode: '代码',
        refBackend: '准入后端',
        refVerdict: '判定',
        refScore: '后端分数',
        refModel: '模型',
        refRevision: '模型版本',
        refTruncated: '输入被截断',
        refObservation: '综合观察',
        refRaw: '原始记忆',
        refEvidence: '真实证据',
        recallSelected: '已入选',
        recallNotSelected: '未入选',
        recallExcluded: '排除与回退原因',
      },
      en: {
        unavailable: 'State unavailable',
        forbidden: 'Forbidden (permission lost)',
        history: 'History',
        empty: '(no records)',
        prev: 'Prev',
        next: 'Next',
        pageOf: 'Page {p}/{q} · {n} total',
        tab_audit: 'Audit',
        tab_recall: 'Recall',
        tab_retain: 'Retain',
        tab_forget: 'Forget',
        tab_action: 'Action',
        tab_task: 'Task',
        tab_control: 'Control',
        tab_consent: 'Consent',
        st_pending: 'Pending',
        st_deferred: 'Deferred',
        st_written: 'Written',
        st_unknown: 'Unknown',
        st_failed: 'Failed',
        st_rejected: 'Rejected',
        st_cancelled: 'Cancelled',
        st_expired: 'Expired',
        st_local_isolated: 'Isolated',
        st_remote_pending: 'Remote cleanup pending',
        st_running: 'Running',
        st_submitted: 'Submitted',
        st_reconciled: 'Reconciled',
        st_blocked: 'Blocked',
        st_applied: 'Applied',
        st_active: 'Active',
        st_history_only: 'History only',
        st_superseded: 'Superseded',
        st_forgotten: 'Forgotten',
        st_audit_only: 'Audit only',
        st_prepared: 'Prepared',
        st_executed: 'Executed',
        st_unavailable: 'Unavailable',
        legacySuffix: ' (legacy)',
        detail: 'Details',
        collapse: 'Hide',
        retryRequest: 'Retry request',
        retryTask: 'Retry task',
        retryNotFound: 'Not found',
        retryForbidden: 'Retry not allowed in this state',
        retryResubmit: 'Input expired — please resubmit',
        retryQueued: 'Accepted — pending',
        retryFailed: 'Retry failed',
        opTitle: 'Operator state edit',
        opCauseFixed: 'Cause: operator state adjustment',
        mood: 'Mood',
        relation: 'Relation',
        valence: 'Valence',
        arousal: 'Arousal',
        trust: 'Trust',
        closeness: 'Closeness',
        familiarity: 'Familiarity',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'Save failed',
        formRange: 'Field {field} must be within {lo}..{hi}',
        reveal: 'View original approved snapshot (audit only, no restore)',
        revealHide: 'Hide snapshot',
        candLoading: 'Loading…',
        candFailed: 'Load failed',
        candForbidden: 'Forbidden (local cache cleared)',
        candidateId: 'Candidate',
        lifecycle: 'Lifecycle',
        snapshot: 'Snapshot',
        sources: 'Sources',
        rawLinks: 'Raw links',
        tasks: 'Tasks',
        operations: 'Operations',
        grants: 'Grants',
        receipts: 'System receipts',
        core: 'Core',
        counts: 'Counts',
        refSession: 'Session',
        refTurn: 'Turn',
        refStep: 'Step',
        refCall: 'Call',
        refRequest: 'Request',
        refTask: 'Task',
        refCandidate: 'Candidate',
        refOperation: 'Operation',
        refAction: 'Action',
        refCode: 'Code',
        refBackend: 'Admission backend',
        refVerdict: 'Verdict',
        refScore: 'Backend score',
        refModel: 'Model',
        refRevision: 'Model revision',
        refTruncated: 'Input truncated',
        refObservation: 'Observation',
        refRaw: 'Raw memory',
        refEvidence: 'Genuine evidence',
        recallSelected: 'Selected',
        recallNotSelected: 'Not selected',
        recallExcluded: 'Exclusion and fallback reasons',
      },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'lepimemory-state: locale')
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'lepimemory-state', order: 5, locale: NS },
            Panel,
          ),
        )
      },
    }
  },
})
