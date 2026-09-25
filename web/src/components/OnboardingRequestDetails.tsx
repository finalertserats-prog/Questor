import { Icon } from './Icon';
import type { QueuedSignup } from './signupModel';

/**
 * The onboarding facts of one queued request. Read off `QueuedSignup`, which
 * parses them defensively: a request from before onboarding existed, or a join
 * request, carries none of them.
 *
 * `existingOrganisation` is the one fact the public form must never confirm,
 * shown here because the person deciding is the only one entitled to it — and
 * because approving a duplicate silently is how two organisations end up
 * sharing a name.
 */
export type OnboardingRequestFacts = Pick<
  QueuedSignup, 'region' | 'orgSizeLabel' | 'businessAreas' | 'existingOrganisation'
>;

/**
 * What an organisation actually asked for, under its row in the queue.
 *
 * A request that predates onboarding has none of this and renders nothing, so
 * the queue does not grow a column of empty dashes for its own history.
 */
export function OnboardingRequestDetails({ request }: { request: OnboardingRequestFacts }) {
  const areas = request.businessAreas;
  const nothingToShow = !request.region && !request.orgSizeLabel && areas.length === 0 && !request.existingOrganisation;
  if (nothingToShow) return null;

  return (
    <div className="onboard-request">
      {request.region && (
        <div className="onboard-request-row">
          <span className="onboard-request-label">Hires in</span>
          <span className="onboard-request-value">{request.region.name}</span>
        </div>
      )}
      {request.orgSizeLabel && (
        <div className="onboard-request-row">
          <span className="onboard-request-label">Size</span>
          <span className="onboard-request-value">{request.orgSizeLabel}</span>
        </div>
      )}
      {areas.length > 0 && (
        <div className="onboard-request-row">
          <span className="onboard-request-label">Hires for</span>
          <span className="onboard-request-value onboard-areas-read">
            {areas.map((area) => <span key={area.slug}>{area.name}</span>)}
          </span>
        </div>
      )}
      {request.existingOrganisation && (
        <div className="signup-flag">
          <Icon name="alert" size={13} />
          <span>“{request.existingOrganisation}” is already on Questor. This may be a second request from them, or someone reaching for their name.</span>
        </div>
      )}
    </div>
  );
}
