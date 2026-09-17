import { describe, it, expect } from 'vitest';
import { CONNECTOR_GUIDES, guideFor, callbackUrlsFor, statusLabel } from '../src/components/connectorGuides';

/**
 * The setup guides are data, so they are tested as data: the variable names
 * shown to an admin must be exactly the ones the server reads, and nothing in a
 * guide may look like a real credential.
 */

// Mirrors server/src/providers/meeting/connectorEnv.ts (MEETING_ENV plus
// ROUND_ORGANISER_ENV), email/index.ts and
// ats/index.ts + config.ts. If a name changes on the server, this must change too.
const SERVER_ENV: Record<string, string[]> = {
  hosted: [],
  zoom: ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID'],
  teams: ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'MS_GRAPH_ORGANIZER_USER_ID'],
  meet: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_IMPERSONATED_USER'],
  'email-sendgrid': ['EMAIL_PROVIDER', 'SENDGRID_API_KEY', 'EMAIL_FROM'],
  'email-smtp': ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'],
  ats: ['ATS_PROVIDER', 'ATS_BASE_URL', 'ATS_API_KEY'],
};

describe('connector guides', () => {
  for (const [id, names] of Object.entries(SERVER_ENV)) {
    it(`lists exactly the server's variable names for ${id}`, () => {
      expect(guideFor(id)?.envVars.map((v) => v.name)).toEqual(names);
    });
  }

  it('says the hosted room needs no credentials', () => {
    expect(guideFor('hosted')?.steps.join(' ')).toMatch(/no credentials/i);
  });

  it('links every guide to an https documentation page', () => {
    expect(CONNECTOR_GUIDES.every((g) => /^https:\/\//.test(g.docsUrl))).toBe(true);
  });

  it('uses angle-bracket placeholders rather than realistic-looking values', () => {
    const placeholders = CONNECTOR_GUIDES.flatMap((g) => g.envVars.map((v) => v.placeholder));
    expect(placeholders.every((p) => /^<[^<>]+>$/.test(p) || /^[a-z0-9.-]+$/i.test(p))).toBe(true);
  });

  it('returns undefined for an unknown connector id', () => {
    expect(guideFor('webex')).toBeUndefined();
  });

  it('derives the hosted room link from the public URL without a trailing slash', () => {
    expect(callbackUrlsFor(guideFor('hosted')!, 'https://hire.yourco.com/').map((c) => c.url))
      .toEqual(['https://hire.yourco.com/api/health']);
  });

  it('labels status from presence flags only', () => {
    expect([statusLabel(true), statusLabel(false)]).toEqual(['Configured', 'Not configured']);
  });
});
