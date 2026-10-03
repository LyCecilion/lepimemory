/**
 * 浏览器半：`conversation.input.dock` 上的角色状态面板（读宿主 `/lepimemory/state`）。
 *
 * 手写 lazy-CJS（照抄 harness 夹具 apps/web/tests/fixtures/plugins/fixture-live-client/client.js）：
 * 经 `window.__ModuleLoader__.load({ id, factory })` 注册；`id` 必须是本包的 **bare 包名**
 * （client-modules 以包名作 boot 行 id）。`require` 只能取 **平台 seed**（react 等）。
 *
 * 面板只显示**当前值**（宿主 state.json + renderState）；审计分页不在本项。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-lepimemory-state',
  factory(require) {
    const React = require('react')

    const NS = 'lepimemoryState'

    const style = document.createElement('style')
    style.dataset.plugin = '@dsh-external/dsh-lepimemory-state'
    style.textContent = [
      '.lep-state { margin: 0 auto 6px; max-width: 800px; padding: 6px 12px; font-size: 12px;',
      '  line-height: 1.5; white-space: pre-wrap; color: var(--dsw-alias-text-secondary, #8a8f98);',
      '  background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.06));',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2)); border-radius: 8px; }',
      '.lep-state__meta { margin-top: 4px; opacity: 0.75; }',
    ].join('\n')
    document.head.append(style)

    /** 面板组件：每 5s 拉一次宿主状态。 */
    function Panel({ t }) {
      const [s, setS] = React.useState(null)
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
      if (s === null) return null
      if (s.ok === false) {
        return React.createElement('div', { className: 'lep-state' }, t('unavailable'))
      }
      return React.createElement(
        'div',
        { className: 'lep-state' },
        s.rendered,
        React.createElement(
          'div',
          { className: 'lep-state__meta' },
          `心境 ${s.mood.valence}/${s.mood.arousal} · 信任 ${s.relation.trust} · ${s.updatedAt}`,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: { unavailable: '状态不可用' }, en: { unavailable: 'State unavailable' } }),
          'lepimemory-state: locale',
        )
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
