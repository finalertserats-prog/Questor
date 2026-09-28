import { useRef, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { JD_FILE_ACCEPT, extractionNotes, fileSizeLabel, jdImportMessage, type JdImport } from './roleImportModel';

/**
 * Upload a job description as a file and check what came out of it.
 *
 * The server extracts text and returns it; it creates nothing. So the whole
 * point of this panel is the side-by-side: what the file WAS on the left, and
 * what the parser made of it on the right, editable, before it becomes the
 * job description someone will be interviewed against. A PDF with two columns
 * or a table of responsibilities comes out scrambled often enough that
 * handing the extraction straight to the model unseen would be the bug.
 */
export function JdFileImport({ fieldId, text, onTextChange, replaceText, imported, onImported }: {
  fieldId: string;
  text: string;
  /** An edit in the box. Always applies — the person is typing into it. */
  onTextChange: (next: string) => void;
  /**
   * The extraction replacing whatever was there. Separate from an edit
   * because it may refuse: someone who has already pasted a job description
   * is asked before a file overwrites it.
   */
  replaceText: (next: string) => boolean;
  imported: JdImport | null;
  onImported: (next: JdImport | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  const read = async (file: File) => {
    setError('');
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api.postForm<JdImport>('/roles/import-file', form);
      // Declined, so the file never happened: showing its name and character
      // count beside text that did not come from it would be a lie.
      if (replaceText(result.text)) onImported(result);
    } catch (err: unknown) {
      onImported(null);
      setError(jdImportMessage(err));
    } finally {
      setReading(false);
      // Always, not only on failure. The input fires `change` on the value
      // changing, so after a successful read the same file could not be
      // picked again — and re-reading the file you just mangled by hand is
      // exactly the escape someone reaches for.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  // The input keeps its own value, so clearing state alone would leave the
  // filename on screen with nothing behind it — and a file picker offers no
  // way to choose nothing. The extracted text is deliberately left alone:
  // by the time anyone presses this they may have spent ten minutes fixing
  // what the parser got wrong, and a "remove" button is no place to destroy
  // that.
  const removeFile = () => {
    onImported(null);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const notes = imported ? extractionNotes(imported) : [];

  return (
    <>
      <label htmlFor={`${fieldId}-jd-file`}>Job description file (PDF, DOCX, TXT or Markdown)</label>
      <input
        id={`${fieldId}-jd-file`}
        ref={fileInput}
        type="file"
        accept={JD_FILE_ACCEPT}
        disabled={reading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void read(file);
        }}
      />
      <div className="row muted small" style={{ marginTop: 6, gap: 8 }}>
        <span>
          {reading
            ? 'Reading the file…'
            : 'Questor reads the text out of the file. Check it below before creating the role — nothing is created until you do.'}
        </span>
        {imported && !reading && (
          <button type="button" className="btn ghost sm" onClick={removeFile}>
            <Icon name="close" size={14} />Remove {imported.filename}
          </button>
        )}
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {/* Rendered for text without a file as well as with one. The editable
          box is the only place this text exists, so hiding it when the file is
          removed would leave a job description that still submits and that
          nobody can see or correct. */}
      {(imported || text.trim()) && (
        <section
          className="card"
          aria-labelledby={`${fieldId}-extracted-title`}
          style={{ marginTop: 16, borderStyle: 'solid' }}
          data-testid="jd-extraction"
        >
          <h3 id={`${fieldId}-extracted-title`} style={{ marginTop: 0 }}>
            <Icon name="job-description" size={16} /> {imported ? 'What was extracted' : 'Job description'}
          </h3>
          {notes.map((note) => <Banner key={note} kind="info">{note}</Banner>)}
          <div className="field-grid">
            <div>
              <h4 className="small" style={{ marginBottom: 4 }}>The file</h4>
              {imported ? (
                <dl className="small muted" style={{ margin: 0 }} data-testid="jd-file-facts">
                  <dt>Filename</dt>
                  <dd style={{ margin: '0 0 6px', overflowWrap: 'anywhere' }}>{imported.filename}</dd>
                  <dt>Size</dt>
                  <dd style={{ margin: '0 0 6px' }}>{fileSizeLabel(imported.bytes)}</dd>
                  <dt>Text extracted</dt>
                  <dd style={{ margin: 0 }}>{imported.characters.toLocaleString()} characters{imported.truncated ? ' (cut short)' : ''}</dd>
                </dl>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  No file is attached. This text is yours to edit, and is what the role will be created from.
                </p>
              )}
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label htmlFor={`${fieldId}-jd`}>
                {imported ? 'Job description — edit anything the file got wrong' : 'Job description'}
              </label>
              <textarea
                id={`${fieldId}-jd`}
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                style={{ minHeight: 260 }}
                required
              />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
