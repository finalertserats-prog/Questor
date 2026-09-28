import { useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { hasResume, resumeUploadMessage } from './candidateImportModel';

export interface ResumeValue {
  readonly file: File | null;
  readonly text: string;
}

export const EMPTY_RESUME: ResumeValue = { file: null, text: '' };

/** Send a chosen file, or else the pasted text, as the candidate's resume. */
export function uploadResume(candidateId: string, resume: ResumeValue): Promise<unknown> {
  const form = new FormData();
  if (resume.file) form.append('file', resume.file);
  else form.append('text', resume.text);
  return api.postForm(`/candidates/${candidateId}/resume`, form);
}

/** A resume file picker plus a paste box; a chosen file wins over the text. */
export function ResumeFields({ value, onChange, optionalNote }: {
  value: ResumeValue;
  onChange: (next: ResumeValue) => void;
  optionalNote?: string;
}) {
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  // The input keeps its own value, so clearing state alone would leave the
  // filename on screen with nothing behind it.
  const removeFile = () => {
    onChange({ ...value, file: null });
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <>
      <label htmlFor={`${fieldId}-file`}>Resume file (PDF, DOCX, or TXT){optionalNote ? ` — ${optionalNote}` : ''}</label>
      <input
        id={`${fieldId}-file`}
        ref={fileInput}
        type="file"
        accept=".pdf,.docx,.txt"
        onChange={(e) => onChange({ ...value, file: e.target.files?.[0] ?? null })}
      />
      <div className="row muted small" style={{ marginTop: 6, gap: 8 }}>
        <span>If a file is selected it takes precedence over the pasted text below.</span>
        {/* Choosing a file disabled the text box, and a file picker offers no
            way to choose nothing — so the only way back to pasting was to
            reload the page and retype everything. */}
        {value.file && (
          <button type="button" className="btn ghost sm" onClick={removeFile}>
            <Icon name="close" size={14} />Remove {value.file.name}
          </button>
        )}
      </div>

      <label htmlFor={`${fieldId}-text`}>Or paste resume text</label>
      <textarea
        id={`${fieldId}-text`}
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="Paste the candidate's resume text here…"
        disabled={!!value.file}
      />
    </>
  );
}

/**
 * Add a resume to a candidate who has none yet — someone imported from the
 * ATS arrives with contact details only, and the empty profile used to say
 * "upload or paste a resume" with nowhere to do it.
 */
export function ResumeUploadCard({ candidateId, onUploaded }: { candidateId: string; onUploaded: () => void }) {
  const [resume, setResume] = useState<ResumeValue>(EMPTY_RESUME);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUploading(true);
    try {
      await uploadResume(candidateId, resume);
      setResume(EMPTY_RESUME);
      onUploaded();
    } catch (err: unknown) {
      setError(resumeUploadMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const ready = hasResume({ hasFile: !!resume.file, resumeText: resume.text });
  return (
    <form className="card" onSubmit={submit} aria-label="Add a resume">
      <h2 className="card-title"><Icon name="job" />Add a resume</h2>
      {error && <Banner kind="error">{error}</Banner>}
      <ResumeFields value={resume} onChange={setResume} />
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="submit" disabled={uploading || !ready}>
          <Icon name={uploading ? 'hourglass' : 'sparkle'} size={16} />
          {uploading ? 'Uploading & analysing…' : 'Upload & analyse resume'}
        </button>
      </div>
    </form>
  );
}
