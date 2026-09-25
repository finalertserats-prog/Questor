/**
 * The jurisdiction a role is under.
 *
 * It was the role's region code and nothing else, which is correct until it
 * reaches the United States. Illinois, New York City, Maryland and Colorado all
 * have their own rules about telling a candidate an AI is involved in hiring
 * them, and all four were simply `NA` to this software — so none of those rules
 * could be triggered by the product (legal review pack, question 14).
 *
 * A role may now also carry a finer value. It is OPTIONAL and it changes
 * nothing for a role that does not have one: `jurisdictionFor` with no
 * subdivision returns exactly what `jurisdictionForRegion` returned before,
 * which is what keeps every existing role working. Where a role does have one,
 * the jurisdiction becomes the finer code and the notices that place asks for
 * are added to the role's required disclosures.
 *
 * NOT LEGAL ADVICE. The notice lines below are the product team's reading of
 * what each place asks, written so a customer can see what Questor will tell a
 * candidate. They are in the legal review pack for a solicitor to correct.
 */

export interface JurisdictionSubdivision {
  /** The stored value, e.g. "US-IL". Uppercase, at most 16 characters. */
  readonly code: string;
  /** The region it sits inside. */
  readonly regionCode: string;
  /** For a picker and for reading back, e.g. "United States — Illinois". */
  readonly name: string;
  /** Why this place is offered at all, in one line. */
  readonly why: string;
  /** Added to the role's requiredDisclosures. Our words, unreviewed. */
  readonly notices: readonly string[];
}

/**
 * The places offered, and only these. Each is here because it has a rule about
 * AI in hiring that the other places in its region do not; a state with nothing
 * specific to say is better left as the region, where it behaves as it always
 * has, than listed with no notices behind it.
 */
export const JURISDICTION_SUBDIVISIONS: readonly JurisdictionSubdivision[] = [
  {
    code: 'US-IL',
    regionCode: 'NA',
    name: 'United States — Illinois',
    why: 'Illinois has its own rules about AI in interviews and about what a candidate must be told.',
    notices: [
      'Illinois: that artificial intelligence is used in this interview, what it considers, and that the candidate may ask for their interview data to be deleted',
    ],
  },
  {
    code: 'US-NY-NYC',
    regionCode: 'NA',
    name: 'United States — New York City',
    why: 'New York City requires notice before an automated employment decision tool is used, and an alternative on request.',
    notices: [
      'New York City: that an automated employment decision tool will be used, at least ten business days before the interview',
      'New York City: the job qualifications and characteristics the tool assesses',
      'New York City: that the candidate may request an alternative selection process or an accommodation',
    ],
  },
  {
    code: 'US-NY',
    regionCode: 'NA',
    name: 'United States — New York State (outside New York City)',
    why: 'Kept apart from the city so a role outside it does not carry the city\'s notice period.',
    notices: [],
  },
  {
    code: 'US-MD',
    regionCode: 'NA',
    name: 'United States — Maryland',
    why: 'Maryland limits facial recognition in a job interview without written consent.',
    notices: [
      'Maryland: that no facial recognition is used — Questor has no camera and no video at any point',
    ],
  },
  {
    code: 'US-CO',
    regionCode: 'NA',
    name: 'United States — Colorado',
    why: 'Colorado places a duty of care on deployers of high-risk AI in employment.',
    notices: [
      'Colorado: that a high-risk artificial intelligence system is used in this hiring process, and what it is used for',
    ],
  },
];

const BY_CODE = new Map(JURISDICTION_SUBDIVISIONS.map((s) => [s.code, s]));

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * The jurisdiction a role is under is its region's code. GLOBAL is its own
 * value, meaning no single jurisdiction; a role without a region is blank
 * rather than defaulting to one country's rules.
 */
export function jurisdictionForRegion(regionCode: string | null | undefined): string {
  return normalise(regionCode);
}

/** The finer places offered inside a region; empty where none are. */
export function subdivisionsForRegion(regionCode: string | null | undefined): readonly JurisdictionSubdivision[] {
  const region = normalise(regionCode);
  return JURISDICTION_SUBDIVISIONS.filter((s) => s.regionCode === region);
}

export function subdivisionByCode(code: string | null | undefined): JurisdictionSubdivision | null {
  return BY_CODE.get(normalise(code)) ?? null;
}

/**
 * Whether this finer value may be stored against this region. A subdivision
 * that does not belong to the region is a mistake, not a narrowing, and is
 * refused at the API rather than silently kept.
 */
export function subdivisionBelongsToRegion(code: string | null | undefined, regionCode: string | null | undefined): boolean {
  const found = subdivisionByCode(code);
  return found !== null && found.regionCode === normalise(regionCode);
}

/**
 * The role's jurisdiction: the finer value where the role has one that belongs
 * to its region, and otherwise the region code exactly as before. A role with
 * no finer value is indistinguishable from a role written before finer values
 * existed, which is the point.
 */
export function jurisdictionFor(opts: {
  readonly regionCode?: string | null;
  readonly jurisdictionCode?: string | null;
}): string {
  return subdivisionBelongsToRegion(opts.jurisdictionCode, opts.regionCode)
    ? normalise(opts.jurisdictionCode)
    : jurisdictionForRegion(opts.regionCode);
}

/**
 * The extra notices a candidate interviewing for this role must be given,
 * beyond the three every role carries. Empty for every jurisdiction that is
 * only a region, so nothing changes for a role that has no finer value.
 */
export function jurisdictionNotices(jurisdiction: string | null | undefined): readonly string[] {
  return subdivisionByCode(jurisdiction)?.notices ?? [];
}
