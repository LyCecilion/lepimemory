/**
 * 状态条：五个带基线刻度的 meter + 活动 Tag（含 StateDot）+ 一行摘要。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { BASELINE } from '../../shared/state.js';
import { ACT_CLASS } from '../constants.js';
import { activityDot, statusTone } from '../status.js';
import type { StateStripProps } from '../types.js';
import { Meter } from './atoms.js';

export function StateStrip({ t, state, activity }: StateStripProps): ReactElement {
  const tone = state.tone || 'plain';
  const near = state.near === true;
  const summary =
    t('strip_now') +
    '：' +
    t(`tone_${tone}`) +
    (near ? ' · ' + t('rel_near') : '') +
    ' · ' +
    t(`act_${activity}`);
  return (
    <div className="lep-strip">
      <span className="lep-strip__group">
        <span className="lep-strip__grouplabel">{t('mood')}</span>
        <Meter
          label={t('valence')}
          value={state.mood ? state.mood.valence : undefined}
          lo={-1}
          hi={1}
          baseline={BASELINE.valence}
        />
        <Meter
          label={t('arousal')}
          value={state.mood ? state.mood.arousal : undefined}
          lo={0}
          hi={1}
          baseline={BASELINE.arousal}
        />
      </span>
      <span className="lep-strip__group">
        <span className="lep-strip__grouplabel">{t('relation')}</span>
        <Meter
          label={t('trust')}
          value={state.relation ? state.relation.trust : undefined}
          lo={0}
          hi={1}
          baseline={BASELINE.trust}
        />
        <Meter
          label={t('closeness')}
          value={state.relation ? state.relation.closeness : undefined}
          lo={0}
          hi={1}
          baseline={BASELINE.closeness}
        />
        <Meter
          label={t('familiarity')}
          value={state.relation ? state.relation.familiarity : undefined}
          lo={0}
          hi={1}
          baseline={BASELINE.familiarity}
        />
      </span>
      <Tag tone={statusTone(ACT_CLASS[activity])} className="lep-act">
        <span className="lep-act__dot">
          <StateDot state={activityDot(activity)} size={8} />
        </span>
        {t(`act_${activity}`)}
      </Tag>
      <div className="lep-strip__summary">{summary}</div>
    </div>
  );
}
