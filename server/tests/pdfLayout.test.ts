import { describe, expect, it } from 'vitest';
import { pdfRead, renderTextItems, type TextItem } from '../src/engines/pdfLayout.js';

/**
 * Rebuilding a PDF page's lines from where its glyphs actually sit.
 *
 * Both failures below came off real CVs uploaded to production, where
 * pdf-parse's own renderer concatenates text items in file order with no
 * separator at all.
 */

/** A text item at a position, in the shape pdf.js reports. */
function at(str: string, x: number, y: number, w = str.length * 4, h = 10): TextItem {
  return { str, transform: [1, 0, 0, 1, x, y], width: w, height: h };
}

describe('lines', () => {
  it('reads top to bottom, whatever order the file stores', () => {
    const page = [at('third', 20, 700), at('first', 20, 760), at('second', 20, 730)];
    expect(renderTextItems(page)).toBe('first\nsecond\nthird');
  });

  it('keeps a raised glyph on its own line', () => {
    expect(renderTextItems([at('M', 20, 700, 8), at('c', 28, 703, 6, 6)])).toBe('Mc');
  });

  it('reads tabs inside an item as the spaces they stand for', () => {
    // Some PDFs encode every space as a tab; "JATIN\tKUMAR" reached the parser
    // verbatim and the name never matched anything.
    expect(renderTextItems([at('JATIN\tKUMAR', 20, 700)])).toBe('JATIN KUMAR');
  });

  it('separates two cells that sit side by side', () => {
    // A career-timeline strip. Concatenated, these became "182021 - 22", which
    // was then stored as the candidate's employer.
    const strip = [at('2017 - 18', 59, 592, 24), at('2021 - 22', 145, 592, 24), at('2022 - 25', 228, 592, 24)];
    expect(renderTextItems(strip)).toBe('2017 - 18   2021 - 22   2022 - 25');
  });

  it('joins pieces of one word without inventing a space', () => {
    expect(renderTextItems([at('Market', 20, 700, 24), at('ing', 44, 700, 12)])).toBe('Marketing');
  });

  it('says nothing for a page with no text', () => {
    expect(renderTextItems([])).toBe('');
  });

  it('ignores an item with no position rather than guessing one', () => {
    const broken = { str: 'ghost', transform: [1, 0, 0, 1, NaN, NaN], width: 10, height: 10 };
    expect(renderTextItems([broken, at('real', 20, 700)])).toBe('real');
  });
});

describe('columns', () => {
  /**
   * The two-column CV: work history down the left, the skills list down the
   * right. Read straight across, every job title arrived welded to an
   * unrelated line of tooling.
   */
  const twoColumn: TextItem[] = [
    at('JATIN KUMAR', 20, 800, 200),
    at('WORK EXPERIENCE', 20, 760, 80),
    at('TECHNICAL SKILLS', 320, 760, 80),
    at('Marketing Manager', 20, 740, 80),
    at('Google Ads, Meta Ads', 320, 740, 90),
    at('Gurgaon | Aug 2025', 20, 720, 80),
    at('HubSpot, Marketo', 320, 720, 80),
    at('Owned campaigns end to end', 20, 700, 90),
    at('Looker Studio, GA4', 320, 700, 80),
    at('Built the LinkedIn presence', 20, 680, 90),
    at('Salesforce, Zoho', 320, 680, 70),
    at('Assistant Manager', 20, 660, 80),
    at('Brevo, Lemlist, MSG91', 320, 660, 90),
    at('Gurgaon | Aug 2022', 20, 640, 80),
    at('6sense, Demandbase', 320, 640, 85),
    at('Ran the ABM programme', 20, 620, 85),
    at('Excel, Google Sheets', 320, 620, 85),
    at('Analyst, NK Realestates', 20, 600, 90),
    at('SEO, Search Console', 320, 600, 85),
  ];

  it('reads the left column through before starting the right', () => {
    const lines = renderTextItems(twoColumn).split('\n');
    expect(lines.indexOf('Assistant Manager')).toBeLessThan(lines.indexOf('Google Ads, Meta Ads'));
  });

  it('never welds a job title to the skill beside it', () => {
    for (const line of renderTextItems(twoColumn).split('\n')) {
      expect(line).not.toMatch(/Marketing Manager\s+Google Ads/);
    }
  });

  it('keeps a full-width line above the columns where it was written', () => {
    expect(renderTextItems(twoColumn).split('\n')[0]).toBe('JATIN KUMAR');
  });

  it('leaves a single-column page in the order it was written', () => {
    const single = [
      at('Summary', 20, 800, 40), at('Experience', 20, 780, 50),
      at('Engineer, Acme', 20, 760, 60), at('Built the thing', 20, 740, 60),
      at('Education', 20, 720, 45), at('B.Sc. 2014', 20, 700, 45),
      at('Skills', 20, 680, 30), at('Python, SQL', 20, 660, 50),
    ];
    expect(renderTextItems(single).split('\n')).toEqual([
      'Summary', 'Experience', 'Engineer, Acme', 'Built the thing',
      'Education', 'B.Sc. 2014', 'Skills', 'Python, SQL',
    ]);
  });

  it('does not split a page on an indent', () => {
    // A hanging indent puts text either side of a gap that no other line
    // respects. Splitting there would reorder a sentence.
    const indented = [
      at('Experience', 20, 800, 50),
      at('Engineer, Acme', 20, 780, 60), at('2018 - 2021', 320, 780, 40),
      at('Built the ingest pipeline end to end', 40, 760, 150),
      at('Analyst, Beta', 20, 740, 55), at('2016 - 2018', 320, 740, 40),
      at('Reported on weekly spend', 40, 720, 110),
    ];
    const lines = renderTextItems(indented).split('\n');
    expect(lines[1]).toBe('Engineer, Acme   2018 - 2021');
  });
});

describe('a right-aligned date column is not a second column', () => {
  /**
   * The commonest CV layout there is: the job on the left, its dates at the
   * right margin, on every role line. Every test a gutter has to pass — a
   * clean vertical band, text on both sides, line after line — this layout
   * passes perfectly, and splitting on it lifts every date away from the job
   * it belongs to and stacks them together at the end of the section.
   *
   * What tells them apart is how much text each side carries. A date column
   * carries a tenth of what the column beside it does; a real second column
   * carries a third or more.
   */
  const datedRoles: TextItem[] = [
    at('WORK EXPERIENCE', 20, 800, 80),
    at('Senior Marketing Manager, Genesys International', 20, 780, 190), at('2024 - Present', 470, 780, 55),
    at('Led B2B campaigns across email, social and events', 30, 760, 200),
    at('Senior Digital Marketing Specialist, Gartner', 20, 740, 180), at('2021 - 2024', 470, 740, 50),
    at('Managed outbound campaigns via Eloqua', 30, 720, 160),
    at('Senior Marketing Executive, Galaxy Office', 20, 700, 175), at('2020 - 2021', 470, 700, 50),
    at('Planned B2B campaigns for enterprise brands', 30, 680, 180),
    at('Marketing Executive, Softcell Technologies', 20, 660, 175), at('2018 - 2020', 470, 660, 50),
    at('Led business development across West India', 30, 640, 175),
    at('Marketing Associate, Redington India', 20, 620, 160), at('2016 - 2018', 470, 620, 50),
    at('Served as SPOC for Oracle BU marketing', 30, 600, 165),
  ];

  it('keeps each date on the line of the job it belongs to', () => {
    const lines = renderTextItems(datedRoles).split('\n');
    expect(lines[1]).toContain('Genesys International');
    expect(lines[1]).toContain('2024 - Present');
  });

  it('does not stack the dates together at the end', () => {
    const lines = renderTextItems(datedRoles);
    expect(lines).not.toMatch(/2024 - Present\n2021 - 2024/);
  });

  it('still reads the roles in the order they were written', () => {
    const lines = renderTextItems(datedRoles).split('\n');
    expect(lines.findIndex((l) => l.includes('Gartner')))
      .toBeLessThan(lines.findIndex((l) => l.includes('Redington')));
  });
});

describe('a page that cannot be read', () => {
  /**
   * pdf-parse wraps the page renderer in a catch of its own and carries on, so
   * a page that fails to read contributes nothing and the parse still reports
   * success. A three-page job advert whose second page fails comes back as a
   * perfectly plausible advert with its requirements missing — and everything
   * built on it is confidently wrong, properly cited from the half that
   * survived. Nothing looks wrong, which is what makes it worse than a scan
   * that produces nothing at all.
   */
  const workingPage = {
    getTextContent: () => Promise.resolve({
      items: [{ str: 'Senior Data Engineer', transform: [1, 0, 0, 1, 20, 700], width: 90, height: 10 }],
    }),
  };
  const brokenPage = {
    getTextContent: () => Promise.reject(new Error('stream decode failed')),
  };

  it('is counted, so the caller can refuse the document', async () => {
    const read = pdfRead();
    await read.render(workingPage);
    await read.render(brokenPage);
    expect(read.failedPages()).toBe(1);
  });

  it('counts nothing when every page reads', async () => {
    const read = pdfRead();
    await read.render(workingPage);
    await read.render(workingPage);
    expect(read.failedPages()).toBe(0);
  });

  it('still returns a string, so pdf-parse is not derailed mid-document', async () => {
    expect(await pdfRead().render(brokenPage)).toBe('');
  });

  it('counts per document, because two uploads can be in flight at once', async () => {
    const mine = pdfRead();
    const theirs = pdfRead();
    await mine.render(brokenPage);
    await theirs.render(workingPage);
    expect([mine.failedPages(), theirs.failedPages()]).toEqual([1, 0]);
  });

  it('keeps a page it cannot lay out, rather than losing it', async () => {
    // Laying out is not reading. An item with no usable position is dropped by
    // the layout pass, and the plain reading is what saves the page.
    const oddPage = {
      getTextContent: () => Promise.resolve({
        items: [{ str: 'Requirements', transform: [1, 0, 0, 1, NaN, NaN], width: 50, height: 10 }],
      }),
    };
    const read = pdfRead();
    expect(await read.render(oddPage)).toBe('Requirements');
    expect(read.failedPages()).toBe(0);
  });
});
