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
export function JdFileImport({ fieldId, text, onTextChange, imported, onImported }: {
  fieldId: string;
  text: string;
  onTextChange: (next: string) => void;
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
      onImported(result);
      onTextChange(result.text);
    } catch (err: unknown) {
      onImported(null);
      setError(jdImportMessage(err));
      if (fileInput.current) fileInput.current.value = '';
    } finally {
      setReading(false);
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

      {imported && (
        <section
          className="card"
          aria-labelledby={`${fieldId}-extracted-title`}
          style={{ marginTop: 16, borderStyle: 'solid' }}
          data-testid="jd-extraction"
        >
          <h3 id={`${fieldId}-extracted-title`} style={{ marginTop: 0 }}>
            <Icon name="job-description" size={16} /> What was extracted
          </h3>
          {notes.map((note) => <Banner key={note} kind="info">{note}</Banner>)}
          <div className="field-grid">
            <div>
              <h4 className="small" style={{ marginBottom: 4 }}>The file</h4>
              <dl className="small muted" style={{ margin: 0 }}>
                <dt>Filename</dt>
                <dd style={{ margin: '0 0 6px', overflowWrap: 'anywhere' }}>{imported.filename}</dd>
                <dt>Size</dt>
                <dd style={{ margin: '0 0 6px' }}>{fileSizeLabel(imported.bytes)}</dd>
                <dt>Text extracted</dt>
                <dd style={{ margin: 0 }}>{imported.characters.toLocaleString()} characters{imported.truncated ? ' (cut short)' : ''}</dd>
              </dl>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label htmlFor={`${fieldId}-jd`}>Job description — edit anything the file got wrong</label>
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
