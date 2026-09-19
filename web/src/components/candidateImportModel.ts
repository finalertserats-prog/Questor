import { ApiError } from '../api/client';
import { isAtsId } from './atsModel';

// Rules behind Add Candidate: a person is either typed in or imported from the
// organisation's ATS. An import brings only contact details, so the resume is
// optional there and can be added from the candidate page afterwards.

export type CandidateSource = 'manual' | 'ats';

export interface AddCandidateForm {
  readonly source: CandidateSource;
  readonly roleId: string;
  readonly fullName: string;
  readonly email: string;
  readonly externalCandidateId: string;
  readonly hasFile: boolean;
  readonly resumeText: string;
}

export interface ImportResult {
  readonly candidate: { readonly id: string; readonly fullName: string };
  readonly alreadyImported: boolean;
}

/** Why the form cannot be sent yet, in words for the person filling it; null when it can. */
export function addCandidateBlocker(form: AddCandidateForm): string | null {
  if (!form.roleId) return 'Choose a role with an approved scorecard first.';
  if (form.source === 'ats') {
    const id = form.externalCandidateId.trim();
    if (!id) return 'Enter the candidate id from your ATS.';
    if (!isAtsId(id)) return 'An ATS candidate id is letters, numbers, dashes or underscores.';
    return null;
  }
  if (!form.fullName.trim() || !form.email.trim()) return 'Enter the candidate’s name and email.';
  if (!hasResume(form)) return 'Add a resume file or paste the resume text.';
  return null;
}

export function hasResume(form: Pick<AddCandidateForm, 'hasFile' | 'resumeText'>): boolean {
  return form.hasFile || form.resumeText.trim().length > 0;
}

export function importPayload(form: AddCandidateForm): { externalCandidateId: string; roleId: string } {
  return { externalCandidateId: form.externalCandidateId.trim(), roleId: form.roleId };
}

/**
 * A repeat import returns the person already here rather than a duplicate; say
 * so, because silently opening an existing record looks like a new one. A
 * resume given alongside is not sent: it would quietly replace the profile the
 * existing record may already have, so the person is told it was not sent.
 */
export function importNotice(result: ImportResult, opts: { withResume?: boolean } = {}): string | null {
  if (!result.alreadyImported) return null;
  const base = `${result.candidate.fullName} was already imported from your ATS, so nothing new was created.`;
  return opts.withResume
    ? `${base} The resume you added was not uploaded, so the record already here stays as it is; open it to see whether it still needs one.`
    : base;
}

export function resumeUploadMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 422) {
    return `We could not read that resume file. Please upload a text-based PDF/DOCX or paste the resume text instead. (${err.message})`;
  }
  if (err instanceof Error) return err.message;
  return 'The resume could not be uploaded. Please try again.';
}
