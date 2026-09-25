import { describe, it, expect } from 'vitest';
import {
  EMPTY_ONBOARD_FORM, PASSWORD_MIN_LENGTH, onboardFormProblem, onboardRequestBody,
  toggleBusinessArea, canAddBusinessArea, businessAreaCountLabel, filterBusinessAreas,
  onboardErrorMessage, isPlausibleEmail, type OnboardForm, type BusinessAreaOption,
} from '../src/components/onboardModel';

const COMPLETE: OnboardForm = {
  organisationName: 'Northstar Robotics',
  name: 'Priya Rao',
  email: 'priya@northstar.test',
  password: 'a'.repeat(PASSWORD_MIN_LENGTH),
  regionCode: 'IN',
  orgSize: '50-200',
  businessAreas: ['engineering'],
};

describe('onboardFormProblem', () => {
  it('accepts a completed form', () => {
    expect(onboardFormProblem(COMPLETE)).toBeNull();
  });

  it('asks for the organisation name first', () => {
    expect(onboardFormProblem(EMPTY_ONBOARD_FORM)).toContain('organisation');
  });

  it('refuses an organisation name spread over lines', () => {
    expect(onboardFormProblem({ ...COMPLETE, organisationName: 'Acme\nCorp' })).toContain('single line');
  });

  it('asks for a usable email address', () => {
    expect(onboardFormProblem({ ...COMPLETE, email: 'priya' })).toContain('work email');
  });

  it('names the password length it needs', () => {
    expect(onboardFormProblem({ ...COMPLETE, password: 'short' })).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('asks where the organisation hires', () => {
    expect(onboardFormProblem({ ...COMPLETE, regionCode: '' })).toContain('where');
  });

  it('asks how big the organisation is', () => {
    expect(onboardFormProblem({ ...COMPLETE, orgSize: '' })).toContain('how big');
  });

  it('asks for at least one business area', () => {
    expect(onboardFormProblem({ ...COMPLETE, businessAreas: [] })).toContain('at least one');
  });

  it('refuses more business areas than the limit allows', () => {
    const form = { ...COMPLETE, businessAreas: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(onboardFormProblem(form)).toContain('up to 5');
  });

  it('allows more areas when the limit was raised', () => {
    const form = { ...COMPLETE, businessAreas: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(onboardFormProblem(form, 8)).toBeNull();
  });
});

describe('isPlausibleEmail', () => {
  it('accepts an ordinary work address', () => {
    expect(isPlausibleEmail('ada@example.co.uk')).toBe(true);
  });

  it('rejects an address with no domain', () => {
    expect(isPlausibleEmail('ada@example')).toBe(false);
  });
});

describe('onboardRequestBody', () => {
  it('sends a new-organisation request', () => {
    expect(onboardRequestBody(COMPLETE).mode).toBe('new-org');
  });

  it('lowercases and trims the address', () => {
    const body = onboardRequestBody({ ...COMPLETE, email: '  Priya@Northstar.TEST ' });
    expect(body.email).toBe('priya@northstar.test');
  });

  it('trims the organisation name', () => {
    expect(onboardRequestBody({ ...COMPLETE, organisationName: '  Northstar  ' }).organisationName).toBe('Northstar');
  });
});

describe('toggleBusinessArea', () => {
  it('adds an area that was not chosen', () => {
    expect(toggleBusinessArea([], 'finance', 5)).toEqual(['finance']);
  });

  it('removes an area that was chosen', () => {
    expect(toggleBusinessArea(['finance', 'legal'], 'finance', 5)).toEqual(['legal']);
  });

  it('keeps the order they were picked in', () => {
    expect(toggleBusinessArea(['legal'], 'finance', 5)).toEqual(['legal', 'finance']);
  });

  it('refuses to add past the limit rather than dropping the first', () => {
    const full = ['a', 'b', 'c', 'd', 'e'];
    expect(toggleBusinessArea(full, 'f', 5)).toEqual(full);
  });

  it('still removes when the limit is reached', () => {
    expect(toggleBusinessArea(['a', 'b', 'c', 'd', 'e'], 'a', 5)).toEqual(['b', 'c', 'd', 'e']);
  });
});

describe('canAddBusinessArea', () => {
  it('lets an already-chosen area be unticked at the limit', () => {
    expect(canAddBusinessArea(['a', 'b', 'c', 'd', 'e'], 'a', 5)).toBe(true);
  });

  it('closes an unchosen area at the limit', () => {
    expect(canAddBusinessArea(['a', 'b', 'c', 'd', 'e'], 'f', 5)).toBe(false);
  });
});

describe('businessAreaCountLabel', () => {
  it('counts what is chosen against the limit', () => {
    expect(businessAreaCountLabel(['a', 'b'], 5)).toBe('2 of 5 chosen');
  });
});

describe('filterBusinessAreas', () => {
  const areas: BusinessAreaOption[] = [
    { slug: 'health', name: 'Healthcare, Clinical & HealthTech', summary: 'Hospitals, nurses and clinical care.' },
    { slug: 'finance', name: 'Finance, Accounting, FP&A & Corporate Treasury', summary: 'Books, planning and treasury.' },
  ];

  it('returns everything for an empty query', () => {
    expect(filterBusinessAreas(areas, '  ')).toHaveLength(2);
  });

  it('matches on the area name', () => {
    expect(filterBusinessAreas(areas, 'treasury').map((a) => a.slug)).toEqual(['finance']);
  });

  it('matches a word that only appears in the summary', () => {
    expect(filterBusinessAreas(areas, 'nurses').map((a) => a.slug)).toEqual(['health']);
  });

  it('ignores case', () => {
    expect(filterBusinessAreas(areas, 'HEALTHCARE')).toHaveLength(1);
  });
});

describe('onboardErrorMessage', () => {
  it('passes on being asked to slow down', () => {
    expect(onboardErrorMessage(429)).toContain('few minutes');
  });

  it('never relays what the server said about an organisation', () => {
    expect(onboardErrorMessage(409)).toBe(onboardErrorMessage(500));
  });

  it('points at the form when the form was the problem', () => {
    expect(onboardErrorMessage(400)).toContain('form');
  });
});
