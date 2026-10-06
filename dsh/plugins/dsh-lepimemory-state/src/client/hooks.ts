/**
 * 面板的数据生命周期 hooks：历史轮询、回执汇聚、显式重试、候选详情、操作者编辑。
 *
 * 每个 hook 拥有自己那份状态与 AbortController；`useInvalidation` 提供一次同步的
 * 失效扇出（epoch++ → 各 hook 中止自己的请求并清空私有缓存），不用全局 store/事件总线。
 */
import * as React from 'react';
import type { MutableRefObject } from 'react';
import type { CandidateResponse, HistoryEntry, HistoryGroup } from '../shared/api.js';
import { INTENT_KEY, PAGE } from './constants.js';
import { chainsOf, entriesOf } from './history-model.js';
import { statusLabel } from './status.js';
import { fetchJson, fill, fmtTime } from './util.js';
import type {
  CandidateDetailsArgs,
  CandidateDetailsResult,
  CandidateMap,
  FieldPath,
  FormState,
  HistoryState,
  Invalidation,
  PanelHistoryArgs,
  PanelHistoryResult,
  PreviewState,
  Receipt,
  ReceiptsArgs,
  ReceiptsResult,
  RetryArgs,
  RetryKind,
  RetryResult,
  StateEditorArgs,
  StateEditorResult,
} from './types.js';

/** 挂在组件生命周期上的 mounted 标记（卸载后丢弃迟到响应）。 */
function useMountedRef(): MutableRefObject<boolean> {
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** 失效扇出：epoch 单调递增，注册的 reset 被同步调用。 */
export function useInvalidation(): Invalidation {
  const epoch = React.useRef(0);
  const resets = React.useRef(new Set<() => void>());
  const invalidate = React.useCallback(() => {
    epoch.current += 1;
    for (const reset of resets.current) reset();
  }, []);
  const onInvalidate = React.useCallback((reset: () => void) => {
    resets.current.add(reset);
    return () => {
      resets.current.delete(reset);
    };
  }, []);
  return React.useMemo(
    () => ({ epoch, invalidate, onInvalidate }),
    [epoch, invalidate, onInvalidate],
  );
}

/** 历史分页：折叠时也读 audit offset 0；每次 load 捕获 epoch/seq，陈旧响应丢弃。 */
export function usePanelHistory({
  open,
  kind,
  offset,
  debug,
  invalidation,
}: PanelHistoryArgs): PanelHistoryResult {
  const [hist, setHist] = React.useState<HistoryState | null>(null);
  const [tick, setTick] = React.useState(0);
  const refreshHistory = React.useCallback(() => setTick((x) => x + 1), []);
  const reset = React.useCallback(() => setHist({ ok: false, forbidden: true }), []);
  React.useEffect(() => invalidation.onInvalidate(reset), [invalidation, reset]);
  React.useEffect(() => {
    setHist(null);
    const selectedKind = open ? kind : 'audit';
    const selectedOffset = open ? offset : 0;
    const ctrl = new AbortController();
    let alive = true;
    let seq = 0;
    const url = `/lepimemory/history?kind=${encodeURIComponent(selectedKind)}&limit=${PAGE}&offset=${selectedOffset}${debug ? '' : '&grouped=1'}`;
    const load = (): void => {
      const my = ++seq;
      const epoch = invalidation.epoch.current;
      void fetchJson(url, { signal: ctrl.signal })
        .then((r) => {
          if (!alive || my !== seq || epoch !== invalidation.epoch.current) return;
          if (r.status === 401 || r.status === 403) {
            invalidation.invalidate();
            return;
          }
          if (!r.ok || r.body.ok === false) {
            setHist({ ok: false });
            return;
          }
          const body = r.body;
          const groups = Array.isArray(body.groups) ? (body.groups as HistoryGroup[]) : null;
          const entries = Array.isArray(body.entries) ? (body.entries as HistoryEntry[]) : [];
          setHist({
            ok: true,
            kind: typeof body.kind === 'string' && body.kind ? body.kind : selectedKind,
            grouped: !!groups,
            total:
              typeof body.total === 'number' ? body.total : groups ? groups.length : entries.length,
            offset: typeof body.offset === 'number' ? body.offset : selectedOffset,
            limit: typeof body.limit === 'number' ? body.limit : PAGE,
            entries,
            groups,
          });
        })
        .catch((err: { name?: string }) => {
          if (
            alive &&
            my === seq &&
            epoch === invalidation.epoch.current &&
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
  }, [open, kind, offset, tick, debug, invalidation]);
  return { hist, refreshHistory };
}

/** 从历史记录汇聚系统回执：按 audit/request/task ID 去重（不触发任何模型调用）。 */
interface StoredReceipt extends Receipt {
  readonly auditId?: number;
}

export function useReceipts({ hist, t, invalidation }: ReceiptsArgs): ReceiptsResult {
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const receiptsRef = React.useRef(new Map<string, StoredReceipt>());
  const publishReceipts = React.useCallback(() => {
    const latest = Array.from(receiptsRef.current.values())
      .sort((a, b) => b.at - a.at)
      .slice(0, PAGE);
    receiptsRef.current = new Map(latest.map((r) => [r.key, r]));
    setReceipts(latest);
  }, []);
  const addReceipt = React.useCallback(
    (key: string, at: number, text: string) => {
      receiptsRef.current.set(key, { key, at, text });
      publishReceipts();
    },
    [publishReceipts],
  );
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
      if (previous && previous.auditId != null && previous.auditId >= e.id) continue;
      const intentKey = INTENT_KEY[type];
      receiptsRef.current.set(key, {
        key,
        at: e.at,
        auditId: e.id,
        text: `${intentKey ? t(intentKey) : type} · ${statusLabel(t, e.status, e.data && e.data.legacy)}`,
      });
      changed = true;
    }
    if (changed) publishReceipts();
  }, [hist, t, publishReceipts]);
  const reset = React.useCallback(() => {
    receiptsRef.current.clear();
    setReceipts([]);
  }, []);
  React.useEffect(() => invalidation.onInvalidate(reset), [invalidation, reset]);
  return { receipts, addReceipt };
}

/** 显式重试：不自动重提；404/409/失败都落一条回执，迟到响应不复活私有数据。 */
export function useRetry({ t, invalidation, addReceipt, refreshHistory }: RetryArgs): RetryResult {
  const [retrying, setRetrying] = React.useState<Record<string, boolean | undefined>>({});
  const mounted = useMountedRef();
  const retry = React.useCallback(
    (retryKind: RetryKind, id: string) => {
      const btnKey = `${retryKind}:${id}`;
      const epoch = invalidation.epoch.current;
      setRetrying((prev) => ({ ...prev, [btnKey]: true }));
      void fetchJson('/lepimemory/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: retryKind, id }),
      })
        .then((r) => {
          if (!mounted.current || epoch !== invalidation.epoch.current) return;
          setRetrying((prev) => ({ ...prev, [btnKey]: false }));
          if (r.status === 401 || r.status === 403) {
            invalidation.invalidate();
            return;
          }
          if (r.status === 404) {
            addReceipt(`retry:${btnKey}`, Date.now(), t('retryNotFound'));
            return;
          }
          if (r.status === 409) {
            const resubmit = r.body.code === 'LEPI_INPUT_RESUBMIT_REQUIRED';
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
          addReceipt(`${retryKind}:${String(doneId)}`, Date.now(), t('retryQueued'));
          refreshHistory();
        })
        .catch(() => {
          if (!mounted.current || epoch !== invalidation.epoch.current) return;
          setRetrying((prev) => ({ ...prev, [btnKey]: false }));
          addReceipt(`retry:${btnKey}`, Date.now(), t('retryFailed'));
        });
    },
    [t, invalidation, addReceipt, refreshHistory, mounted],
  );
  const reset = React.useCallback(() => setRetrying({}), []);
  React.useEffect(() => invalidation.onInvalidate(reset), [invalidation, reset]);
  return { retrying, retry };
}

/** 候选详情：随真实历史轮询刷新；移出可见集合即中止；每 id 替换 controller。 */
export function useCandidateDetails({
  open,
  hist,
  expanded,
  invalidation,
}: CandidateDetailsArgs): CandidateDetailsResult {
  const [cand, setCand] = React.useState<CandidateMap>({});
  const candRef = React.useRef<CandidateMap>({});
  const candAbort = React.useRef(new Map<string, AbortController>());
  const mounted = React.useRef(true);
  React.useEffect(() => {
    candRef.current = cand;
  });
  React.useEffect(() => {
    const aborts = candAbort.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const c of aborts.values()) c.abort();
      aborts.clear();
    };
  }, []);
  const loadCandidate = React.useCallback(
    (id: string, reveal: boolean) => {
      const ctrl = new AbortController();
      const prevCtrl = candAbort.current.get(id);
      if (prevCtrl) prevCtrl.abort();
      candAbort.current.set(id, ctrl);
      // 静默刷新：已有可用数据时不回落到 loading，避免轮询每 5s 把行内正文闪断一次。
      setCand((prev) => {
        const prior = prev[id];
        if (prior && prior.phase === 'ok') return prev;
        return { ...prev, [id]: { phase: 'loading' } };
      });
      const url = `/lepimemory/candidate?id=${encodeURIComponent(id)}${reveal ? '&reveal=1' : ''}`;
      void fetchJson(url, { signal: ctrl.signal })
        .then((r) => {
          if (candAbort.current.get(id) !== ctrl) return;
          candAbort.current.delete(id);
          if (!mounted.current) return;
          if (r.status === 401 || r.status === 403) {
            invalidation.invalidate();
            return;
          }
          if (!r.ok || r.body.ok === false) {
            setCand((prev) => ({ ...prev, [id]: { phase: 'error', forbidden: false } }));
            return;
          }
          setCand((prev) => ({
            ...prev,
            [id]: { phase: 'ok', data: r.body as unknown as CandidateResponse, revealed: !!reveal },
          }));
        })
        .catch((err: { name?: string }) => {
          if (err.name === 'AbortError') return;
          if (candAbort.current.get(id) !== ctrl) return;
          candAbort.current.delete(id);
          if (!mounted.current) return;
          setCand((prev) => ({ ...prev, [id]: { phase: 'error', forbidden: false } }));
        });
    },
    [invalidation],
  );
  const dropCandidate = React.useCallback((id: string) => {
    setCand((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  React.useEffect(() => {
    const visible = new Set<string>();
    if (open && hist && hist.ok === true) {
      for (const e of entriesOf(hist)) {
        if (e.candidate_id) visible.add(e.candidate_id);
        if (expanded[`e${e.id}`])
          for (const chain of chainsOf(e.data)) {
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
    for (const id of visible) {
      const record = candRef.current[id];
      loadCandidate(id, !!record && record.phase === 'ok' && record.revealed);
    }
  }, [open, hist, expanded, loadCandidate]);
  const reset = React.useCallback(() => {
    for (const c of candAbort.current.values()) c.abort();
    candAbort.current.clear();
    setCand({});
  }, []);
  React.useEffect(() => invalidation.onInvalidate(reset), [invalidation, reset]);
  return { cand, loadCandidate, dropCandidate };
}

/** 操作者编辑：打开时只采样一次当前五值；预览 250ms 防抖，只 POST ?preview=1。 */
export function useStateEditor({
  state,
  t,
  invalidation,
  addReceipt,
  refreshLepState,
}: StateEditorArgs): StateEditorResult {
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState | null>(null);
  const [formError, setFormError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const mounted = useMountedRef();
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const toggleEditor = React.useCallback(() => setEditorOpen((v) => !v), []);
  React.useEffect(() => {
    if (!editorOpen) return;
    const current = stateRef.current;
    if (!current || current.ok === false) return;
    if (!current.mood || !current.relation) return;
    const num = (v: unknown): number | '' => (typeof v === 'number' && Number.isFinite(v) ? v : '');
    setForm({
      mood: { valence: num(current.mood.valence), arousal: num(current.mood.arousal) },
      relation: {
        trust: num(current.relation.trust),
        closeness: num(current.relation.closeness),
        familiarity: num(current.relation.familiarity),
      },
    });
    setFormError('');
  }, [editorOpen]);
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
      void fetchJson('/lepimemory/state?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
        .then((r) => {
          if (!alive) return;
          if (r.ok && r.body.ok === true && r.body.preview === true) {
            setPreview({
              rendered: typeof r.body.rendered === 'string' ? r.body.rendered : '',
              tone:
                r.body.tone === 'bright' || r.body.tone === 'plain' || r.body.tone === 'low'
                  ? r.body.tone
                  : 'plain',
            });
          } else {
            setPreview({ failed: true });
          }
        })
        .catch((err: { name?: string }) => {
          if (alive && err.name !== 'AbortError') setPreview({ failed: true });
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [form, editorOpen]);
  const setNumber = React.useCallback((path: FieldPath, value: number) => {
    setForm((f) => {
      if (!f) return f;
      const mood = { ...f.mood };
      const relation = { ...f.relation };
      if (path === 'mood.valence') mood.valence = value;
      else if (path === 'mood.arousal') mood.arousal = value;
      else if (path === 'relation.trust') relation.trust = value;
      else if (path === 'relation.closeness') relation.closeness = value;
      else relation.familiarity = value;
      return { mood, relation };
    });
  }, []);
  const submitState = React.useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault();
      if (!form) return;
      const fields: ReadonlyArray<readonly [string, number | '', number, number]> = [
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
      const epoch = invalidation.epoch.current;
      // 精确 payload：只有数值字段。原因是 host 固定的「操作者调整演示状态」，不由前端提交。
      void fetchJson('/lepimemory/state', {
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
          if (!mounted.current || epoch !== invalidation.epoch.current) return;
          setSaving(false);
          if (r.status === 401 || r.status === 403) {
            invalidation.invalidate();
            return;
          }
          if (!r.ok || r.body.ok === false) {
            setFormError(t('saveFailed'));
            return;
          }
          const auditId = r.body.audit_id;
          const bodyId = r.body.id;
          const requestId = r.body.request_id;
          const idKey = auditId != null ? auditId : bodyId != null ? bodyId : requestId;
          addReceipt(
            idKey != null ? `audit:${String(idKey)}` : `state:${Date.now()}`,
            Date.now(),
            `${t('opCauseFixed')} · ${fmtTime(r.body.updatedAt || Date.now())}`,
          );
          refreshLepState();
        })
        .catch(() => {
          if (mounted.current && epoch === invalidation.epoch.current) {
            setSaving(false);
            setFormError(t('saveFailed'));
          }
        });
    },
    [form, t, invalidation, addReceipt, refreshLepState, mounted],
  );
  const reset = React.useCallback(() => {
    setEditorOpen(false);
    setForm(null);
    setFormError('');
    setSaving(false);
    setPreview(null);
  }, []);
  React.useEffect(() => invalidation.onInvalidate(reset), [invalidation, reset]);
  return { editorOpen, toggleEditor, form, setNumber, formError, saving, preview, submitState };
}
