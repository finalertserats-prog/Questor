import { config } from '../../config.js';
import { logger } from '../../logger.js';

// ATS connector abstraction (BRD FR-040). Generic REST/CSV connector ships by
// default; Greenhouse shown as a named-provider example. Field mapping and sync
// errors are surfaced to the caller.

export interface AtsRequisition {
  externalId: string;
  title: string;
  description: string;
  level?: string;
  location?: string;
}

export interface AtsProvider {
  name: string;
  configured: boolean;
  fetchRequisition(externalId: string): Promise<AtsRequisition>;
  pushAssessment(externalCandidateId: string, payload: unknown): Promise<{ status: string }>;
}

class GenericAtsProvider implements AtsProvider {
  name = 'generic';
  configured = false;
  constructor() {
    this.configured = !!config.ats.baseUrl;
  }
  async fetchRequisition(externalId: string): Promise<AtsRequisition> {
    if (!config.ats.baseUrl) throw new Error('ATS_BASE_URL not configured');
    const res = await fetch(`${config.ats.baseUrl}/requisitions/${externalId}`, {
      headers: config.ats.apiKey ? { authorization: `Bearer ${config.ats.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`ATS fetch error ${res.status}`);
    const d: any = await res.json();
    return {
      externalId,
      title: d.title ?? d.name ?? '',
      description: d.description ?? d.jobDescription ?? '',
      level: d.level,
      location: d.location,
    };
  }
  async pushAssessment(externalCandidateId: string, payload: unknown) {
    if (!config.ats.baseUrl) {
      logger.info({ externalCandidateId }, 'ATS not configured; assessment export is a no-op.');
      return { status: 'skipped' };
    }
    const res = await fetch(`${config.ats.baseUrl}/candidates/${externalCandidateId}/assessments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.ats.apiKey ? { authorization: `Bearer ${config.ats.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`ATS push error ${res.status}`);
    return { status: 'exported' };
  }
}

class GreenhouseAtsProvider extends GenericAtsProvider {
  name = 'greenhouse';
  // Greenhouse Harvest API shape differs; this subclass documents the seam.
}

let cached: AtsProvider | null = null;
export function getAts(): AtsProvider {
  if (cached) return cached;
  cached = config.ats.provider === 'greenhouse' ? new GreenhouseAtsProvider() : new GenericAtsProvider();
  return cached;
}
