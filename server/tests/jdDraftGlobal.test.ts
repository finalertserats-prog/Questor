import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Global role is open everywhere, so its job description must not tie it to
 * one place: no country, city, currency, visa or work-permit rule, or law of a
 * single jurisdiction — in the built-in writer, in what the model is told, and
 * in what the model's answer is allowed to contain.
 */

interface JsonCall { readonly system: string; readonly user: string }
const calls: JsonCall[] = [];

vi.mock('../src/providers/llm/index.js', () => ({
  generateJson: vi.fn(async (opts: JsonCall) => {
    calls.push({ system: opts.system, user: opts.user });
    return null;
  }),
}));

const {
  GLOBAL_REGION_CODE,
  draftJdFromDescriptionHeuristic,
  draftJdFromDescriptionWithLlm,
  draftJdHeuristic,
  draftJdWithLlm,
  locationSpecificClaims,
} = await import('../src/engines/jdDraft.js');

const base = {
  title: 'Platform Engineer',
  domainName: 'Software Engineering',
  familyName: 'Engineering',
  summary: 'Build reliable internal platforms.',
  marketSignal: 'Stable',
  band: 'senior' as const,
};
const global = { ...base, regionName: 'Global (all regions)', regionCode: GLOBAL_REGION_CODE };
const india = { ...base, regionName: 'India', regionCode: 'IN' };
const describeInput = { title: 'Payments Engineer', description: 'You will run our card payments platform.', band: 'senior' as const };

/** Words that would tie a Global advert to one place. */
const PLACE_SPECIFIC = /\bvisa\b|work permit|sponsor|\bUSD\b|\bINR\b|\bGBP\b|\bEUR\b|[$£€₹]|India|United States|London|GDPR/i;

function locationSection(text: string): string {
  const lines = text.split('\n');
  return lines[lines.indexOf('Location') + 1] ?? '';
}

beforeEach(() => {
  calls.length = 0;
});

describe('the built-in writer for a Global role', () => {
  it('says the role is open across regions and remote-friendly', () => {
    expect(locationSection(draftJdHeuristic(global))).toBe('Open to candidates in multiple regions; remote-friendly.');
  });

  it('never names a place, currency or visa rule', () => {
    expect(draftJdHeuristic(global)).not.toMatch(PLACE_SPECIFIC);
  });

  it('writes the same Location line when drafting from a description', () => {
    expect(locationSection(draftJdFromDescriptionHeuristic({ ...describeInput, regionName: global.regionName, regionCode: GLOBAL_REGION_CODE })))
      .toBe('Open to candidates in multiple regions; remote-friendly.');
  });

  it('still names a specific region as before', () => {
    expect(locationSection(draftJdHeuristic(india))).toBe('India.');
  });
});

describe('what the model is told for a Global role', () => {
  it('forbids country, city, currency, visa and jurisdiction-specific claims', async () => {
    await draftJdWithLlm(global);
    expect(calls[0].system).toMatch(/do not name any country, city, currency, visa or work-permit rule, or law/i);
  });

  it('gives a location-agnostic location rather than the catalog name', async () => {
    await draftJdWithLlm(global);
    expect(JSON.parse(calls[0].user).location).toBe('Multiple regions (remote-friendly)');
  });

  it('carries the same rule when drafting from a description', async () => {
    await draftJdFromDescriptionWithLlm({ ...describeInput, regionName: global.regionName, regionCode: GLOBAL_REGION_CODE });
    expect(calls[0].system).toMatch(/do not name any country, city, currency, visa or work-permit rule, or law/i);
  });

  it('adds no Global rule for a specific region', async () => {
    await draftJdWithLlm(india);
    expect({ rule: /multiple regions/i.test(calls[0].system), location: JSON.parse(calls[0].user).location }).toEqual({ rule: false, location: 'India' });
  });
});

describe('locationSpecificClaims', () => {
  it('finds visa, currency and country claims', () => {
    expect(locationSpecificClaims('Salary in USD. We sponsor visas for India.').length).toBeGreaterThanOrEqual(3);
  });

  it('finds currency codes and names whatever their case', () => {
    expect(locationSpecificClaims('Paid in usd, or in rupees.')).toEqual(['usd', 'rupees']);
  });

  it('finds nothing in a location-agnostic advert', () => {
    expect(locationSpecificClaims(draftJdHeuristic(global))).toEqual([]);
  });
});
