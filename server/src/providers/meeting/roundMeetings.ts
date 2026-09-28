import { readEnv, roundEnvPresence, type EnvPresence } from './connectorEnv.js';
import { teamsVendor } from './teams.js';
import { zoomVendor } from './zoom.js';
import { meetVendor } from './googleMeet.js';
import {
  isRoundMeetingProviderId, PROVIDER_LABEL, ROUND_MEETING_PROVIDERS,
  type MeetingVendor, type RoundMeetingProviderId,
} from './types.js';

// Which meeting provider creates the link for a human interview round.
//
// Pluggable like the other connectors: `manual` (the recruiter pastes a link)
// is the default and needs nothing; Teams, Zoom and Meet create real meetings
// with deployment-wide credentials from server/.env. A tenant may pick one in
// its policy (`roundMeetingProvider`); otherwise ROUND_MEETING_PROVIDER applies.
//
// This is separate from MEETING_PROVIDER, which names the room the AI
// interview runs in (the hosted Questor room).

const VENDORS: Readonly<Record<Exclude<RoundMeetingProviderId, 'manual'>, MeetingVendor>> = {
  teams: teamsVendor,
  zoom: zoomVendor,
  meet: meetVendor,
};

export function vendorFor(id: RoundMeetingProviderId): MeetingVendor | null {
  return id === 'manual' ? null : VENDORS[id];
}

/** The deployment default. Read per call so an operator's change is visible after restart and in tests. */
export function envDefaultRoundProvider(): RoundMeetingProviderId {
  const value = readEnv('ROUND_MEETING_PROVIDER').toLowerCase();
  return isRoundMeetingProviderId(value) ? value : 'manual';
}

export interface ResolvedProvider {
  readonly provider: RoundMeetingProviderId;
  readonly source: 'tenant' | 'deployment';
}

export function resolveRoundMeetingProvider(policy: Readonly<Record<string, unknown>>): ResolvedProvider {
  const chosen = policy.roundMeetingProvider;
  return isRoundMeetingProviderId(chosen)
    ? { provider: chosen, source: 'tenant' }
    : { provider: envDefaultRoundProvider(), source: 'deployment' };
}

export function isProviderReady(id: RoundMeetingProviderId): boolean {
  return vendorFor(id)?.isConfigured() ?? true;
}

export interface RoundProviderOption {
  readonly provider: RoundMeetingProviderId;
  readonly label: string;
  readonly configured: boolean;
  /** Variable names and presence only — for admins. */
  readonly env?: EnvPresence[];
}

export interface RoundMeetingStatus extends ResolvedProvider {
  readonly label: string;
  readonly configured: boolean;
  readonly deploymentDefault: RoundMeetingProviderId;
  readonly options: RoundProviderOption[];
}

/** What is selected and whether it can work. Never carries a credential value. */
export function roundMeetingStatus(policy: Readonly<Record<string, unknown>>, options: { includeEnv?: boolean } = {}): RoundMeetingStatus {
  const resolved = resolveRoundMeetingProvider(policy);
  return {
    ...resolved,
    label: PROVIDER_LABEL[resolved.provider],
    configured: isProviderReady(resolved.provider),
    deploymentDefault: envDefaultRoundProvider(),
    options: ROUND_MEETING_PROVIDERS.map((provider) => ({
      provider,
      label: PROVIDER_LABEL[provider],
      configured: isProviderReady(provider),
      ...(options.includeEnv ? { env: provider === 'manual' ? [] : roundEnvPresence(provider) } : {}),
    })),
  };
}
