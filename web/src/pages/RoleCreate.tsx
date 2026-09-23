import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { atsErrorMessage, isAtsId } from '../components/atsModel';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { canLoadSample, sampleDraft } from '../components/roleCreateModel';
import { RoleTitleCombobox, type CatalogRoleOption } from '../components/RoleTitleCombobox';
import { catalogLinkFields, jurisdictionAfterRegionChange, jurisdictionHint, jurisdictionsForRegion, missingRoleFields, regionHint, shouldOfferCatalogAdd } from '../components/catalogModel';
import { appendTechStack, jdOriginForSubmit, nextDraftState, previewLines, shouldPollDraft, type DraftPanelState, type LintHit } from '../components/jdDraftModel';
import { TechStackEditor } from '../components/TechStackEditor';
import { stackNames, type TechStackItem } from '../components/techStackModel';
import { useTechStackTools } from '../components/useTechStackTools';
import { useToast } from '../components/Toast';
import { SuggestedDraft } from '../components/drafts/SuggestedDraft';
import { useFieldDraft } from '../components/drafts/useFieldDraft';

type Source = 'paste' | 'ats';
interface Domain { readonly id: string; readonly name: string; readonly summary: string; readonly roleCount: number }
/** What the shared catalog is showing this organisation, and what is behind it. */
interface CatalogScope {
  readonly scoped: boolean;
  readonly areas: readonly { readonly id: string; readonly slug: string; readonly name: string }[];
  readonly limit: number;
  readonly totalDomains: number;
}
interface Region { readonly code: string; readonly name: string }
/** A finer place inside a region — a US state, or New York City. Optional. */
interface Jurisdiction { readonly code: string; readonly regionCode: string; readonly name: string; readonly why: string }
interface Band { readonly id: string; readonly display: string }

interface CreateResp {
  /** True when the requisition had been imported before; the role is that one. */
  alreadyImported?: boolean;
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string };
  scorecard: { id: string; version: number; status: string; profile: unknown };
  jdWarnings: { term: string; suggestion: string }[];
}


export function RoleCreate() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [source, setSource] = useState<Source>('paste');
  const [requisitionId, setRequisitionId] = useState('');
  const fieldId = useId();
  const [sourceText, setSourceText] = useState('');
  const [title, setTitle] = useState('');
  const [useLlm, setUseLlm] = useState(true);
  const [domains, setDomains] = useState<readonly Domain[]>([]);
  // Whether this organisation's catalog view is narrowed to its business
  // areas, and whether the person has asked to see past it for this role.
  const [scope, setScope] = useState<CatalogScope | null>(null);
  const [showAllDomains, setShowAllDomains] = useState(false);
  const [regions, setRegions] = useState<readonly Region[]>([]);
  const [jurisdictions, setJurisdictions] = useState<readonly Jurisdiction[]>([]);
  const [bands, setBands] = useState<readonly Band[]>([]);
  const [domainId, setDomainId] = useState('');
  const [experienceBand, setExperienceBand] = useState('');
  const [regionCode, setRegionCode] = useState('');
  const [jurisdictionCode, setJurisdictionCode] = useState('');
  const [catalogRoleId, setCatalogRoleId] = useState('');
  // A typed title only reaches the catalog every organisation shares if the
  // person says so. Checked by default: most typed titles are real job titles.
  const [addToCatalog, setAddToCatalog] = useState(true);
  const [techStack, setTechStack] = useState<readonly TechStackItem[]>([]);
  const techTools = useTechStackTools();
  const [notice, setNotice] = useState('');
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);

  // Errors from the title field's own "add to catalog" action, cleared as soon as the title changes.
  const [titleError, setTitleError] = useState('');
  const [warnings, setWarnings] = useState<{ term: string; suggestion: string }[]>([]);
  // Set once the role exists: the warnings are shown against it, and the way on
  // is a button rather than a timer.
  const [createdRoleId, setCreatedRoleId] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<DraftPanelState>({ kind: 'idle' });
  const [usedDraftId, setUsedDraftId] = useState('');
  const [usedDraftText, setUsedDraftText] = useState('');
  const [describedUsed, setDescribedUsed] = useState(false);
  const [describeOpen, setDescribeOpen] = useState(false);
  const [description, setDescription] = useState('');
  /**
   * A suggested draft under each of the two role-content fields. Role content
   * is authoring, not judgement: nobody is being assessed by these words, so
   * a draft here saves typing rather than pre-empting a decision
   * (components/drafts/fieldDraftVocabulary.ts).
   */
  const summaryDraft = useFieldDraft({
    field: 'role_summary', context: title, value: description, onAccept: setDescription, entityType: 'Role',
  });
  const jdDraft = useFieldDraft({
    field: 'job_description', context: title, value: sourceText, onAccept: setSourceText, entityType: 'Role',
  });
  const [describeBusy, setDescribeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<readonly Domain[]>(`/catalog/domains?scope=${showAllDomains ? 'all' : 'mine'}`),
      api.get<readonly Region[]>('/catalog/regions'),
      api.get<readonly Band[]>('/catalog/experience-bands'),
      api.get<CatalogScope>('/catalog/scope'),
      api.get<readonly Jurisdiction[]>('/catalog/jurisdictions'),
    ])
      .then(([d, r, b, s, j]) => { if (!cancelled) { setDomains(d); setRegions(r); setBands(b); setScope(s); setJurisdictions(j); setCatalogError(''); } })
      .catch((err: unknown) => { if (!cancelled) setCatalogError(err instanceof Error ? err.message : 'Could not load catalog fields.'); });
    return () => { cancelled = true; };
  }, [catalogAttempt, showAllDomains]);



  useEffect(() => {
    if (source !== 'paste' || !catalogRoleId || !experienceBand || !regionCode) {
      setDraftState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const load = () => {
      setDraftState((state) => state.kind === 'idle' ? nextDraftState(state, { type: 'request' }) : state);
      const qs = new URLSearchParams({ catalogRoleId, experienceBand, regionCode });
      api.get<{ status: string; id?: string; text: string; lint: LintHit[]; generator: string; message?: string }>(`/jd-drafts?${qs.toString()}`)
        .then((data) => {
          if (cancelled) return;
          if (data.status === 'ready' && data.id) setDraftState(nextDraftState({ kind: 'idle' }, { type: 'ready', id: data.id, text: data.text, lint: data.lint, generator: data.generator }));
          else if (data.status === 'failed') setDraftState(nextDraftState({ kind: 'idle' }, { type: 'failed', message: data.message }));
          else setDraftState((state) => {
            const next = nextDraftState(state, { type: 'pending', now: startedAt });
            if (next.kind === 'pending' && shouldPollDraft(next, Date.now() - startedAt)) timer = window.setTimeout(load, next.delayMs);
            else return { kind: 'failed', message: 'Still working. You can paste your own job description and come back later.', liveMessage: 'The suggested job description is still working.' };
            return next;
          });
        })
        .catch((err: unknown) => { if (!cancelled) setDraftState(nextDraftState({ kind: 'idle' }, { type: 'failed', message: err instanceof Error ? err.message : 'Could not load the suggested draft.' })); });
    };
    load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [source, catalogRoleId, experienceBand, regionCode, catalogAttempt]);

  const regionJurisdictions = jurisdictionsForRegion(jurisdictions, regionCode);
  // A state left over from another region is not offered by the new one, and
  // submitting it would be refused; it is dropped as the region changes.
  const chooseRegion = (code: string) => {
    setRegionCode(code);
    setJurisdictionCode(jurisdictionAfterRegionChange(jurisdictionsForRegion(jurisdictions, code), jurisdictionCode));
  };
  const selectedDomain = domains.find((d) => d.id === domainId);
  const sourceReady = source === 'ats' ? isAtsId(requisitionId.trim()) : Boolean(sourceText.trim());
  const missing = missingRoleFields({ source, sourceReady, domainId, experienceBand, regionCode });
  const canSubmit = missing.length === 0;

  // The sample loads only into an empty form, and fills the title as well as
  // the description: loading one without the other produced a role named for
  // one job with a scorecard for another.
  const sampleAllowed = canLoadSample({ sourceText, title });
  const loadSample = () => {
    if (!sampleAllowed) return;
    const draft = sampleDraft();
    setTitle(draft.title);
    setSourceText(draft.sourceText);
  };

  const offerCatalogAdd = shouldOfferCatalogAdd({ title, catalogRoleId });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Once the role exists the form is spent: a second press made a second role.
    if (createdRoleId || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const catalogFields = {
        ...catalogLinkFields({ catalogRoleId, domainId }),
        experienceBand: experienceBand || undefined,
        regionCode: regionCode || undefined,
        jurisdictionCode: jurisdictionCode || undefined,
        techStack: [...techStack],
        addToCatalog: offerCatalogAdd ? addToCatalog : false,
        jdDraftId: usedDraftId || undefined,
        jdOrigin: jdOriginForSubmit({ source, sourceText, draftText: usedDraftText, describedUsed }),
      };
      const resp = await api.post<CreateResp>('/roles', source === 'ats'
        ? { sourceType: 'ats', atsRequisitionId: requisitionId.trim(), title: title.trim() || undefined, useLlm, ...catalogFields }
        : { sourceType: 'paste', sourceText, title: title.trim() || undefined, useLlm, ...catalogFields });
      if (resp.jdWarnings && resp.jdWarnings.length) {
        // The warnings are about fairness in the wording someone is about to
        // interview against. 1200ms was never enough to read them, and the page
        // left of its own accord while they were still reading — so the role is
        // there when they are ready for it.
        setWarnings(resp.jdWarnings);
        setCreatedRoleId(resp.role.id);
        setSubmitting(false);
        return;
      }
      toast.show('Role created.');
      nav(`/roles/${resp.role.id}`);
    } catch (err: unknown) {
      // "No ATS connected" is a setup step, not a failure; say who can take it.
      if (err instanceof ApiError) setError(atsErrorMessage(err, user?.role === 'admin'));
      else setError(err instanceof Error ? err.message : 'Could not create this role.');
      setSubmitting(false);
    }
  };



  const replaceJd = (text: string) => {
    if (sourceText.trim() && !window.confirm('Replace the job description you have already entered?')) return false;
    setSourceText(text);
    return true;
  };

  const detectFromJd = async () => {
    try {
      const merged = await techTools.detect(sourceText, techStack);
      if (merged) setTechStack(merged);
      setNotice(merged ? '' : 'No technologies from the catalog were found in the job description; add them by hand.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not read technologies from the job description.');
    }
  };

  const useSuggestedDraft = () => {
    if (draftState.kind !== 'ready') return;
    if (!replaceJd(appendTechStack(draftState.text, stackNames(techStack)))) return;
    setUsedDraftId(draftState.id);
    setUsedDraftText(draftState.text);
    setDescribedUsed(false);
  };

  const draftFromMyDescription = async () => {
    setDescribeBusy(true);
    setError('');
    try {
      const resp = await api.post<{ text: string; lint: LintHit[]; generator: string }>('/jd-drafts/describe', { title: title.trim() || undefined, description, experienceBand, regionCode, domainId: domainId || undefined });
      if (replaceJd(appendTechStack(resp.text, stackNames(techStack)))) {
        setUsedDraftId('');
        setUsedDraftText('');
        setDescribedUsed(true);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not draft from that description.');
    } finally {
      setDescribeBusy(false);
    }
  };

  return (
    <div>
      <PageHeader icon="job-description" title="New role" subtitle="Paste a job description, or import a requisition from your ATS, and Questor drafts a scorecard for you to review." />

      {error && <Banner kind="error">{error}</Banner>}
      {catalogError && (
        <Banner kind="error">
          The domain, experience and region lists did not load, so a role cannot be created yet. {catalogError}{' '}
          <button type="button" className="btn secondary sm" onClick={() => setCatalogAttempt((n) => n + 1)}>
            <Icon name="refresh" size={14} />Try again
          </button>
        </Banner>
      )}
      {notice && <Banner kind="info">{notice}</Banner>}
      {warnings.length > 0 && (
        <Banner kind="info">
          <div>Job description warnings (fixing before you interview improves fairness):</div>
          <ul style={{ margin: '6px 0 0' }}>
            {warnings.map((w, i) => (
              <li key={i} className="small"><b>{w.term}</b> — {w.suggestion}</li>
            ))}
          </ul>
          {createdRoleId && (
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => nav(`/roles/${createdRoleId}`)}>
                Continue to the role<Icon name="arrow-right" size={16} />
              </button>
            </div>
          )}
        </Banner>
      )}

      {createdRoleId && (
        <p className="muted small">The role has been created. Open it from the button above to review its scorecard.</p>
      )}

      <form className="card" onSubmit={submit} hidden={createdRoleId !== null}>
        <fieldset className="row" style={{ border: 0, padding: 0, gap: 16 }}>
          <legend className="small muted">Start from</legend>
          <label className="check-row">
            <input type="radio" name="role-source" checked={source === 'paste'} onChange={() => { setSource('paste'); setError(''); }} />
            A job description
          </label>
          <label className="check-row">
            <input type="radio" name="role-source" checked={source === 'ats'} onChange={() => { setSource('ats'); setError(''); }} />
            A requisition in your ATS
          </label>
        </fieldset>

        <div className="field-grid">
          <div>
            <label htmlFor={`${fieldId}-domain`}>Domain</label>
            <select id={`${fieldId}-domain`} required value={domainId} onChange={(e) => { setDomainId(e.target.value); setCatalogRoleId(''); }}>
              <option value="">Choose a domain</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {/* The narrowing is a default view, never a wall: it says what it
                is showing and offers the rest of the catalog in one click. */}
            {scope?.scoped && (
              <p className="muted small">
                {showAllDomains
                  ? `Showing all ${scope.totalDomains} domains. `
                  : `Showing your ${scope.areas.length} business ${scope.areas.length === 1 ? 'area' : 'areas'}. `}
                <button
                  type="button" className="btn ghost sm"
                  onClick={() => { setShowAllDomains((v) => !v); setDomainId(''); setCatalogRoleId(''); }}
                >
                  {showAllDomains ? 'Show only your business areas' : `Show all ${scope.totalDomains} domains`}
                </button>
              </p>
            )}
          </div>
          <div>
            <label htmlFor={`${fieldId}-experience`}>Experience</label>
            <select id={`${fieldId}-experience`} required value={experienceBand} onChange={(e) => setExperienceBand(e.target.value)}>
              <option value="">Choose an experience band</option>
              {bands.map((b) => <option key={b.id} value={b.id}>{b.display}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${fieldId}-region`}>Region</label>
            <select id={`${fieldId}-region`} required value={regionCode} onChange={(e) => chooseRegion(e.target.value)}>
              <option value="">Choose a region</option>
              {regions.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
            {regionHint(regionCode) && <span className="muted small">{regionHint(regionCode)}</span>}
          </div>
          {/* Offered only where a finer place changes what the candidate must
              be told. Leaving it unset keeps the role under its region, which
              is how every role behaved before this existed. */}
          {regionJurisdictions.length > 0 && (
            <div>
              <label htmlFor={`${fieldId}-jurisdiction`}>State or city (optional)</label>
              <select id={`${fieldId}-jurisdiction`} value={jurisdictionCode} onChange={(e) => setJurisdictionCode(e.target.value)}>
                <option value="">Anywhere in this region</option>
                {regionJurisdictions.map((j) => <option key={j.code} value={j.code}>{j.name}</option>)}
              </select>
              <span className="muted small">{jurisdictionHint(regionJurisdictions, jurisdictionCode)}</span>
            </div>
          )}
        </div>

        <label htmlFor={`${fieldId}-title`}>Role title (optional)</label>
        <RoleTitleCombobox
          inputId={`${fieldId}-title`}
          domainId={domainId}
          domainName={selectedDomain?.name ?? 'this domain'}
          value={title}
          techStack={stackNames(techStack)}
          disabled={!domainId}
          onTitleChange={(value) => { setTitle(value); setCatalogRoleId(''); setTitleError(''); }}
          onSelect={(role: CatalogRoleOption) => { setCatalogRoleId(role.id); setTitle(role.title); setTitleError(''); }}
          onNotice={(message) => { setTitleError(''); setNotice(message); }}
          onError={(message) => { setNotice(''); setTitleError(message); }}
        />
        {titleError && <p className="field-hint field-problem" role="alert">{titleError}</p>}
        <div className="muted small">Choose a catalog title, or type your own. Left blank, the title is taken from the {source === 'ats' ? 'requisition' : 'job description'}.</div>

        <label htmlFor={`${fieldId}-tech`}>Tech stack (optional)</label>
        <TechStackEditor idPrefix={fieldId} value={techStack} onChange={setTechStack} catalog={techTools.catalog} />
        <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 6 }}>
          {source === 'paste' && (
            <button type="button" className="btn secondary sm" onClick={() => void detectFromJd()} disabled={techTools.detecting || !sourceText.trim()} data-testid="tech-stack-detect">
              <Icon name={techTools.detecting ? 'hourglass' : 'sparkle'} size={14} />{techTools.detecting ? 'Reading…' : 'Suggest from the job description'}
            </button>
          )}
          <span className="muted small">Each required technology becomes a technical competency, graded to its level and the experience band.</span>
        </div>

        {offerCatalogAdd && (
          <label className="check-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={addToCatalog} onChange={(e) => setAddToCatalog(e.target.checked)} />
            Add this title to the shared role catalog (visible to all organisations)
          </label>
        )}


        {source === 'paste' && catalogRoleId && experienceBand && regionCode && (
          <section className="card" aria-labelledby={`${fieldId}-suggested-title`} style={{ marginTop: 16, borderStyle: 'solid' }}>
            <div id={`${fieldId}-suggested-status`} className="sr-only" aria-live="polite">{'liveMessage' in draftState ? draftState.liveMessage : ''}</div>
            <h3 id={`${fieldId}-suggested-title`} style={{ marginTop: 0 }}>Suggested job description</h3>
            {(draftState.kind === 'loading' || draftState.kind === 'pending') && <p className="muted small">Preparing a suggested draft. You can keep typing or paste your own JD.</p>}
            {draftState.kind === 'ready' && (
              <>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: draftState.expanded ? undefined : 360 }}>{previewLines(draftState.text, draftState.expanded)}</pre>
                {draftState.text.split('\n').length > 12 && <button type="button" className="link-button" onClick={() => setDraftState(nextDraftState(draftState, { type: 'toggle' }))}>{draftState.expanded ? 'Show less' : 'Show all'}</button>}
                {draftState.lint.length > 0 && <p className="small">Consider rewording: {draftState.lint.map((l) => `${l.term} (${l.suggestion})`).join('; ')}</p>}
                <div className="row">
                  <button type="button" className="btn secondary" onClick={useSuggestedDraft}>Use this draft</button>
                  <button type="button" className="btn secondary" onClick={() => setDescribeOpen((v) => !v)}>Describe the role instead</button>
                </div>
              </>
            )}
            {draftState.kind === 'failed' && <p className="muted small">{draftState.message} <button type="button" className="link-button" onClick={() => setCatalogAttempt((n) => n + 1)}>Try again</button></p>}
            {(describeOpen || draftState.kind === 'failed') && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor={`${fieldId}-describe`}>Describe the role</label>
                <textarea
                  id={`${fieldId}-describe`}
                  value={description}
                  onChange={(e) => { summaryDraft.onTyped(); setDescription(e.target.value); }}
                  onFocus={summaryDraft.onFocus}
                  onKeyDown={summaryDraft.onKeyDown}
                  aria-describedby={summaryDraft.describedBy}
                  placeholder="In a few sentences: what will this person own, who do they work with, what does success look like?"
                  style={{ minHeight: 120 }}
                />
                <SuggestedDraft draft={summaryDraft} />
                <button type="button" className="btn secondary" disabled={describeBusy || description.trim().length < 40} onClick={draftFromMyDescription}>Draft from my description</button>
              </div>
            )}
          </section>
        )}

        {source === 'ats' ? (
          <>
            <label htmlFor={`${fieldId}-req`}>ATS requisition id</label>
            <input
              id={`${fieldId}-req`}
              value={requisitionId}
              onChange={(e) => setRequisitionId(e.target.value)}
              placeholder="e.g. REQ-1042"
              pattern="[A-Za-z0-9_\-]{1,64}"
              title="Letters, numbers, dashes or underscores"
              required
            />
            <div className="muted small">Imported from your organisation's own ATS. Importing the same requisition again opens the role it already made.</div>
          </>
        ) : (
          <>
            <label htmlFor={`${fieldId}-jd`}>Job description</label>
            <textarea
              id={`${fieldId}-jd`}
              value={sourceText}
              onChange={(e) => { jdDraft.onTyped(); setSourceText(e.target.value); }}
              onFocus={jdDraft.onFocus}
              onKeyDown={jdDraft.onKeyDown}
              aria-describedby={jdDraft.describedBy}
              placeholder="Paste the full job description here…"
              style={{ minHeight: 220 }}
              required
            />
            <SuggestedDraft draft={jdDraft} />
          </>
        )}

        <label className="check-row" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
          />
          Use AI extraction (falls back to built-in extractor)
        </label>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={submitting || !canSubmit}>
            <Icon name={submitting ? 'hourglass' : 'sparkle'} size={16} />
            {submitting ? (source === 'ats' ? 'Importing…' : 'Creating…') : (source === 'ats' ? 'Import role' : 'Create role')}
          </button>
          {/* Development only. A button that fills a real hiring form with a
              made-up job has no business in a console someone hires from. */}
          {import.meta.env.DEV && source === 'paste' && (
            <button
              className="btn secondary"
              type="button"
              onClick={loadSample}
              disabled={!sampleAllowed}
              aria-describedby="sample-jd-hint"
            >
              <Icon name="job" size={16} />
              Load sample JD
            </button>
          )}
          {!canSubmit && !submitting && (
            <span className="muted small" role="status">Still needed: {missing.join(', ')}.</span>
          )}
          {import.meta.env.DEV && source === 'paste' && !sampleAllowed && (
            <span id="sample-jd-hint" className="muted small">
              The sample only loads into an empty form, so it never replaces what you have written.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
