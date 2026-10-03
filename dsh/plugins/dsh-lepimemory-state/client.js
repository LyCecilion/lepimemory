/**
 * 浏览器半：`conversation.input.dock` 上的角色状态面板。
 *
 * 读宿主两条路由：
 *   - `GET /lepimemory/state`                          当前状态（renderState + 数值），每 5s 刷新
 *   - `GET /lepimemory/history?kind=&limit=&offset=`   历史账本分页（审计/召回/写入/遗忘/行动）
 *
 * 手写 lazy-CJS（照抄 harness 夹具 apps/web/tests/fixtures/plugins/fixture-live-client/client.js）：
 * 经 `window.__ModuleLoader__.load({ id, factory })` 注册；`id` 必须是本包的 **bare 包名**
 * （client-modules 以包名作 boot 行 id）。`require` 只能取 **平台 seed**（react 等）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-lepimemory-state',
  factory(require) {
    const React = require('react')

    const NS = 'lepimemoryState'
    const PAGE = 10
    const KINDS = [
      ['audit', 'tab_audit'],
      ['recall', 'tab_recall'],
      ['retain', 'tab_retain'],
      ['forget', 'tab_forget'],
      ['action', 'tab_action'],
    ]

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

    const style = document.createElement('style')
    style.dataset.plugin = '@dsh-external/dsh-lepimemory-state'
    style.textContent = [
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
      '.lep-hist__list { list-style: none; margin: 0; padding: 0; max-height: 160px; overflow: auto; }',
      '.lep-hist__list li { padding: 1px 0; white-space: normal; }',
      '.lep-hist__list time { opacity: 0.6; margin-right: 6px; }',
      '.lep-hist__empty { opacity: 0.6; }',
      '.lep-hist__nav { display: flex; align-items: center; gap: 8px; margin-top: 4px; }',
      '.lep-hist__nav button { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 6px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25)); background: transparent; color: inherit; }',
      '.lep-hist__nav button:disabled { opacity: 0.4; cursor: default; }',
    ].join('\n')
    document.head.append(style)

    /** 面板组件：状态每 5s 刷新；历史面板可折叠、按 kind 切换、翻页。 */
    function Panel({ t }) {
      const [s, setS] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [kind, setKind] = React.useState('audit')
      const [offset, setOffset] = React.useState(0)
      const [hist, setHist] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const load = () =>
          fetch('/lepimemory/state')
            .then((r) => r.json())
            .then((d) => { if (alive) setS(d) })
            .catch(() => { if (alive) setS({ ok: false }) })
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const load = () =>
          fetch(`/lepimemory/history?kind=${encodeURIComponent(kind)}&limit=${PAGE}&offset=${offset}`)
            .then((r) => r.json())
            .then((d) => { if (alive) setHist(d) })
            .catch(() => { if (alive) setHist({ ok: false }) })
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [open, kind, offset])

      if (s === null) return null
      if (s.ok === false) {
        return React.createElement('div', { className: 'lep-state' }, t('unavailable'))
      }

      const total = hist && hist.ok !== false ? hist.total : 0
      const pages = Math.max(1, Math.ceil(total / PAGE))
      const page = Math.floor(offset / PAGE) + 1

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
            hist === null || hist.ok === false
              ? React.createElement('div', { className: 'lep-hist__empty' }, t('unavailable'))
              : React.createElement(
                  'div',
                  null,
                  hist.entries.length === 0
                    ? React.createElement('div', { className: 'lep-hist__empty' }, t('empty'))
                    : React.createElement(
                        'ul',
                        { className: 'lep-hist__list' },
                        hist.entries.map((e, i) =>
                          React.createElement(
                            'li',
                            { key: `${e.at}-${i}` },
                            React.createElement('time', null, fmtTime(e.at)),
                            e.summary,
                          ),
                        ),
                      ),
                  React.createElement(
                    'div',
                    { className: 'lep-hist__nav' },
                    React.createElement(
                      'button',
                      { type: 'button', disabled: offset <= 0, onClick: () => setOffset(Math.max(0, offset - PAGE)) },
                      t('prev'),
                    ),
                    React.createElement('span', null, fill(t('pageOf'), { p: page, q: pages, n: total })),
                    React.createElement(
                      'button',
                      { type: 'button', disabled: offset + PAGE >= total, onClick: () => setOffset(offset + PAGE) },
                      t('next'),
                    ),
                  ),
                ),
          )

      return React.createElement(
        'div',
        { className: 'lep-state' },
        s.rendered,
        React.createElement(
          'div',
          { className: 'lep-state__meta' },
          `心境 ${s.mood.valence}/${s.mood.arousal} · 信任 ${s.relation.trust} · ${s.updatedAt}`,
        ),
        React.createElement(
          'div',
          { className: 'lep-hist' },
          React.createElement(
            'div',
            { className: 'lep-hist__head', onClick: () => setOpen(!open) },
            `${open ? '▾' : '▸'} ${t('history')}`,
          ),
          history,
        ),
      )
    }

    const dicts = {
      zh: {
        unavailable: '状态不可用',
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
      },
      en: {
        unavailable: 'State unavailable',
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
