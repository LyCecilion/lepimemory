/**
 * 面板的展示原子：带基线刻度的 meter / 滑杆、分节标题、键值行与详情列表。
 * 全部渲染为纯文本，绝不使用 dangerouslySetInnerHTML。
 */
import * as React from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 把数值折到 0..100 的百分比刻度。 */
function clampPercent(x: number): number {
  return Math.max(0, Math.min(100, x));
}

export interface MeterProps {
  readonly label: string;
  readonly value: number | undefined;
  readonly lo: number;
  readonly hi: number;
  readonly baseline: number;
}

/** 一条带基线刻度的数值 meter（valence 取 -1..1，其余 0..1）。 */
export function Meter({ label, value, lo, hi, baseline }: MeterProps): ReactElement {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const pct = numeric === undefined ? 0 : clampPercent(((numeric - lo) / (hi - lo)) * 100);
  const basePct = clampPercent(((baseline - lo) / (hi - lo)) * 100);
  return (
    <span className="lep-meter" title={`${label} ${numeric === undefined ? '—' : numeric}`}>
      <span className="lep-meter__label">{label}</span>
      <span className="lep-meter__track">
        <span className="lep-meter__fill" style={{ width: pct + '%' }} />
        <span className="lep-meter__base" style={{ left: basePct + '%' }} />
      </span>
      <span className="lep-meter__value">{numeric === undefined ? '—' : numeric.toFixed(2)}</span>
    </span>
  );
}

export interface SliderProps {
  readonly label: string;
  readonly value: number | '' | undefined;
  readonly lo: number;
  readonly hi: number;
  readonly step?: number | undefined;
  readonly baseline: number;
  readonly baselineLabel?: string | undefined;
  readonly onChange: (value: number) => void;
}

/** 一条带基线刻度的滑杆：范围输入 + 当前值（区间与提交校验一致）。 */
export function Slider({
  label,
  value,
  lo,
  hi,
  step,
  baseline,
  baselineLabel,
  onChange,
}: SliderProps): ReactElement {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const basePct = clampPercent(((baseline - lo) / (hi - lo)) * 100);
  return (
    <label className="lep-field lep-field--slider">
      <span className="lep-field__label">{label}</span>
      <span className="lep-slider">
        <input
          type="range"
          min={lo}
          max={hi}
          step={step || 0.01}
          value={numeric === undefined ? lo : numeric}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span
          className="lep-meter__base lep-slider__tick"
          style={{ left: basePct + '%' }}
          title={baselineLabel}
        />
      </span>
      <span className="lep-field__value">{numeric === undefined ? '—' : numeric.toFixed(2)}</span>
    </label>
  );
}

export interface SectionHeadProps {
  readonly icon?: ComponentType<{ size?: number | undefined }> | undefined;
  readonly title: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** 分节标题：chevron + 图标 + 标题，点击展开/收起（对齐 dsh 的 disclosure 形）。 */
export function SectionHead({ icon: Icon, title, open, onToggle }: SectionHeadProps): ReactElement {
  return (
    <div
      className={`lep-sechead${open ? ' is-open' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="lep-sechead__chev">
        {open ? (
          <IconChevronDownOutlineRegular size={14} />
        ) : (
          <IconChevronRightOutlineRegular size={14} />
        )}
      </span>
      {Icon ? (
        <span className="lep-sechead__icon">
          <Icon size={15} />
        </span>
      ) : null}
      <span className="lep-sechead__title">{title}</span>
    </div>
  );
}

/** 详情行（标签 + 文本值）。 */
export function kv(label: string, value: unknown): ReactElement {
  return (
    <div className="lep-kv" key={label}>
      <b>{label}</b>
      <span>{value == null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

/** 详情列表（每条渲染为纯文本）。 */
export function listBlock(
  label: string,
  arr: unknown,
  fmt: (item: unknown) => ReactNode,
): ReactElement {
  if (!Array.isArray(arr) || arr.length === 0) return kv(label, '—');
  return (
    <div className="lep-kv" key={label}>
      <b>{label}</b>
      <ul className="lep-sublist">
        {arr.map((x, i) => (
          <li key={i}>{fmt(x)}</li>
        ))}
      </ul>
    </div>
  );
}
