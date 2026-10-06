/**
 * 计数徽章行：记忆有效 / 待处理任务 / 有效授权，外加核心异常提示。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BadgesProps } from '../types.js';

export function Badges({ t, counts, core }: BadgesProps): ReactElement {
  const badges: ReadonlyArray<readonly [string, number]> = [
    [t('badge_memories'), (counts.lifecycle && counts.lifecycle.active) || 0],
    [
      t('badge_tasks'),
      ((counts.tasks && counts.tasks.queued) || 0) + ((counts.tasks && counts.tasks.running) || 0),
    ],
    [t('badge_grants'), (counts.grants && counts.grants.active) || 0],
  ];
  return (
    <div className="lep-badges">
      {badges.map(([label, n]) => (
        <Tag key={label} tone="neutral">
          {`${label} ${n}`}
        </Tag>
      ))}
      {core === false ? <Tag tone="danger">{t('badge_core_bad')}</Tag> : null}
    </div>
  );
}
