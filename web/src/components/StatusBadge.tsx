import { Icon } from './Icon';
import {
  interviewStatus, pipelineStatus, decisionStatus, roundStatus, recommendationStatus, roleStatus, proposalStatus, refreshRunStatus, toneToBadgeKind,
  type StatusMeta,
} from './statusModel';

export type StatusKind = 'interview' | 'pipeline' | 'decision' | 'round' | 'recommendation' | 'role' | 'proposal' | 'refreshRun';

const RESOLVERS: Readonly<Record<StatusKind, (value: string) => StatusMeta>> = {
  interview: interviewStatus,
  pipeline: pipelineStatus,
  decision: decisionStatus,
  round: roundStatus,
  recommendation: recommendationStatus,
  role: roleStatus,
  proposal: proposalStatus,
  refreshRun: refreshRunStatus,
};

/** A status chip: icon + colour + words. The words carry the meaning, so the icon is decorative. */
export function StatusBadge({ kind, value }: { kind: StatusKind; value: string }) {
  const meta = RESOLVERS[kind](value);
  return (
    <span className={`badge ${toneToBadgeKind(meta.tone)} status-badge`} data-status={value}>
      <Icon name={meta.icon} size={13} />
      {meta.label}
    </span>
  );
}
