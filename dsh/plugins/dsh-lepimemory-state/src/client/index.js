/**
 * 浏览器半：右侧栏标签页的状态面板（立绘 overlay 仍在 `conversation.input.dock`）。
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
    const React = require('react');
    const ReactDOM = require('react-dom');
    // dsh 平台 seed 里的组件库（Button/Pill/Tag/Checkbox/StateDot + 图标）：
    // 面板直接用真组件，样式与全局一致，不再手搓按钮/徽章。
    const UI = require('@deepseek-ai/dsh-client-ui-primitives');
    const { Button, Checkbox, Pill, StateDot, Tag } = UI;
    // 图标在 seed 里以 `<Name>Regular` / `<Name>Medium` 形式导出（无裸名）。
    const IconArchiveOutline = UI.IconArchiveOutlineRegular;
    const IconCheckCircleOutline = UI.IconCheckCircleOutlineRegular;
    const IconChevronDownOutline = UI.IconChevronDownOutlineRegular;
    const IconChevronRightOutline = UI.IconChevronRightOutlineRegular;
    const IconDatabaseOutline = UI.IconDatabaseOutlineRegular;
    const IconEditOutline = UI.IconEditOutlineRegular;

    const NS = 'lepimemoryState';
    const PAGE = 10;
    // 右侧栏标签页：`id` 是本实现在 tab 系统的唯一身份，也是正文槽注册的 key。
    const PANEL_TAB_ID = '@dsh-external/dsh-lepimemory-state/panel';
    const PANEL_KIND = 'lepimemoryState';

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
    ];

    /**
     * 立绘差分候选表：活动 → 基调 → 候选 key（按序：首选加载失败才取下一个）。
     * idle 另有 `near`（关系亲近）候选组。所有 key 必须存在于 host 的 AVATAR_ASSETS 清单。
     */
    const AVATAR_FRAMES = {
      idle: {
        bright: ['laugh', 'celebrate', 'cheers'],
        plain: ['idle-pngtuber', 'work', 'blink'],
        low: ['daze', 'sleep', 'sweat'],
        near: ['nosetouch', 'heart', 'greet', 'rose', 'lick'],
      },
      think: {
        bright: ['think', 'idea', 'cheer'],
        plain: ['think', 'idea', 'loading'],
        low: ['clueless', 'dizzy', 'question'],
      },
      speak: {
        bright: ['glowstick', 'megaphone', 'bubble'],
        plain: ['type', 'megaphone', 'nod'],
        low: ['type-annoyed', 'type-angry', 'type'],
      },
      tool: {
        bright: ['magic', 'shades', 'knock'],
        plain: ['record', 'work', 'shades'],
        low: ['work-tired', 'work-angry', 'crowbar'],
      },
      approval: {
        bright: ['expect', 'press', 'bell'],
        plain: ['question', 'expect', 'button'],
        low: ['jailed', 'jailed1', 'nervous'],
      },
      question: {
        bright: ['expect', 'press', 'question'],
        plain: ['question', 'expect', 'button'],
        low: ['clueless', 'shocked', 'shy'],
      },
      error: {
        bright: ['clown', 'cheese'],
        plain: ['stop', 'angry', 'dead'],
        low: ['cry', 'cry2', 'trash'],
      },
    };
    /** 活动 → 候选 key 列表；idle 且关系亲近时，把近亲候选置顶。 */
    function avatarCandidates(activity, tone, near) {
      const table = AVATAR_FRAMES[activity] || AVATAR_FRAMES.idle;
      const toneList = table[tone] || table.plain;
      return activity === 'idle' && near === true ? [...table.near, ...toneList] : toneList;
    }
    /** 预热每个 (活动, 基调) 的首选帧（含 idle 的 near 首选）；列表其余项是加载失败回退，按需再取。 */
    const AVATAR_PRELOAD_KEYS = Array.from(
      new Set(
        Object.values(AVATAR_FRAMES).flatMap((table) =>
          Object.values(table).map((list) => list[0]),
        ),
      ),
    );
    const avatarSrc = (k) => '/lepimemory/avatar?key=' + encodeURIComponent(k);

    /**
     * Chat 快照 → 'tool' | 'speak' | 'think' | null。工具（未出结果）优先于助手输出。
     * 判据对齐 ui-chat ApprovalCommand：运行中的工具 root 不含 `kind`（即尚未 tool-result）；
     * 助手流只在存在 running 的 assistant-step 时才算「在想/在说」。
     */
    function deriveChatSignal(snapshot) {
      if (!snapshot || !snapshot.nodes) return null;
      let running = false,
        speaking = false;
      for (const node of snapshot.nodes.values()) {
        if (node.kind === 'tool-call') {
          const root = node.data && node.data.root;
          if (root && root.kind !== 'tool-result') return 'tool';
        } else if (node.kind === 'assistant-step' && node.data && node.data.status === 'running') {
          running = true;
          const blocks = node.data.blocks || [];
          if (blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())) speaking = true;
        }
      }
      if (!running) return null;
      return speaking ? 'speak' : 'think';
    }

    /** (SessionStatus, chatSignal, lastAgentError) → 活动枚举。审批/提问优先于一切。 */
    function resolveActivity(status, chatSignal, agentError) {
      if (status && status.pendingInteraction) {
        return status.pendingInteraction.kind === 'approval' ? 'approval' : 'question';
      }
      if (status && status.running === true) {
        if (chatSignal === 'tool') return 'tool';
        if (chatSignal === 'speak') return 'speak';
        return 'think';
      }
      if (agentError) return 'error';
      return 'idle';
    }

    /** 客户端镜像 lib/state.js 的 BASELINE（面板 meter 的基线刻度；两边同时改）。 */
    const BASELINE = { valence: 0, arousal: 0.4, trust: 0.3, closeness: 0.2, familiarity: 0.1 };

    /** 历史分组：4 组各自拥有其 kinds 子标签。 */
    const GROUPS = [
      { id: 'memory', key: 'grp_memory', kinds: ['recall', 'retain', 'forget'] },
      { id: 'action', key: 'grp_action', kinds: ['action', 'task'] },
      { id: 'why', key: 'grp_why', kinds: ['audit', 'control'] },
      { id: 'privacy', key: 'grp_privacy', kinds: ['consent'] },
    ];
    const KIND_LABEL = new Map(KINDS);

    /** 审计类型 → 「它想做什么」的人话标签（讲解优先视图用）。 */
    const INTENT_KEY = {
      audit: 'it_audit',
      recall: 'it_recall',
      retain: 'it_retain',
      forget: 'it_forget',
      action: 'it_action',
      task: 'it_task',
      control: 'it_control',
      consent: 'it_consent',
    };
    /** 候选快照正文 → 单行摘要（超长截断）；拿不到正文（如已遗忘未揭晓）返回 null。 */
    function excerptOf(node) {
      const snap = node && node.data && node.data.snapshot;
      const text = snap && typeof snap.text === 'string' ? snap.text.trim() : '';
      if (!text) return null;
      return text.length > 60 ? text.slice(0, 60) + '…' : text;
    }
    /** 分组响应与 flat 响应统一取出条目集合（供回执汇聚/候选加载复用）。 */
    function entriesOf(hist) {
      if (!hist || hist.ok !== true) return [];
      if (Array.isArray(hist.groups)) return hist.groups.flatMap((g) => g.entries);
      return Array.isArray(hist.entries) ? hist.entries : [];
    }

    /** 活动 → 状态条色配（复用现有徽章色）。 */
    const ACT_CLASS = {
      idle: 'muted',
      think: 'warn',
      speak: 'warn',
      tool: 'warn',
      approval: 'ok',
      question: 'ok',
      error: 'err',
    };

    /** 一条带基线刻度的数值 meter（valence 取 -1..1，其余 0..1）。 */
    function Meter({ label, value, lo, hi, baseline }) {
      const number = typeof value === 'number' && Number.isFinite(value);
      const clamp = (x) => Math.max(0, Math.min(100, x));
      const pct = number ? clamp(((value - lo) / (hi - lo)) * 100) : 0;
      const basePct = clamp(((baseline - lo) / (hi - lo)) * 100);
      return React.createElement(
        'span',
        { className: 'lep-meter', title: `${label} ${number ? value : '—'}` },
        React.createElement('span', { className: 'lep-meter__label' }, label),
        React.createElement(
          'span',
          { className: 'lep-meter__track' },
          React.createElement('span', {
            className: 'lep-meter__fill',
            style: { width: pct + '%' },
          }),
          React.createElement('span', {
            className: 'lep-meter__base',
            style: { left: basePct + '%' },
          }),
        ),
        React.createElement(
          'span',
          { className: 'lep-meter__value' },
          number ? value.toFixed(2) : '—',
        ),
      );
    }

    /** 一条带基线刻度的滑杆：范围输入 + 当前值（区间与提交校验一致）。 */
    function Slider({ label, value, lo, hi, step, baseline, baselineLabel, onChange }) {
      const number = typeof value === 'number' && Number.isFinite(value);
      const clamp = (x) => Math.max(0, Math.min(100, x));
      const basePct = clamp(((baseline - lo) / (hi - lo)) * 100);
      return React.createElement(
        'label',
        { className: 'lep-field lep-field--slider' },
        React.createElement('span', { className: 'lep-field__label' }, label),
        React.createElement(
          'span',
          { className: 'lep-slider' },
          React.createElement('input', {
            type: 'range',
            min: lo,
            max: hi,
            step: step || 0.01,
            value: number ? value : lo,
            onChange: (e) => onChange(Number(e.target.value)),
          }),
          React.createElement('span', {
            className: 'lep-meter__base lep-slider__tick',
            style: { left: basePct + '%' },
            title: baselineLabel,
          }),
        ),
        React.createElement(
          'span',
          { className: 'lep-field__value' },
          number ? value.toFixed(2) : '—',
        ),
      );
    }

    /** 分节标题：chevron + 图标 + 标题，点击展开/收起（对齐 dsh 的 disclosure 形）。 */
    function SectionHead({ icon: Icon, title, open, onToggle }) {
      return React.createElement(
        'div',
        {
          className: 'lep-sechead' + (open ? ' is-open' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: onToggle,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          },
        },
        React.createElement(
          'span',
          { className: 'lep-sechead__chev' },
          React.createElement(open ? IconChevronDownOutline : IconChevronRightOutline, {
            size: 14,
          }),
        ),
        Icon
          ? React.createElement(
              'span',
              { className: 'lep-sechead__icon' },
              React.createElement(Icon, { size: 15 }),
            )
          : null,
        React.createElement('span', { className: 'lep-sechead__title' }, title),
      );
    }

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
      admission: 'st_admission',
      received: 'st_received',
      retry_pending: 'st_retry_pending',
      resubmit_required: 'st_resubmit_required',
      parked: 'st_parked',
    };

    /** 正向状态（只有真正可核对完成的才配。绝不按 !skipped 推断成功）。 */
    const OK_STATUS = new Set(['written', 'reconciled', 'executed', 'applied']);
    /** 进行中/等待。 */
    const PENDING_STATUS = new Set(['pending', 'deferred', 'running', 'submitted', 'prepared']);
    /** 负向/失败。 */
    const ERR_STATUS = new Set([
      'failed',
      'rejected',
      'cancelled',
      'expired',
      'unavailable',
      'blocked',
    ]);

    /** 用 {k} 占位符做极简插值。 */
    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_m, k) =>
        k in vars ? String(vars[k]) : `{${k}}`,
      );
    }

    /** 时间戳 → 本地时间串（解析失败则原样返回）。 */
    function fmtTime(at) {
      if (!at) return '';
      const d = new Date(at);
      return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleTimeString();
    }

    /** fetch → { status, ok, body }。body 缺失/非 JSON 则回退 {}。 */
    function fetchJson(url, init) {
      return fetch(url, init).then((resp) =>
        resp
          .json()
          .catch(() => null)
          .then((body) => ({ status: resp.status, ok: resp.ok, body: body || {} })),
      );
    }

    const CSS = [
      // 面板整体：融进侧栏表面（不另起卡片），占满可用高度并作为**唯一**滚动区。
      '.lep-state { flex: 1 1 auto; min-height: 0; width: 100%; box-sizing: border-box; overflow-y: auto;',
      '  margin: 0; padding: 8px 12px 16px; font: var(--dsw-font-xs-13);',
      '  color: var(--dsw-alias-label-secondary); background: transparent; }',
      // 分节：细线分隔；首个分节不加线。标题走 dsh disclosure 形（chevron + 图标 + 标题）。
      '.lep-section { margin-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 10px; }',
      '.lep-section:first-child { margin-top: 0; border-top: none; padding-top: 0; }',
      '.lep-sechead { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;',
      '  color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-strong-13); }',
      '.lep-sechead:hover .lep-sechead__title { color: var(--dsw-alias-link); }',
      '.lep-sechead.is-static { cursor: default; }',
      '.lep-sechead__chev, .lep-sechead__icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); }',
      // 状态条：meter + 活动 Tag（含 StateDot）+ 摘要。
      '.lep-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }',
      '.lep-strip__group { display: inline-flex; align-items: center; gap: 8px; }',
      '.lep-strip__grouplabel { color: var(--dsw-alias-label-tertiary); }',
      '.lep-strip__summary { flex-basis: 100%; white-space: normal; color: var(--dsw-alias-label-secondary); }',
      '.lep-act { gap: 5px; }',
      '.lep-act__dot { display: inline-flex; }',
      '.lep-meter { display: inline-flex; align-items: center; gap: 6px; }',
      '.lep-meter__label { color: var(--dsw-alias-label-secondary); }',
      '.lep-meter__track { position: relative; display: inline-block; width: 52px; height: 6px; border-radius: var(--dsw-radius-xs);',
      '  background: var(--dsw-alias-border-l3); vertical-align: middle; }',
      '.lep-meter__fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: var(--dsw-radius-xs);',
      '  background: var(--dsw-alias-state-business-primary); }',
      '.lep-meter__base { position: absolute; top: -2px; bottom: -2px; width: 1px;',
      '  background: var(--dsw-alias-label-primary); opacity: 0.45; }',
      '.lep-meter__value { color: var(--dsw-alias-label-tertiary); min-width: 30px; }',
      '.lep-badges { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }',
      '.lep-toolbar { margin-top: 10px; display: flex; gap: 10px; align-items: center; }',
      // 历史：筛选 Pill 行 + 行列表（行内元素 flex 对齐；细节/阶段各自独占整行）。
      '.lep-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }',
      '.lep-hist__list { list-style: none; margin: 0; padding: 0; }',
      '.lep-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 5px 6px;',
      '  border-radius: var(--dsw-radius-sm); white-space: normal; }',
      '.lep-row:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.lep-row time { color: var(--dsw-alias-label-tertiary); }',
      '.lep-intent { color: var(--dsw-alias-label-primary); }',
      '.lep-excerpt { color: var(--dsw-alias-label-secondary); }',
      '.lep-excerpt::before { content: "「"; }',
      '.lep-excerpt::after { content: "」"; }',
      '.lep-rawsum { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-markdown-code-font-family); }',
      '.lep-stages { color: var(--dsw-alias-label-tertiary); }',
      '.lep-row--stage { padding-left: 16px; }',
      '.lep-row--stage:hover { background: transparent; }',
      '.lep-stages__list { flex-basis: 100%; list-style: none; margin: 2px 0 0; padding: 0; }',
      '.lep-detail { flex-basis: 100%; margin: 2px 0 6px; padding: 6px 10px; white-space: normal; border-radius: var(--dsw-radius-sm);',
      '  background: var(--dsw-alias-bg-layer-1); border-left: 2px solid var(--dsw-alias-border-l3); }',
      '.lep-rowbtn { height: 20px; padding: 0 8px; font: var(--dsw-font-xxxs-11); }',
      '.lep-hist__empty { color: var(--dsw-alias-label-tertiary); }',
      '.lep-hist__nav { display: flex; align-items: center; gap: 8px; margin-top: 10px; }',
      '.lep-pageinfo { color: var(--dsw-alias-label-tertiary); }',
      // 详情：键值 / 快照 / 表单。
      '.lep-kv { display: flex; gap: 8px; white-space: normal; }',
      '.lep-kv b { font-weight: 500; color: var(--dsw-alias-label-tertiary); min-width: 72px; }',
      '.lep-sublist { list-style: none; margin: 0; padding: 0; }',
      '.lep-sublist li { white-space: normal; }',
      '.lep-snap-text { margin: 4px 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary);',
      '  background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-sm); }',
      '.lep-form { margin: 4px 0 6px; }',
      '.lep-field { display: inline-flex; align-items: center; gap: 6px; margin: 4px 12px 4px 0; }',
      '.lep-field--slider { gap: 8px; }',
      '.lep-field__label { color: var(--dsw-alias-label-secondary); }',
      '.lep-field__value { color: var(--dsw-alias-label-tertiary); min-width: 30px; }',
      '.lep-slider { position: relative; display: inline-flex; align-items: center; }',
      '.lep-slider input[type=range] { width: 96px; margin: 0; }',
      '.lep-slider__tick { top: auto; bottom: -3px; height: 6px; }',
      '.lep-preview { margin-top: 6px; }',
      '.lep-preview__title { color: var(--dsw-alias-label-secondary); }',
      '.lep-form__actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }',
      '.lep-note { color: var(--dsw-alias-label-tertiary); }',
      '.lep-err { color: var(--dsw-alias-state-error-primary); margin-top: 4px; white-space: normal; }',
      '.lep-receipts { list-style: none; margin: 4px 0 0; padding: 0; }',
      '.lep-receipts li { color: var(--dsw-alias-label-secondary); }',
      '.lep-receipts li time { color: var(--dsw-alias-label-tertiary); margin-right: 6px; }',
      '.lep-raw__body { white-space: pre-wrap; margin-top: 6px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-markdown-code-font-family); }',
      // 立绘 overlay（仍挂在 dock，position: fixed 到视口）。
      '.lep-avatar { position: fixed; right: 14px; bottom: 14px; width: 128px; height: 128px; pointer-events: none; z-index: 35; }',
      '.lep-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 240ms ease; }',
      '.lep-avatar img.is-on { opacity: 1; }',
    ].join('\n');

    /** 状态 → 文案（legacy 记录加历史后缀；未知状态原样展示，绝不显示为成功）。 */
    function statusLabel(t, status, legacy) {
      const key = status ? STATUS_KEYS[status] : undefined;
      let label = key ? t(key) : status ? String(status) : t('st_unknown');
      if (legacy === true) label += t('legacySuffix');
      return label;
    }

    /** 状态 → 徽章配色类。 */
    function statusClass(status, legacy) {
      if (legacy === true && !OK_STATUS.has(status)) return status === 'failed' ? 'err' : 'muted';
      if (OK_STATUS.has(status)) return 'ok';
      if (PENDING_STATUS.has(status)) return 'warn';
      if (ERR_STATUS.has(status)) return 'err';
      return 'muted';
    }

    /** 状态配色类 → dsh `Tag` 的 tone。 */
    const TONE_OF = { ok: 'success', warn: 'warning', err: 'danger', muted: 'quiet' };
    const toneOf = (cls) => TONE_OF[cls] || 'neutral';

    /** 活动 → dsh `StateDot` 的状态。 */
    function activityDot(activity) {
      if (activity === 'error') return 'error';
      if (activity === 'idle') return 'idle';
      return 'ongoing';
    }

    /** 详情行（标签 + 文本值）。 */
    function kv(label, value) {
      return React.createElement(
        'div',
        { className: 'lep-kv', key: label },
        React.createElement('b', null, label),
        React.createElement('span', null, value == null || value === '' ? '—' : String(value)),
      );
    }

    /** 详情列表（每条渲染为纯文本）。 */
    function listBlock(label, arr, fmt) {
      if (!Array.isArray(arr) || arr.length === 0) return kv(label, '—');
      return React.createElement(
        'div',
        { className: 'lep-kv', key: label },
        React.createElement('b', null, label),
        React.createElement(
          'ul',
          { className: 'lep-sublist' },
          arr.map((x, i) => React.createElement('li', { key: i }, fmt(x))),
        ),
      );
    }

    function lifecycleText(l) {
      if (!l || typeof l !== 'object') return '—';
      let s = String(l.status || '?');
      if (l.purpose) s += ' · ' + l.purpose;
      if (l.grant_id) s += ' · grant ' + l.grant_id;
      if (l.confirmed_by) s += ' · ' + l.confirmed_by;
      if (l.updated_at) s += ' · ' + fmtTime(l.updated_at);
      return s;
    }

    function sourceText(s) {
      if (!s || typeof s !== 'object') return '—';
      let out = String(s.id || '?');
      if (s.actor) out += ' · ' + s.actor;
      if (s.kind) out += ' · ' + s.kind;
      if (s.session_id) out += ' · session ' + s.session_id;
      if (s.message_id) out += ' · message ' + s.message_id;
      if (s.seq != null) out += ' · seq ' + s.seq;
      if (s.block_index != null) out += ' · block ' + s.block_index + ':' + s.start + '-' + s.end;
      if (s.at) out += ' · ' + fmtTime(s.at);
      return out;
    }

    function rawText(r) {
      if (!r || typeof r !== 'object') return '—';
      let out = String(r.raw_id || '?');
      if (r.document_id) out += ' · document ' + r.document_id;
      if (r.version_hash) out += ' · ' + String(r.version_hash).slice(0, 12);
      if (r.state) out += ' · ' + r.state;
      if (r.verified_at) out += ' · ' + fmtTime(r.verified_at);
      return out;
    }

    function taskText(t, k) {
      if (!k || typeof k !== 'object') return '—';
      let out = String(k.id || '?') + ' · ' + statusLabel(t, k.status, false);
      if (k.kind) out += ' · ' + k.kind;
      if (k.error_code) out += ' · ' + k.error_code;
      return out;
    }

    function opText(o) {
      if (!o || typeof o !== 'object') return '—';
      return (
        String(o.operation_id || '?') +
        ' · task ' +
        String(o.task_id || '?') +
        ' · ' +
        String(o.status || '?')
      );
    }

    function grantText(g) {
      if (!g || typeof g !== 'object') return '—';
      let out = String(g.id || '?');
      if (g.scope != null)
        out += ' · ' + (typeof g.scope === 'string' ? g.scope : JSON.stringify(g.scope));
      if (g.expires_at) out += ' · exp ' + fmtTime(g.expires_at);
      if (g.revoked_at) out += ' · revoked ' + fmtTime(g.revoked_at);
      if (g.allow_inference != null) out += ' · inference=' + String(g.allow_inference);
      return out;
    }

    /**
     * 面板/立绘共享的 /lepimemory/state 轮询源（ObservableSnapshot 形状）。
     * 首个订阅者出现时开始 5s 轮询，最后一个离开时停止；两处 UI 共用同一份快照。
     */
    function createStateFeed() {
      const listeners = new Set();
      let snap = { phase: 'loading', body: null };
      let timer = null,
        ctrl = null,
        seq = 0;
      const emit = () => {
        for (const fn of listeners) fn();
      };
      const load = () => {
        const my = ++seq;
        if (ctrl) ctrl.abort();
        ctrl = new AbortController();
        fetchJson('/lepimemory/state', { signal: ctrl.signal })
          .then((r) => {
            if (my !== seq) return;
            if (r.status === 401 || r.status === 403) {
              snap = { phase: 'forbidden', body: null };
              emit();
              return;
            }
            if (!r.ok || r.body.ok === false) {
              snap = { phase: 'error', body: null };
              emit();
              return;
            }
            snap = { phase: 'ok', body: r.body };
            emit();
          })
          .catch((err) => {
            if (my === seq && err.name !== 'AbortError') {
              snap = { phase: 'error', body: null };
              emit();
            }
          });
      };
      return {
        getSnapshot: () => snap,
        refresh: load,
        subscribe(fn) {
          listeners.add(fn);
          if (!timer) {
            load();
            timer = setInterval(load, 5000);
          }
          return () => {
            listeners.delete(fn);
            if (!listeners.size) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
      };
    }

    /** 面板组件：状态经共享 feed 刷新；历史面板可折叠、按 kind 切换、翻页；支持详情/重试/操作者编辑。 */
    function Panel({
      t,
      useLepState,
      refreshLepState,
      sessionId,
      useSessionStatus,
      useSession,
      useChat,
    }) {
      const [s, setS] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [group, setGroup] = React.useState('memory');
      const [kind, setKind] = React.useState('recall');
      const [offset, setOffset] = React.useState(0);
      const [hist, setHist] = React.useState(null);
      const [histTick, setHistTick] = React.useState(0);
      const [expanded, setExpanded] = React.useState({});
      const [cand, setCand] = React.useState({});
      const [editorOpen, setEditorOpen] = React.useState(false);
      const [rawOpen, setRawOpen] = React.useState(false);
      const [form, setForm] = React.useState(null);
      const [formError, setFormError] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [preview, setPreview] = React.useState(null);
      const [debug, setDebug] = React.useState(false);
      const [retrying, setRetrying] = React.useState({});
      const [receipts, setReceipts] = React.useState([]);

      const mounted = React.useRef(true);
      const candAbort = React.useRef(new Map());
      const receiptsRef = React.useRef(new Map());
      const privateEpoch = React.useRef(0);

      // 活动信号：审批/提问 > 运行中（tool/speak/think）> 出错 > 待机。
      const status = useSessionStatus((map) => (sessionId ? map.get(sessionId) : undefined));
      const agentError = useSession((sess) => (sess ? sess.lastAgentError : null));
      const useChatSafe = typeof useChat === 'function' ? useChat : () => null;
      const chatSignal = useChatSafe((cs) => deriveChatSignal(cs));
      const activity = resolveActivity(status, chatSignal, agentError);

      function clearPrivate() {
        privateEpoch.current += 1;
        candAbort.current.forEach((controller) => controller.abort());
        candAbort.current.clear();
        receiptsRef.current.clear();
        setS({ ok: false, forbidden: true });
        setHist({ ok: false, forbidden: true });
        setCand({});
        setExpanded({});
        setReceipts([]);
        setForm(null);
        setEditorOpen(false);
        setFormError('');
        setSaving(false);
        setRetrying({});
      }

      // 样式元素绑定组件生命周期：挂载创建、卸载/hot-reload 移除；不残留旧副本。
      React.useEffect(() => {
        const stale = document.querySelectorAll(
          'style[data-plugin="@dsh-external/dsh-lepimemory-state"]',
        );
        stale.forEach((n) => n.remove());
        const style = document.createElement('style');
        style.dataset.plugin = '@dsh-external/dsh-lepimemory-state';
        style.textContent = CSS;
        document.head.append(style);
        return () => {
          style.remove();
        };
      }, []);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          candAbort.current.forEach((c) => c.abort());
          candAbort.current.clear();
        };
      }, []);

      // 状态来自共享 feed（与立绘同一份快照）；错误/未授权按旧语义映射，首次 loading 保持不可见。
      const feed = useLepState((st) => st);
      React.useEffect(() => {
        if (feed.phase === 'forbidden') {
          clearPrivate();
          return;
        }
        if (feed.phase === 'loading') return;
        if (feed.phase === 'ok') {
          setS(feed.body);
          return;
        }
        setS({ ok: false });
      }, [feed]);

      // 折叠时也读取最新审计回执；展开后按 kind/offset 分页，序号阻止陈旧响应。
      // 默认走 host 分组（以组为单位分页）；debug 走 flat 逐条审计。
      React.useEffect(() => {
        setHist(null);
        const selectedKind = open ? kind : 'audit';
        const selectedOffset = open ? offset : 0;
        const ctrl = new AbortController();
        let alive = true;
        let seq = 0;
        const url = `/lepimemory/history?kind=${encodeURIComponent(selectedKind)}&limit=${PAGE}&offset=${selectedOffset}${debug ? '' : '&grouped=1'}`;
        const load = () => {
          const my = ++seq;
          const epoch = privateEpoch.current;
          fetchJson(url, { signal: ctrl.signal })
            .then((r) => {
              if (!alive || my !== seq || epoch !== privateEpoch.current) return;
              if (r.status === 401 || r.status === 403) {
                clearPrivate();
                return;
              }
              if (!r.ok || r.body.ok === false) {
                setHist({ ok: false });
                return;
              }
              const body = r.body;
              const groups = Array.isArray(body.groups) ? body.groups : null;
              const entries = Array.isArray(body.entries) ? body.entries : [];
              setHist({
                ok: true,
                kind: body.kind || selectedKind,
                grouped: !!groups,
                total:
                  typeof body.total === 'number'
                    ? body.total
                    : groups
                      ? groups.length
                      : entries.length,
                offset: typeof body.offset === 'number' ? body.offset : selectedOffset,
                limit: typeof body.limit === 'number' ? body.limit : PAGE,
                entries,
                groups,
              });
            })
            .catch((err) => {
              if (
                alive &&
                my === seq &&
                epoch === privateEpoch.current &&
                err.name !== 'AbortError'
              )
                setHist({ ok: false });
            });
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
          alive = false;
          ctrl.abort();
          clearInterval(timer);
        };
      }, [open, kind, offset, histTick, debug]);

      // 从历史记录汇聚系统回执：按 audit/request/task ID 去重（不触发任何模型调用）。
      React.useEffect(() => {
        if (!hist || hist.ok !== true) return;
        let changed = false;
        for (const e of entriesOf(hist)) {
          const type = e.type;
          if (
            type !== 'control' &&
            type !== 'consent' &&
            type !== 'task' &&
            type !== 'retain' &&
            type !== 'forget' &&
            type !== 'action'
          )
            continue;
          const key = e.task_id
            ? `task:${e.task_id}`
            : e.request_id
              ? `request:${e.request_id}`
              : `audit:${e.id}`;
          const previous = receiptsRef.current.get(key);
          if (previous && previous.auditId >= e.id) continue;
          receiptsRef.current.set(key, {
            key,
            at: e.at,
            auditId: e.id,
            text: `${INTENT_KEY[type] ? t(INTENT_KEY[type]) : type} · ${statusLabel(t, e.status, e.data && e.data.legacy)}`,
          });
          changed = true;
        }
        if (changed) publishReceipts();
      }, [hist, t]);

      // 详情/正文摘要随真实历史轮询刷新；不能永久缓存遗忘前的正文或旧任务状态。
      React.useEffect(() => {
        const visible = new Set();
        if (open && hist && hist.ok === true) {
          for (const e of entriesOf(hist)) {
            if (e.candidate_id) visible.add(e.candidate_id); // 行内正文摘要（默认视图）
            if (expanded[`e${e.id}`])
              for (const chain of e.data?.chains || []) {
                for (const source of chain.sources || []) {
                  if (source.candidate_id && expanded[`c${e.id}-${source.candidate_id}`])
                    visible.add(source.candidate_id);
                }
              }
          }
        }
        for (const [id, controller] of candAbort.current) {
          if (!visible.has(id)) {
            controller.abort();
            candAbort.current.delete(id);
          }
        }
        for (const id of visible) loadCandidate(id, !!(cand[id] && cand[id].revealed));
      }, [open, hist, expanded]);

      function publishReceipts() {
        const latest = Array.from(receiptsRef.current.values())
          .sort((a, b) => b.at - a.at)
          .slice(0, PAGE);
        receiptsRef.current = new Map(latest.map((r) => [r.key, r]));
        setReceipts(latest);
      }

      function addReceipt(key, at, text) {
        receiptsRef.current.set(key, { key, at, text });
        publishReceipts();
      }

      function loadCandidate(id, reveal) {
        const ctrl = new AbortController();
        const prevCtrl = candAbort.current.get(id);
        if (prevCtrl) prevCtrl.abort();
        candAbort.current.set(id, ctrl);
        // 静默刷新：已有可用数据时不回落到 loading，避免轮询每 5s 把行内正文闪断一次。
        setCand((prev) => {
          const prior = prev[id];
          if (prior && prior.ok === true) return prev;
          return { ...prev, [id]: { loading: true, forbidden: false } };
        });
        const url = `/lepimemory/candidate?id=${encodeURIComponent(id)}${reveal ? '&reveal=1' : ''}`;
        fetchJson(url, { signal: ctrl.signal })
          .then((r) => {
            if (candAbort.current.get(id) !== ctrl) return;
            candAbort.current.delete(id);
            if (!mounted.current) return;
            if (r.status === 401 || r.status === 403) {
              clearPrivate();
              return;
            }
            if (!r.ok || r.body.ok === false) {
              setCand((prev) => ({ ...prev, [id]: { ok: false, error: true } }));
              return;
            }
            setCand((prev) => ({ ...prev, [id]: { ok: true, data: r.body, revealed: !!reveal } }));
          })
          .catch((err) => {
            if (err.name === 'AbortError') return;
            if (candAbort.current.get(id) !== ctrl) return;
            candAbort.current.delete(id);
            if (!mounted.current) return;
            setCand((prev) => ({ ...prev, [id]: { ok: false, error: true } }));
          });
      }

      function toggleEntry(key, e) {
        setExpanded((prev) => {
          const next = { ...prev };
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
        if (e.candidate_id)
          setCand((prev) => {
            const next = { ...prev };
            delete next[e.candidate_id];
            return next;
          });
      }

      function doRetry(retryKind, id) {
        const btnKey = `${retryKind}:${id}`;
        const epoch = privateEpoch.current;
        setRetrying((prev) => ({ ...prev, [btnKey]: true }));
        fetchJson('/lepimemory/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: retryKind, id }),
        })
          .then((r) => {
            if (!mounted.current || epoch !== privateEpoch.current) return;
            setRetrying((prev) => ({ ...prev, [btnKey]: false }));
            if (r.status === 401 || r.status === 403) {
              clearPrivate();
              return;
            }
            if (r.status === 404) {
              addReceipt(`retry:${btnKey}`, Date.now(), t('retryNotFound'));
              return;
            }
            if (r.status === 409) {
              const resubmit = r.body && r.body.code === 'LEPI_INPUT_RESUBMIT_REQUIRED';
              addReceipt(
                `retry:${btnKey}`,
                Date.now(),
                resubmit ? t('retryResubmit') : t('retryForbidden'),
              );
              return;
            }
            if (!r.ok || r.body.ok === false) {
              addReceipt(`retry:${btnKey}`, Date.now(), t('retryFailed'));
              return;
            }
            const doneId = r.body.request_id || r.body.task_id || r.body.id || id;
            addReceipt(`${retryKind}:${doneId}`, Date.now(), t('retryQueued'));
            setHistTick((x) => x + 1);
          })
          .catch(() => {
            if (!mounted.current || epoch !== privateEpoch.current) return;
            setRetrying((prev) => ({ ...prev, [btnKey]: false }));
            addReceipt(`retry:${btnKey}`, Date.now(), t('retryFailed'));
          });
      }

      // 操作者编辑：打开时以当前状态为初值（避免 5s 轮询覆盖正在编辑的字段）。
      React.useEffect(() => {
        if (!editorOpen) return;
        if (!s || s.ok === false || !s.mood || !s.relation) return;
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '');
        setForm({
          mood: { valence: num(s.mood.valence), arousal: num(s.mood.arousal) },
          relation: {
            trust: num(s.relation.trust),
            closeness: num(s.relation.closeness),
            familiarity: num(s.relation.familiarity),
          },
        });
        setFormError('');
      }, [editorOpen]);

      // 语气预览：防抖 250ms + AbortController 调 `?preview=1`（只读 dry-run，绝不落库/写审计）。
      React.useEffect(() => {
        if (!editorOpen || !form) {
          setPreview(null);
          return;
        }
        const values = [
          form.mood.valence,
          form.mood.arousal,
          form.relation.trust,
          form.relation.closeness,
          form.relation.familiarity,
        ];
        if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
          setPreview({ failed: true });
          return;
        }
        const body = JSON.stringify({
          mood: { valence: form.mood.valence, arousal: form.mood.arousal },
          relation: {
            trust: form.relation.trust,
            closeness: form.relation.closeness,
            familiarity: form.relation.familiarity,
          },
        });
        const ctrl = new AbortController();
        let alive = true;
        const timer = setTimeout(() => {
          fetchJson('/lepimemory/state?preview=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: ctrl.signal,
          })
            .then((r) => {
              if (!alive) return;
              if (r.ok && r.body && r.body.ok === true && r.body.preview === true) {
                setPreview({ rendered: r.body.rendered, tone: r.body.tone || 'plain' });
              } else {
                setPreview({ failed: true });
              }
            })
            .catch((err) => {
              if (alive && err.name !== 'AbortError') setPreview({ failed: true });
            });
        }, 250);
        return () => {
          alive = false;
          clearTimeout(timer);
          ctrl.abort();
        };
      }, [form, editorOpen]);

      function submitState(ev) {
        ev.preventDefault();
        if (!form) return;
        const fields = [
          ['valence', form.mood.valence, -1, 1],
          ['arousal', form.mood.arousal, 0, 1],
          ['trust', form.relation.trust, 0, 1],
          ['closeness', form.relation.closeness, 0, 1],
          ['familiarity', form.relation.familiarity, 0, 1],
        ];
        for (const [name, v, lo, hi] of fields) {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
            setFormError(fill(t('formRange'), { field: name, lo, hi }));
            return;
          }
        }
        setFormError('');
        setSaving(true);
        const epoch = privateEpoch.current;
        // 精确 payload：只有数值字段。原因是 host 固定的「操作者调整演示状态」，不由前端提交。
        fetchJson('/lepimemory/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mood: { valence: form.mood.valence, arousal: form.mood.arousal },
            relation: {
              trust: form.relation.trust,
              closeness: form.relation.closeness,
              familiarity: form.relation.familiarity,
            },
          }),
        })
          .then((r) => {
            if (!mounted.current || epoch !== privateEpoch.current) return;
            setSaving(false);
            if (r.status === 401 || r.status === 403) {
              clearPrivate();
              return;
            }
            if (!r.ok || r.body.ok === false) {
              setFormError(t('saveFailed'));
              return;
            }
            const idKey =
              r.body.audit_id != null
                ? r.body.audit_id
                : r.body.id != null
                  ? r.body.id
                  : r.body.request_id;
            addReceipt(
              idKey != null ? `audit:${idKey}` : `state:${Date.now()}`,
              Date.now(),
              `${t('opCauseFixed')} · ${fmtTime(r.body.updatedAt || Date.now())}`,
            );
            if (refreshLepState) refreshLepState();
          })
          .catch(() => {
            if (mounted.current && epoch === privateEpoch.current) {
              setSaving(false);
              setFormError(t('saveFailed'));
            }
          });
      }

      function renderCandidate(id) {
        const c = cand[id];
        if (!c) return null;
        if (c.loading) return React.createElement('div', { className: 'lep-kv' }, t('candLoading'));
        if (c.forbidden)
          return React.createElement('div', { className: 'lep-kv' }, t('candForbidden'));
        if (!c.ok) return React.createElement('div', { className: 'lep-kv' }, t('candFailed'));
        const d = c.data;
        const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null;
        const text = snap && typeof snap.text === 'string' ? snap.text : null;
        const snapBlock = React.createElement(
          'div',
          { key: 'snapshot' },
          kv(
            t('snapshot'),
            snap
              ? `${snap.payload_hash ? String(snap.payload_hash).slice(0, 12) : '—'} · ${fmtTime(snap.created_at)}`
              : '—',
          ),
          text
            ? React.createElement('div', { className: 'lep-snap-text' }, text)
            : React.createElement(
                'div',
                null,
                React.createElement(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'sm',
                    className: 'lep-rowbtn',
                    onClick: () => loadCandidate(id, true),
                  },
                  t('reveal'),
                ),
              ),
          c.revealed
            ? React.createElement(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  className: 'lep-rowbtn',
                  onClick: () => loadCandidate(id, false),
                },
                t('revealHide'),
              )
            : null,
        );
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
        );
      }

      function renderRecall(data, entryId) {
        if (!Array.isArray(data?.chains)) return null;
        const selected = new Set((data.picked || []).flatMap((item) => item.raw_ids || []));
        return React.createElement(
          'div',
          { className: 'lep-sources' },
          data.chains.map((chain, i) =>
            React.createElement(
              'div',
              { key: i, className: 'lep-detail' },
              kv(t('refObservation'), chain.observation_id || '—'),
              (chain.sources || []).map((source, j) => {
                const candidateKey = `c${entryId}-${source.candidate_id}`;
                const excluded = (data.excluded || []).find((item) => item.id === source.raw_id);
                return React.createElement(
                  'div',
                  { key: j, className: 'lep-detail' },
                  kv(t('refRaw'), source.raw_id),
                  kv(t('refCandidate'), source.candidate_id || '—'),
                  kv(t('refEvidence'), (source.evidence_ids || []).join(' · ') || '—'),
                  kv(
                    t('refVerdict'),
                    selected.has(source.raw_id)
                      ? t('recallSelected')
                      : excluded?.code || t('recallNotSelected'),
                  ),
                  source.candidate_id
                    ? React.createElement(
                        Button,
                        {
                          variant: 'ghost',
                          size: 'sm',
                          className: 'lep-rowbtn',
                          onClick: () =>
                            toggleEntry(candidateKey, { candidate_id: source.candidate_id }),
                        },
                        expanded[candidateKey] ? t('collapse') : t('detail'),
                      )
                    : null,
                  source.candidate_id && expanded[candidateKey]
                    ? renderCandidate(source.candidate_id)
                    : null,
                );
              }),
            ),
          ),
          listBlock(
            t('recallExcluded'),
            data.excluded,
            (item) =>
              `${item.id} · ${item.code}${item.observation_id ? ` · ${t('refObservation')} ${item.observation_id}` : ''}`,
          ),
        );
      }

      /** 一条 entry 的来源引用与重试按钮（溯源块的内容）。 */
      function buildRefs(e) {
        const refs = [];
        const pushRef = (label, value) => {
          if (value != null && value !== '') refs.push(kv(label, value));
        };
        pushRef(t('refSession'), e.session_id);
        pushRef(t('refTurn'), e.turn);
        pushRef(t('refStep'), e.step);
        pushRef(t('refCall'), e.call_id);
        pushRef(t('refRequest'), e.request_id);
        pushRef(t('refTask'), e.task_id);
        pushRef(t('refCandidate'), e.candidate_id);
        pushRef(t('refOperation'), e.operation_id);
        pushRef(t('refAction'), e.data?.action_id);
        for (const call of e.data?.action_calls || []) {
          refs.push(
            React.createElement(
              'div',
              { key: call.action_id },
              kv(t('refAction'), call.action_id),
              kv(t('refStep'), call.step),
              kv(t('refCall'), call.call_id),
            ),
          );
        }
        const code = e.data && (e.data.code || e.data.error_code || e.data.reason_code);
        if (code != null) refs.push(kv(t('refCode'), code));
        if (e.type === 'retain' && e.status === 'admission' && e.data) {
          pushRef(t('refBackend'), e.data.backend);
          pushRef(t('refVerdict'), e.data.verdict);
          pushRef(t('refScore'), e.data.score);
          pushRef(t('refModel'), e.data.model);
          pushRef(t('refRevision'), e.data.revision);
          pushRef(t('refTruncated'), e.data.truncated);
        }
        const retryButtons = [];
        if (e.request_id)
          retryButtons.push(
            React.createElement(
              Button,
              {
                key: 'rq',
                variant: 'outline',
                size: 'sm',
                className: 'lep-rowbtn',
                disabled: !!retrying[`request:${e.request_id}`],
                onClick: () => doRetry('request', e.request_id),
              },
              t('retryRequest'),
            ),
          );
        if (e.task_id)
          retryButtons.push(
            React.createElement(
              Button,
              {
                key: 'tk',
                variant: 'outline',
                size: 'sm',
                className: 'lep-rowbtn',
                disabled: !!retrying[`task:${e.task_id}`],
                onClick: () => doRetry('task', e.task_id),
              },
              t('retryTask'),
            ),
          );
        return {
          refs,
          retryButtons,
          hasDetail: refs.length > 0 || !!e.candidate_id || retryButtons.length > 0,
        };
      }
      /** 一条 entry 的完整溯源块：来源引用 + 候选快照/生命周期 + 回忆来源链 + 重试。 */
      function detailBlock(e, built) {
        return React.createElement(
          'div',
          { className: 'lep-detail' },
          built.refs,
          e.candidate_id ? renderCandidate(e.candidate_id) : null,
          renderRecall(e.data, e.id),
          built.retryButtons,
        );
      }

      function renderEntry(e, i) {
        const key = e.id != null ? `e${e.id}` : `${e.at}-${i}`;
        const isOpen = !!expanded[key];
        const legacy = !!(e.data && e.data.legacy);
        const built = buildRefs(e);
        const intent = INTENT_KEY[e.type] ? t(INTENT_KEY[e.type]) : e.type || '';
        const excerpt = e.candidate_id ? excerptOf(cand[e.candidate_id]) : null;
        return React.createElement(
          'li',
          { key, className: 'lep-row' },
          React.createElement('time', null, fmtTime(e.at)),
          React.createElement('span', { className: 'lep-intent' }, intent),
          React.createElement(
            Tag,
            { tone: toneOf(statusClass(e.status, legacy)) },
            statusLabel(t, e.status, legacy),
          ),
          excerpt ? React.createElement('span', { className: 'lep-excerpt' }, excerpt) : null,
          debug ? React.createElement('span', { className: 'lep-rawsum' }, e.summary || '') : null,
          built.hasDetail
            ? React.createElement(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  className: 'lep-rowbtn',
                  onClick: () => toggleEntry(key, e),
                },
                isOpen ? t('collapse') : t('detail'),
              )
            : null,
          isOpen ? detailBlock(e, built) : null,
        );
      }

      /** 折叠行内的一条「阶段」：时间 · 状态 · 意图 + 自己的「详情」（溯源/重试，不带 ID 噪音在主行）。 */
      function renderStage(e, i) {
        const key = e.id != null ? `e${e.id}` : `${e.at}-${i}`;
        const isOpen = !!expanded[key];
        const legacy = !!(e.data && e.data.legacy);
        const built = buildRefs(e);
        return React.createElement(
          'li',
          { key, className: 'lep-row lep-row--stage' },
          React.createElement('time', null, fmtTime(e.at)),
          React.createElement(
            Tag,
            { tone: toneOf(statusClass(e.status, legacy)) },
            statusLabel(t, e.status, legacy),
          ),
          React.createElement(
            'span',
            { className: 'lep-intent' },
            INTENT_KEY[e.type] ? t(INTENT_KEY[e.type]) : e.type || '',
          ),
          built.hasDetail
            ? React.createElement(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  className: 'lep-rowbtn',
                  onClick: () => toggleEntry(key, e),
                },
                isOpen ? t('collapse') : t('detail'),
              )
            : null,
          isOpen ? detailBlock(e, built) : null,
        );
      }

      /** 讲解优先：host 已按主体分组，一行一组；展开看每个阶段（超限时提示截断）。 */
      function renderGroup(entries, groupKey, truncated) {
        const head = entries[0];
        const key = `grp:${groupKey}`;
        const isOpen = !!expanded[key];
        const legacy = !!(head.data && head.data.legacy);
        const intent = INTENT_KEY[head.type] ? t(INTENT_KEY[head.type]) : head.type || '';
        const excerpt = head.candidate_id ? excerptOf(cand[head.candidate_id]) : null;
        const seq = [];
        for (const e of [...entries].reverse()) {
          const lbl = statusLabel(t, e.status, !!(e.data && e.data.legacy));
          if (seq[seq.length - 1] !== lbl) seq.push(lbl);
        }
        const collapsed = entries.length > 1;
        return React.createElement(
          'li',
          { key, className: 'lep-row' },
          React.createElement('time', null, fmtTime(head.at)),
          React.createElement('span', { className: 'lep-intent' }, intent),
          React.createElement(
            Tag,
            { tone: toneOf(statusClass(head.status, legacy)) },
            statusLabel(t, head.status, legacy),
          ),
          excerpt ? React.createElement('span', { className: 'lep-excerpt' }, excerpt) : null,
          collapsed
            ? React.createElement('span', { className: 'lep-stages' }, seq.join(' › '))
            : null,
          collapsed ? React.createElement(Tag, { tone: 'quiet' }, `×${entries.length}`) : null,
          React.createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: 'lep-rowbtn',
              onClick: () => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })),
            },
            isOpen ? t('collapse') : t('detail'),
          ),
          isOpen
            ? React.createElement(
                'ul',
                { className: 'lep-stages__list' },
                // 阶段按「旧→新」自上而下读，与组头的 `A › B › C` 链同向；被截断的最旧阶段在最上方。
                truncated === true
                  ? React.createElement(
                      'li',
                      { key: 'truncated', className: 'lep-note' },
                      t('stagesTruncated'),
                    )
                  : null,
                [...entries].reverse().map((e, i) => renderStage(e, i)),
              )
            : null,
        );
      }

      if (s === null) return null;
      if (s.ok === false) {
        return React.createElement(
          'div',
          { className: 'lep-state' },
          s.forbidden ? t('forbidden') : t('unavailable'),
        );
      }

      const total = hist && hist.ok === true ? hist.total : 0;
      const pages = Math.max(1, Math.ceil(total / PAGE));
      const page = Math.floor(offset / PAGE) + 1;
      // 切换 debug 后、effect 重取数前会先用**上一种**响应渲染：此刻 hist 仍是旧形状
      // （flat 响应没有 groups，grouped 响应的 entries 为空数组）。两种形状都必须安全取用。
      const groups = Array.isArray(hist && hist.groups) ? hist.groups : [];
      const entries = Array.isArray(hist && hist.entries) ? hist.entries : [];

      const moodMeters = React.createElement(
        'span',
        { className: 'lep-strip__group' },
        React.createElement('span', { className: 'lep-strip__grouplabel' }, t('mood')),
        React.createElement(Meter, {
          label: t('valence'),
          value: s.mood ? s.mood.valence : undefined,
          lo: -1,
          hi: 1,
          baseline: BASELINE.valence,
        }),
        React.createElement(Meter, {
          label: t('arousal'),
          value: s.mood ? s.mood.arousal : undefined,
          lo: 0,
          hi: 1,
          baseline: BASELINE.arousal,
        }),
      );
      const relationMeters = React.createElement(
        'span',
        { className: 'lep-strip__group' },
        React.createElement('span', { className: 'lep-strip__grouplabel' }, t('relation')),
        React.createElement(Meter, {
          label: t('trust'),
          value: s.relation ? s.relation.trust : undefined,
          lo: 0,
          hi: 1,
          baseline: BASELINE.trust,
        }),
        React.createElement(Meter, {
          label: t('closeness'),
          value: s.relation ? s.relation.closeness : undefined,
          lo: 0,
          hi: 1,
          baseline: BASELINE.closeness,
        }),
        React.createElement(Meter, {
          label: t('familiarity'),
          value: s.relation ? s.relation.familiarity : undefined,
          lo: 0,
          hi: 1,
          baseline: BASELINE.familiarity,
        }),
      );
      const tone = s.tone || 'plain';
      const near = s.near === true;
      const activityClass = ACT_CLASS[activity] || 'muted';
      const summary =
        t('strip_now') +
        '：' +
        t('tone_' + tone) +
        (near ? ' · ' + t('rel_near') : '') +
        ' · ' +
        t('act_' + activity);
      const strip = React.createElement(
        'div',
        { className: 'lep-strip' },
        moodMeters,
        relationMeters,
        React.createElement(
          Tag,
          { tone: toneOf(activityClass), className: 'lep-act' },
          React.createElement(
            'span',
            { className: 'lep-act__dot' },
            React.createElement(StateDot, { state: activityDot(activity), size: 8 }),
          ),
          t('act_' + activity),
        ),
        React.createElement('div', { className: 'lep-strip__summary' }, summary),
      );

      const counts = s.counts || {};
      const badges = [
        [t('badge_memories'), (counts.lifecycle && counts.lifecycle.active) || 0],
        [
          t('badge_tasks'),
          ((counts.tasks && counts.tasks.queued) || 0) +
            ((counts.tasks && counts.tasks.running) || 0),
        ],
        [t('badge_grants'), (counts.grants && counts.grants.active) || 0],
      ];
      const badgesBlock = React.createElement(
        'div',
        { className: 'lep-badges' },
        badges.map(([label, n]) =>
          React.createElement(Tag, { key: label, tone: 'neutral' }, `${label} ${n}`),
        ),
        s.core === false ? React.createElement(Tag, { tone: 'danger' }, t('badge_core_bad')) : null,
      );

      const rawBlock = React.createElement(
        'div',
        { className: 'lep-section' },
        React.createElement(SectionHead, {
          icon: IconDatabaseOutline,
          title: t('stateRaw'),
          open: rawOpen,
          onToggle: () => setRawOpen((v) => !v),
        }),
        rawOpen ? React.createElement('div', { className: 'lep-raw__body' }, s.rendered) : null,
      );

      const receiptsBlock = receipts.length
        ? React.createElement(
            'div',
            { className: 'lep-section' },
            React.createElement(
              'div',
              { className: 'lep-sechead is-static' },
              React.createElement(
                'span',
                { className: 'lep-sechead__icon' },
                React.createElement(IconCheckCircleOutline, { size: 15 }),
              ),
              React.createElement('span', { className: 'lep-sechead__title' }, t('receipts')),
            ),
            React.createElement(
              'ul',
              { className: 'lep-receipts' },
              receipts.map((r) =>
                React.createElement(
                  'li',
                  { key: r.key },
                  React.createElement('time', null, fmtTime(r.at)),
                  r.text,
                ),
              ),
            ),
          )
        : null;

      const history = !open
        ? null
        : React.createElement(
            'div',
            { className: 'lep-hist__body' },
            React.createElement(
              'div',
              { className: 'lep-tabs' },
              GROUPS.map((g) =>
                React.createElement(
                  Pill,
                  {
                    key: g.id,
                    active: g.id === group,
                    onClick: () => {
                      setGroup(g.id);
                      setKind(g.kinds[0]);
                      setOffset(0);
                    },
                  },
                  t(g.key),
                ),
              ),
            ),
            React.createElement(
              'div',
              { className: 'lep-tabs' },
              (GROUPS.find((g) => g.id === group) || GROUPS[0]).kinds.map((k) =>
                React.createElement(
                  Pill,
                  {
                    key: k,
                    active: k === kind,
                    onClick: () => {
                      setKind(k);
                      setOffset(0);
                    },
                  },
                  t(KIND_LABEL.get(k) || k),
                ),
              ),
            ),
            hist === null || hist.ok !== true
              ? React.createElement(
                  'div',
                  { className: 'lep-hist__empty' },
                  hist && hist.forbidden ? t('forbidden') : t('unavailable'),
                )
              : React.createElement(
                  'div',
                  null,
                  (debug ? entries.length === 0 : groups.length === 0)
                    ? React.createElement('div', { className: 'lep-hist__empty' }, t('empty'))
                    : React.createElement(
                        'ul',
                        { className: 'lep-hist__list' },
                        debug
                          ? entries.map((e, i) => renderEntry(e, i))
                          : groups.map((g) => renderGroup(g.entries, g.key, g.truncated)),
                      ),
                  React.createElement(
                    'div',
                    { className: 'lep-hist__nav' },
                    React.createElement(
                      Button,
                      {
                        variant: 'outline',
                        size: 'sm',
                        disabled: offset <= 0,
                        onClick: () => setOffset(Math.max(0, offset - PAGE)),
                      },
                      t('prev'),
                    ),
                    React.createElement(
                      'span',
                      { className: 'lep-pageinfo' },
                      fill(debug ? t('pageOf') : t('pageOfGroups'), {
                        p: page,
                        q: pages,
                        n: total,
                      }),
                    ),
                    React.createElement(
                      Button,
                      {
                        variant: 'outline',
                        size: 'sm',
                        disabled: offset + PAGE >= total,
                        onClick: () => setOffset(offset + PAGE),
                      },
                      t('next'),
                    ),
                  ),
                ),
          );

      const previewBlock = React.createElement(
        'div',
        { className: 'lep-preview' },
        React.createElement('div', { className: 'lep-preview__title' }, t('ed_preview')),
        !editorOpen || !form || preview == null
          ? React.createElement('div', { className: 'lep-note' }, t('ed_previewing'))
          : preview.failed
            ? React.createElement('div', { className: 'lep-err' }, t('ed_preview_failed'))
            : React.createElement(
                'div',
                null,
                React.createElement('div', { className: 'lep-note' }, t('tone_' + preview.tone)),
                React.createElement('div', { className: 'lep-raw__body' }, preview.rendered),
              ),
      );

      const editor = React.createElement(
        'div',
        { className: 'lep-section' },
        React.createElement(SectionHead, {
          icon: IconEditOutline,
          title: t('opTitle'),
          open: editorOpen,
          onToggle: () => setEditorOpen(!editorOpen),
        }),
        editorOpen && form
          ? React.createElement(
              'form',
              { className: 'lep-form', onSubmit: submitState },
              React.createElement('div', { className: 'lep-note' }, t('ed_hint')),
              React.createElement(Slider, {
                label: t('valence'),
                value: form.mood.valence,
                lo: -1,
                hi: 1,
                baseline: BASELINE.valence,
                baselineLabel: t('baseline'),
                onChange: (v) => setForm((f) => ({ ...f, mood: { ...f.mood, valence: v } })),
              }),
              React.createElement(Slider, {
                label: t('arousal'),
                value: form.mood.arousal,
                lo: 0,
                hi: 1,
                baseline: BASELINE.arousal,
                baselineLabel: t('baseline'),
                onChange: (v) => setForm((f) => ({ ...f, mood: { ...f.mood, arousal: v } })),
              }),
              React.createElement(Slider, {
                label: t('trust'),
                value: form.relation.trust,
                lo: 0,
                hi: 1,
                baseline: BASELINE.trust,
                baselineLabel: t('baseline'),
                onChange: (v) => setForm((f) => ({ ...f, relation: { ...f.relation, trust: v } })),
              }),
              React.createElement(Slider, {
                label: t('closeness'),
                value: form.relation.closeness,
                lo: 0,
                hi: 1,
                baseline: BASELINE.closeness,
                baselineLabel: t('baseline'),
                onChange: (v) =>
                  setForm((f) => ({ ...f, relation: { ...f.relation, closeness: v } })),
              }),
              React.createElement(Slider, {
                label: t('familiarity'),
                value: form.relation.familiarity,
                lo: 0,
                hi: 1,
                baseline: BASELINE.familiarity,
                baselineLabel: t('baseline'),
                onChange: (v) =>
                  setForm((f) => ({ ...f, relation: { ...f.relation, familiarity: v } })),
              }),
              React.createElement(
                'div',
                { className: 'lep-form__actions' },
                React.createElement(
                  Button,
                  { type: 'submit', variant: 'primary', size: 'sm', disabled: saving },
                  saving ? t('saving') : t('save'),
                ),
                React.createElement('span', { className: 'lep-note' }, t('opCauseFixed')),
              ),
              formError ? React.createElement('div', { className: 'lep-err' }, formError) : null,
              previewBlock,
            )
          : null,
      );

      return React.createElement(
        'div',
        { className: 'lep-state' },
        strip,
        badgesBlock,
        React.createElement(
          'div',
          { className: 'lep-toolbar' },
          React.createElement(Checkbox, {
            checked: debug,
            onChange: (v) => setDebug(v),
            label: t('debugMode'),
            title: t('debugHint'),
          }),
        ),
        rawBlock,
        receiptsBlock,
        React.createElement(
          'div',
          { className: 'lep-section' },
          React.createElement(SectionHead, {
            icon: IconArchiveOutline,
            title: t('history'),
            open,
            onToggle: () => setOpen(!open),
          }),
          history,
        ),
        editor,
      );
    }

    /**
     * Lv3 立绘 overlay：portal 到 document.body，一帧只由 (activity, tone, near) 决定；
     * 自身不产生可见 DOM、不发业务请求、没有独立时间轴。
     */
    function AvatarOverlay({ sessionId, useSessionStatus, useSession, useChat, useLepState, t }) {
      const status = useSessionStatus((map) => (sessionId ? map.get(sessionId) : undefined));
      const agentError = useSession((s) => (s ? s.lastAgentError : null));
      const useChatSafe = typeof useChat === 'function' ? useChat : () => null;
      const chatSignal = useChatSafe((s) => deriveChatSignal(s));
      const feed = useLepState((st) => st);

      const activity = resolveActivity(status, chatSignal, agentError);
      const body = feed.phase === 'ok' ? feed.body : null;
      const tone = body && body.tone ? body.tone : 'plain';
      const near = !!(body && body.near === true);
      const candidates = avatarCandidates(activity, tone, near);

      const [idx, setIdx] = React.useState(0);
      React.useEffect(() => {
        setIdx(0);
      }, [activity, tone, near]);
      const key = candidates[Math.min(idx, candidates.length - 1)];

      // 双层交叉淡入：front 淡入、stash 留在底层淡出；240ms 后清掉底层。
      const [view, setView] = React.useState({ front: key, stash: null, on: false });
      React.useEffect(() => {
        setView((prev) =>
          prev.front === key ? prev : { front: key, stash: prev.front, on: false },
        );
      }, [key]);
      React.useEffect(() => {
        if (!view.stash) return;
        const at = setTimeout(
          () => setView((prev) => (prev.stash ? { ...prev, stash: null } : prev)),
          240,
        );
        return () => clearTimeout(at);
      }, [view.stash]);

      // 挂载后一次性预热全部候选帧，首次切换不闪烁；同时按需给出一次降级告警。
      React.useEffect(() => {
        AVATAR_PRELOAD_KEYS.forEach((k) => {
          const img = new Image();
          img.src = avatarSrc(k);
        });
        if (typeof useChat !== 'function')
          console.warn('[lepimemory] useChat 不可用：立绘只按会话状态推导活动');
      }, []);

      const layer = (k, on, isTop) =>
        React.createElement('img', {
          key: k,
          src: avatarSrc(k),
          className: on ? 'is-on' : '',
          alt: '',
          onLoad: isTop
            ? () => setView((prev) => (prev.front === k ? { ...prev, on: true } : prev))
            : undefined,
          onError: isTop ? () => setIdx((i) => i + 1) : undefined,
        });
      const nodes = [];
      if (view.stash) nodes.push(layer(view.stash, true, false));
      nodes.push(layer(view.front, view.on, true));
      return ReactDOM.createPortal(
        React.createElement(
          'div',
          { className: 'lep-avatar', role: 'img', 'aria-label': t('avatarAlt') },
          nodes,
        ),
        document.body,
      );
    }

    const dicts = {
      zh: {
        unavailable: '状态不可用',
        forbidden: '无权访问（权限已丢失）',
        panelTitle: '状态面板',
        panelGuide: '查看它与你的记忆、状态与审计',
        history: '历史记录',
        empty: '（暂无记录）',
        prev: '上一页',
        next: '下一页',
        pageOf: '第 {p}/{q} 页 · 共 {n} 条',
        pageOfGroups: '第 {p}/{q} 页 · 共 {n} 组',
        stagesTruncated: '（仅显示最近的阶段）',
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
        st_admission: '准入判定',
        st_received: '已接收',
        st_retry_pending: '待重试',
        st_resubmit_required: '需重新发起',
        st_parked: '已停车',
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
        ed_preview: '预览',
        ed_previewing: '预览中…',
        ed_preview_failed: '预览不可用',
        baseline: '基线',
        ed_hint: '调整演示状态（原因固定记为「操作者调整演示状态」）',
        it_audit: '审计',
        it_recall: '回忆',
        it_retain: '写入记忆',
        it_forget: '遗忘',
        it_action: '行动',
        it_task: '后台任务',
        it_control: '状态控制',
        it_consent: '授权',
        debugMode: '调试模式',
        debugHint: '显示原始摘要与 ID（排查用）',
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
        avatarAlt: '角色形象',
        act_idle: '待机',
        act_think: '思考中',
        act_speak: '说话中',
        act_tool: '执行工具中',
        act_approval: '等待确认',
        act_question: '等待回应',
        act_error: '出错了',
        grp_memory: '它记得什么',
        grp_action: '它做了什么',
        grp_why: '它为什么这样',
        grp_privacy: '授权与隐私',
        badge_memories: '记忆有效',
        badge_tasks: '待处理任务',
        badge_grants: '有效授权',
        badge_core_bad: '核心异常',
        strip_now: '此刻',
        tone_bright: '心情明亮',
        tone_plain: '心情平稳',
        tone_low: '心情偏低落',
        rel_near: '对你更亲近',
        stateRaw: '模型实际读到的内部状态',
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
        panelTitle: 'Lepimemory state',
        panelGuide: 'Inspect its memory, state and audit trail',
        history: 'History',
        empty: '(no records)',
        prev: 'Prev',
        next: 'Next',
        pageOf: 'Page {p}/{q} · {n} total',
        pageOfGroups: 'Page {p}/{q} · {n} groups',
        stagesTruncated: '(showing only the most recent stages)',
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
        st_admission: 'Admission',
        st_received: 'Received',
        st_retry_pending: 'Retry pending',
        st_resubmit_required: 'Resubmit required',
        st_parked: 'Parked',
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
        ed_preview: 'Preview',
        ed_previewing: 'Previewing…',
        ed_preview_failed: 'Preview unavailable',
        baseline: 'Baseline',
        ed_hint: 'Adjust the demo state (cause is recorded as the fixed operator note)',
        it_audit: 'Audit',
        it_recall: 'Recall',
        it_retain: 'Save to memory',
        it_forget: 'Forget',
        it_action: 'Action',
        it_task: 'Background task',
        it_control: 'State control',
        it_consent: 'Consent',
        debugMode: 'Debug mode',
        debugHint: 'Show raw summary and IDs (for troubleshooting)',
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
        avatarAlt: 'Character sprite',
        act_idle: 'Idle',
        act_think: 'Thinking',
        act_speak: 'Speaking',
        act_tool: 'Running a tool',
        act_approval: 'Waiting for confirmation',
        act_question: 'Waiting for your answer',
        act_error: 'Error',
        grp_memory: 'What it remembers',
        grp_action: 'What it did',
        grp_why: 'Why it changed',
        grp_privacy: 'Consent & privacy',
        badge_memories: 'Active memories',
        badge_tasks: 'Pending tasks',
        badge_grants: 'Active grants',
        badge_core_bad: 'Core not ready',
        strip_now: 'Now',
        tone_bright: 'in good spirits',
        tone_plain: 'steady',
        tone_low: 'a little low',
        rel_near: 'warmer toward you',
        stateRaw: 'Raw internal state the model sees',
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
    };

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'lepimemory-state: locale');
        const tLe = ctx.locale.bind(NS);
        // 面板与立绘共享同一份 /lepimemory/state 轮询源；注册各自独立
        // （ctx.slots.inject 回调必须返回单个 disposer，不能聚合多个 register）。
        const feed = createStateFeed();
        const injectFeed = () => ({
          hooks: { lepState: feed },
          refreshLepState: () => feed.refresh(),
        });
        // 面板：右侧栏标签页（类型定义 + session 作用域正文）。
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PANEL_TAB_ID,
              kind: PANEL_KIND,
              title: () => tLe('panelTitle'),
              guide: [
                {
                  id: 'lepimemory-state',
                  order: 40,
                  title: () => tLe('panelTitle'),
                  description: () => tLe('panelGuide'),
                },
              ],
            }),
          'lepimemory-state: right-sidebar tab type',
        );
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: PANEL_TAB_ID, locale: NS, inject: injectFeed },
            Panel,
          ),
        );
        // 立绘：仍在输入框上方的 dock，不随面板搬走。
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'lepimemory-avatar',
              order: 6,
              locale: NS,
              inject: injectFeed,
            },
            AvatarOverlay,
          ),
        );
      },
    };
  },
});
