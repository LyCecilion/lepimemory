/**
 * 操作者编辑区：五个滑杆 + 保存 + 语气预览（preview 只是 dry-run）。
 * 无 fetch：值/校验/预览/提交状态都由 useStateEditor 拥有，这里只渲染。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { Button, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { BASELINE } from '../../shared/state.js';
import type { FieldPath, FormState, PreviewState, Translate } from '../types.js';
import { SectionHead, Slider } from './atoms.js';

export interface EditorFormProps {
  readonly t: Translate;
  readonly editorOpen: boolean;
  readonly onToggle: () => void;
  readonly form: FormState | null;
  readonly setNumber: (path: FieldPath, value: number) => void;
  readonly formError: string;
  readonly saving: boolean;
  readonly preview: PreviewState | null;
  readonly onSubmit: (event: { preventDefault(): void }) => void;
}

export function EditorForm({
  t,
  editorOpen,
  onToggle,
  form,
  setNumber,
  formError,
  saving,
  preview,
  onSubmit,
}: EditorFormProps): ReactElement {
  const previewBlock = (
    <div className="lep-preview">
      <div className="lep-preview__title">{t('ed_preview')}</div>
      {!editorOpen || !form || preview == null ? (
        <div className="lep-note">{t('ed_previewing')}</div>
      ) : preview.failed ? (
        <div className="lep-err">{t('ed_preview_failed')}</div>
      ) : (
        <div>
          <div className="lep-note">{t(`tone_${preview.tone ?? 'plain'}`)}</div>
          <div className="lep-raw__body">{preview.rendered}</div>
        </div>
      )}
    </div>
  );
  return (
    <div className="lep-section">
      <SectionHead
        icon={IconEditOutlineRegular}
        title={t('opTitle')}
        open={editorOpen}
        onToggle={onToggle}
      />
      {editorOpen && form ? (
        <form className="lep-form" onSubmit={onSubmit}>
          <div className="lep-note">{t('ed_hint')}</div>
          <Slider
            label={t('valence')}
            value={form.mood.valence}
            lo={-1}
            hi={1}
            baseline={BASELINE.valence}
            baselineLabel={t('baseline')}
            onChange={(v) => setNumber('mood.valence', v)}
          />
          <Slider
            label={t('arousal')}
            value={form.mood.arousal}
            lo={0}
            hi={1}
            baseline={BASELINE.arousal}
            baselineLabel={t('baseline')}
            onChange={(v) => setNumber('mood.arousal', v)}
          />
          <Slider
            label={t('trust')}
            value={form.relation.trust}
            lo={0}
            hi={1}
            baseline={BASELINE.trust}
            baselineLabel={t('baseline')}
            onChange={(v) => setNumber('relation.trust', v)}
          />
          <Slider
            label={t('closeness')}
            value={form.relation.closeness}
            lo={0}
            hi={1}
            baseline={BASELINE.closeness}
            baselineLabel={t('baseline')}
            onChange={(v) => setNumber('relation.closeness', v)}
          />
          <Slider
            label={t('familiarity')}
            value={form.relation.familiarity}
            lo={0}
            hi={1}
            baseline={BASELINE.familiarity}
            baselineLabel={t('baseline')}
            onChange={(v) => setNumber('relation.familiarity', v)}
          />
          <div className="lep-form__actions">
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
            <span className="lep-note">{t('opCauseFixed')}</span>
          </div>
          {formError ? <div className="lep-err">{formError}</div> : null}
          {previewBlock}
        </form>
      ) : null}
    </div>
  );
}
