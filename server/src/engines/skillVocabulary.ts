/**
 * Which skills a document names.
 *
 * Replaces a thirty-six entry list of engineering tools matched with
 * `text.toLowerCase().includes(term)`. Both halves were wrong.
 *
 * The matching was wrong because a substring is not a word. `'go'` matched
 * "Google", "go-to-market" and "ongoing"; `'java'` matches "JavaScript";
 * `'r'` would match everything. A senior marketing manager's CV came back as
 * ["Salesforce", "Go"] — one real skill, one artefact of the word "Google".
 *
 * The list was wrong because it only described one job. Questor interviews
 * marketers, finance managers, recruiters, nurses and lawyers, and every one
 * of them arrived looking unskilled, which is a fairness problem before it is
 * a quality one: the parsed skills are shown to the hiring team beside the
 * candidate's name.
 *
 * So: a vocabulary with aliases, matched on word boundaries, longest name
 * first, and case-sensitively for the handful of names that are also ordinary
 * words. The canonical name is what gets displayed, so "GA4", "Google
 * Analytics 4" and "google analytics" all show as one skill rather than three.
 *
 * This list is hand-curated and deliberately finite. It is not a claim to have
 * enumerated human skill — it is the set we can name with confidence, and
 * anything outside it is simply not asserted rather than guessed at.
 */

export interface SkillEntry {
  /** What the hiring team sees. */
  readonly name: string;
  /** Everything that means the same thing, lower case. The canonical name is implied. */
  readonly aliases?: readonly string[];
  /**
   * The name is also an ordinary English word, so it only counts when the
   * document capitalises it as a name: Go, R, Rust, Swift, Sage, Spark.
   */
  readonly caseSensitive?: boolean;
  /**
   * The canonical name is a display label, not something to search for. Used
   * where the name on its own is too ambiguous to match — "R" — so only the
   * aliases identify it.
   */
  readonly nameIsNotATerm?: boolean;
}

const ENGINEERING: readonly SkillEntry[] = [
  { name: 'SQL' }, { name: 'Python' }, { name: 'Java' }, { name: 'JavaScript', aliases: ['js', 'ecmascript'] },
  { name: 'TypeScript' }, { name: 'React', aliases: ['react.js', 'reactjs'] }, { name: 'Node.js', aliases: ['nodejs', 'node js'] },
  { name: 'Go', caseSensitive: true, aliases: ['golang'] }, { name: 'Rust', caseSensitive: true }, { name: 'C++' },
  { name: 'C#', aliases: ['.net', 'dotnet'] }, { name: 'Ruby' }, { name: 'PHP' }, { name: 'Swift', caseSensitive: true },
  { name: 'Kotlin' }, { name: 'Scala' },
  // A lone capital R is a letter far more often than it is a language: a
  // middle initial, a grade, a column heading. It has to say so.
  { name: 'R', aliases: ['r programming', 'r language', 'rstats', 'rstudio', 'r studio'], nameIsNotATerm: true },
  { name: 'AWS', aliases: ['amazon web services'] }, { name: 'Azure' }, { name: 'Google Cloud', aliases: ['gcp'] },
  { name: 'Kubernetes', aliases: ['k8s'] }, { name: 'Docker' }, { name: 'Terraform' }, { name: 'CI/CD', aliases: ['cicd', 'continuous integration'] },
  { name: 'Git' }, { name: 'GraphQL' }, { name: 'REST APIs', aliases: ['rest api', 'restful'] }, { name: 'Microservices' },
  { name: 'Linux' }, { name: 'Vue.js', aliases: ['vue', 'vuejs'] }, { name: 'Angular' }, { name: 'Django' },
  { name: 'Spring Boot', aliases: ['spring'] }, { name: 'Jenkins' }, { name: 'Ansible' }, { name: 'Redis' },
];

const DATA: readonly SkillEntry[] = [
  { name: 'Spark', caseSensitive: true, aliases: ['apache spark', 'pyspark'] }, { name: 'Airflow', aliases: ['apache airflow'] },
  { name: 'dbt' }, { name: 'Snowflake' }, { name: 'BigQuery' }, { name: 'Redshift' }, { name: 'Databricks' },
  { name: 'PostgreSQL', aliases: ['postgres'] }, { name: 'MySQL' }, { name: 'MongoDB' }, { name: 'Kafka', aliases: ['apache kafka'] },
  { name: 'Pandas' }, { name: 'TensorFlow' }, { name: 'PyTorch' }, { name: 'Machine Learning', aliases: ['ml'] },
  { name: 'NLP', aliases: ['natural language processing'] }, { name: 'Tableau' }, { name: 'Power BI', aliases: ['powerbi'] },
  { name: 'Looker Studio', aliases: ['data studio', 'looker'] }, { name: 'Data Modelling', aliases: ['data modeling'] },
  { name: 'ETL', aliases: ['elt'] }, { name: 'Data Warehousing', aliases: ['data warehouse'] }, { name: 'A/B Testing', aliases: ['ab testing', 'split testing'] },
  { name: 'Statistical Analysis', aliases: ['statistics'] }, { name: 'Forecasting' },
];

const MARKETING: readonly SkillEntry[] = [
  { name: 'SEO', aliases: ['search engine optimisation', 'search engine optimization'] },
  { name: 'SEM', aliases: ['paid search', 'search engine marketing'] },
  { name: 'Google Ads', aliases: ['adwords', 'google adwords'] }, { name: 'Meta Ads', aliases: ['facebook ads', 'meta ads manager'] },
  { name: 'LinkedIn Ads', aliases: ['linkedin campaign manager'] }, { name: 'Sales Navigator', aliases: ['linkedin sales navigator'] },
  { name: 'Google Analytics', aliases: ['ga4', 'google analytics 4'] }, { name: 'Google Search Console', aliases: ['search console'] },
  { name: 'HubSpot' }, { name: 'Marketo' }, { name: 'Eloqua', aliases: ['oracle eloqua'] }, { name: 'Pardot' },
  { name: 'Mailchimp' }, { name: 'Braze' }, { name: 'Brevo', aliases: ['sendinblue'] }, { name: 'Klaviyo' },
  { name: 'Marketing Automation' }, { name: 'Email Marketing' }, { name: 'Demand Generation', aliases: ['demand gen', 'lead generation', 'lead gen'] },
  { name: 'ABM', aliases: ['account-based marketing', 'account based marketing'] }, { name: '6sense' }, { name: 'Demandbase' },
  { name: 'Content Marketing' }, { name: 'Content Strategy' }, { name: 'Social Media Marketing', aliases: ['social media management'] },
  { name: 'Brand Management', aliases: ['brand strategy', 'branding'] }, { name: 'Product Marketing' },
  { name: 'Go-to-Market', aliases: ['gtm', 'go to market'] }, { name: 'Campaign Management', aliases: ['campaign planning'] },
  { name: 'Conversion Rate Optimisation', aliases: ['cro', 'conversion rate optimization'] },
  { name: 'Performance Marketing', aliases: ['paid media', 'paid social'] }, { name: 'Influencer Marketing' },
  { name: 'Event Marketing', aliases: ['events marketing', 'webinars'] }, { name: 'Copywriting' },
  { name: 'Market Research', aliases: ['competitor analysis', 'consumer research'] }, { name: 'Marketing Budget Management', aliases: ['marketing budget'] },
  { name: 'Lifecycle Marketing', aliases: ['nurture campaigns', 'lead nurturing'] }, { name: 'Webflow' }, { name: 'WordPress' },
  { name: 'Canva' }, { name: 'Adobe Creative Suite', aliases: ['photoshop', 'illustrator', 'indesign'] },
];

const SALES_AND_CS: readonly SkillEntry[] = [
  { name: 'Salesforce', aliases: ['sfdc', 'salesforce sales cloud'] }, { name: 'CRM' }, { name: 'Zoho' },
  { name: 'Pipeline Management', aliases: ['pipeline development'] }, { name: 'Account Management' },
  { name: 'Business Development' }, { name: 'Channel Partnerships', aliases: ['partner management', 'channel sales'] },
  { name: 'Negotiation' }, { name: 'Customer Success' }, { name: 'Key Account Management' },
  { name: 'Territory Management' }, { name: 'Sales Forecasting' }, { name: 'Outreach', aliases: ['outbound', 'cold outreach'] },
];

const FINANCE: readonly SkillEntry[] = [
  { name: 'Financial Modelling', aliases: ['financial modeling'] }, { name: 'Budgeting' }, { name: 'Forecasting & Planning', aliases: ['fp&a'] },
  { name: 'Management Accounting' }, { name: 'Financial Reporting' }, { name: 'IFRS' }, { name: 'GAAP', aliases: ['us gaap'] },
  { name: 'Audit', aliases: ['internal audit', 'external audit'] }, { name: 'Tax', aliases: ['taxation', 'corporate tax'] },
  { name: 'SAP' }, { name: 'Oracle Financials', aliases: ['oracle erp'] }, { name: 'NetSuite' }, { name: 'QuickBooks' },
  { name: 'Xero' }, { name: 'Sage', caseSensitive: true }, { name: 'Treasury' }, { name: 'Risk Management' },
  { name: 'Valuation' }, { name: 'Due Diligence' }, { name: 'Excel', aliases: ['advanced excel', 'microsoft excel'] },
];

const PEOPLE_AND_OPS: readonly SkillEntry[] = [
  { name: 'Recruitment', aliases: ['talent acquisition', 'hiring'] }, { name: 'Onboarding' },
  { name: 'Performance Management' }, { name: 'Employee Relations' }, { name: 'Compensation & Benefits', aliases: ['compensation and benefits', 'comp and ben'] },
  { name: 'Learning & Development', aliases: ['learning and development', 'l&d', 'training and development'] },
  { name: 'Workday' }, { name: 'SuccessFactors' }, { name: 'BambooHR' },
  { name: 'Stakeholder Management' }, { name: 'Vendor Management' }, { name: 'Process Improvement' },
  { name: 'Lean', aliases: ['lean six sigma'] }, { name: 'Six Sigma' }, { name: 'Supply Chain Management', aliases: ['supply chain'] },
  { name: 'Procurement' }, { name: 'Logistics' }, { name: 'Inventory Management' },
];

const PRODUCT_AND_DESIGN: readonly SkillEntry[] = [
  { name: 'Product Management' }, { name: 'Roadmapping', aliases: ['product roadmap'] }, { name: 'User Research' },
  { name: 'Agile' }, { name: 'Scrum' }, { name: 'Kanban' }, { name: 'Jira' }, { name: 'Confluence' },
  { name: 'Figma' }, { name: 'Sketch', caseSensitive: true }, { name: 'UX Design', aliases: ['user experience design'] },
  { name: 'UI Design', aliases: ['user interface design'] }, { name: 'Prototyping' }, { name: 'Wireframing' },
  { name: 'Design Systems' }, { name: 'Accessibility', aliases: ['wcag', 'a11y'] },
];

const REGULATED: readonly SkillEntry[] = [
  { name: 'GDPR' }, { name: 'Compliance' }, { name: 'Contract Law', aliases: ['contract drafting', 'contract negotiation'] },
  { name: 'Litigation' }, { name: 'Intellectual Property', aliases: ['ip law'] }, { name: 'Corporate Governance' },
  { name: 'Anti-Money Laundering', aliases: ['aml', 'kyc'] }, { name: 'Clinical Research' }, { name: 'Patient Care' },
  { name: 'Medical Coding' }, { name: 'HIPAA' }, { name: 'Quality Assurance', aliases: ['qa'] },
  { name: 'Health & Safety', aliases: ['health and safety', 'hse'] }, { name: 'ISO 9001', aliases: ['iso9001'] },
];

export const SKILL_VOCABULARY: readonly SkillEntry[] = [
  ...ENGINEERING, ...DATA, ...MARKETING, ...SALES_AND_CS,
  ...FINANCE, ...PEOPLE_AND_OPS, ...PRODUCT_AND_DESIGN, ...REGULATED,
];

/**
 * Regex-safe, and tolerant of the separators a CV uses between the same two
 * words: "Node.js" is also written "Node js", "go-to-market" also "go to
 * market".
 *
 * That flexibility is only ever allowed BETWEEN characters, never at an edge.
 * Allowed at the start, the alias ".net" compiled to an optional separator
 * followed by "net", so it matched the bare word "net" — and a marketer who
 * "influenced $21M+ in net-new pipeline" was credited with C#.
 */
function termPattern(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = escaped.startsWith('\\.') ? '\\.' : '';
  const body = head ? escaped.slice(2) : escaped;
  return head + body.replace(/\\\.|[\s-]/g, '[\\s.\\-]*');
}

/**
 * `\b` is no use at either end of "C++", ".NET" or "C#", whose edges are not
 * word characters. These assert "not surrounded by a letter or digit" instead,
 * which is the property we actually want.
 */
function boundedPattern(term: string): RegExp {
  // A short name needs a stricter edge than a long one. "Go" sits on a plain
  // word boundary inside "Go-to-market" and "Go-live", and a two-letter skill
  // claimed out of a hyphenated phrase is the exact false positive this module
  // exists to stop — so short terms refuse an adjacent hyphen as well.
  const edge = term.length <= 3 ? 'A-Za-z0-9\\-' : 'A-Za-z0-9';
  return new RegExp(`(?<![${edge}])${termPattern(term)}(?![${edge}])`);
}

interface CompiledTerm {
  readonly entry: SkillEntry;
  readonly re: RegExp;
  readonly caseSensitive: boolean;
  readonly length: number;
}

const COMPILED: readonly CompiledTerm[] = SKILL_VOCABULARY.flatMap((entry) => {
  const terms = entry.nameIsNotATerm ? [...(entry.aliases ?? [])] : [entry.name, ...(entry.aliases ?? [])];
  return terms.map((term) => ({
    entry,
    re: entry.caseSensitive ? boundedPattern(term) : new RegExp(boundedPattern(term).source, 'i'),
    caseSensitive: entry.caseSensitive === true,
    length: term.length,
  }));
  // Longest first so "Google Analytics 4" is found before "Google Ads" can
  // claim the word "Google", and "LinkedIn Ads" before "LinkedIn".
}).sort((a, b) => b.length - a.length);

/**
 * The skills a document names, as canonical names, in vocabulary order so the
 * same CV always lists them the same way.
 *
 * A case-sensitive entry is matched against the text as written: "Go" counts,
 * "going" and "go-to-market" do not, and neither does a CV shouting every
 * heading in capitals, because the match still has to sit on a word boundary.
 */
export function matchSkills(text: string, limit = 40): string[] {
  const found = new Set<string>();
  for (const term of COMPILED) {
    if (found.has(term.entry.name)) continue;
    if (term.re.test(text)) found.add(term.entry.name);
  }
  return SKILL_VOCABULARY.filter((e) => found.has(e.name)).map((e) => e.name).slice(0, limit);
}
