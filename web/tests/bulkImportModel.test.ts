import { describe, expect, it } from 'vitest';
import {
  CONFIRM_CHUNK,
  CV_CHUNK,
  MAX_IMPORT_PEOPLE,
  chunk,
  confirmableKeys,
  csvTemplate,
  isCvFile,
  isEditable,
  previewSummary,
  resultSummary,
  retryableKeys,
  screenCvFiles,
  statusView,
  type ImportRow,
  type ConfirmedRow,
} from '../src/components/bulkImportModel';

const row = (over: Partial<ImportRow> = {}): ImportRow => ({
  rowKey: 'r1', position: 1, fullName: 'Priya Sharma', email: 'priya@example.com', phone: '', linkedinUrl: '', filename: '',
  hasCv: false, included: true, status: 'ready', message: 'Ready to add.', outcome: 'pending', candidateId: null, error: '', ...over,
});

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('chunk', () => {
  it('splits a list into pieces of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('gives nothing for an empty list', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('sends CVs five at a time and confirms 25 at a time, as the server allows', () => {
    expect([CV_CHUNK, CONFIRM_CHUNK, MAX_IMPORT_PEOPLE]).toEqual([5, 25, 200]);
  });
});

describe('screenCvFiles', () => {
  it('keeps PDF, DOCX and text files', () => {
    const { accepted } = screenCvFiles([file('a.pdf', 'application/pdf'), file('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), file('c.txt', 'text/plain')]);

    expect(accepted).toHaveLength(3);
  });

  it('sets aside another type with the reason', () => {
    expect(screenCvFiles([file('photo.png', 'image/png')]).skipped).toEqual([{ name: 'photo.png', reason: 'not a PDF, DOCX or text file' }]);
  });

  it('sets aside a file over 5 MB', () => {
    expect(screenCvFiles([file('big.pdf', 'application/pdf', 6 * 1024 * 1024)]).skipped[0].reason).toMatch(/5 MB/);
  });

  it('sets aside everything past 200 files', () => {
    const many = Array.from({ length: 205 }, (_, i) => file(`cv${i}.pdf`, 'application/pdf'));

    expect(screenCvFiles(many).skipped).toHaveLength(5);
  });

  it('recognises a CV by its extension when the browser gives no type', () => {
    expect(isCvFile(file('cv.docx', ''))).toBe(true);
  });
});

describe('statusView', () => {
  it('words every status for the preview', () => {
    expect(statusView('duplicate_in_batch').label).toBe('repeat');
  });

  it('marks rows needing a fix as such', () => {
    expect(statusView('missing_email').tone).toBe('fix');
  });
});

describe('confirmableKeys', () => {
  it('takes ticked rows that are ready, known or already on the role', () => {
    const rows = [row(), row({ rowKey: 'r2', status: 'known' }), row({ rowKey: 'r3', status: 'existing' })];

    expect(confirmableKeys(rows)).toEqual(['r1', 'r2', 'r3']);
  });

  it('leaves out an unticked row', () => {
    expect(confirmableKeys([row({ included: false })])).toEqual([]);
  });

  it('leaves out a row that needs a fix', () => {
    expect(confirmableKeys([row({ status: 'invalid_email' })])).toEqual([]);
  });

  it('leaves out a row already added', () => {
    expect(confirmableKeys([row({ outcome: 'created' })])).toEqual([]);
  });
});

describe('isEditable', () => {
  it('lets a pending row be edited', () => {
    expect(isEditable(row())).toBe(true);
  });

  it('locks a row that has been added', () => {
    expect(isEditable(row({ outcome: 'linked' }))).toBe(false);
  });

  it('locks a row whose CV could not be read', () => {
    expect(isEditable(row({ status: 'unreadable' }))).toBe(false);
  });
});

describe('previewSummary', () => {
  it('counts what confirm would do and what needs a fix', () => {
    const rows = [row(), row({ rowKey: 'r2', status: 'existing' }), row({ rowKey: 'r3', status: 'missing_email' }), row({ rowKey: 'r4', included: false })];

    expect(previewSummary(rows)).toBe('1 ready to add · 1 already a candidate · 1 needs a fix · 1 left out');
  });

  it('says so when there is nothing to add', () => {
    expect(previewSummary([row({ status: 'missing_email' })])).toBe('0 ready to add · 1 needs a fix');
  });
});

describe('resultSummary', () => {
  const result = (outcome: string): ConfirmedRow => ({ rowKey: 'r', outcome, candidateId: 'c', error: '', interview: null });

  it('counts added, linked and failed', () => {
    expect(resultSummary([result('created'), result('created'), result('linked'), result('failed')])).toBe('2 added · 1 already a candidate · 1 failed');
  });

  it('names the failed rows to retry', () => {
    expect(retryableKeys([{ ...result('failed'), rowKey: 'r9' }, result('created')])).toEqual(['r9']);
  });
});

describe('csvTemplate', () => {
  it('has the columns the import reads', () => {
    expect(csvTemplate().split('\n')[0]).toBe('name,email,phone,linkedin');
  });
});
