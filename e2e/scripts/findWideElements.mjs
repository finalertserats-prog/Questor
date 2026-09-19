// Lists the outermost elements that extend past the viewport's right edge, per
// page, at a given width — the culprits behind sideways page scroll.
// Usage: node e2e/scripts/findWideElements.mjs <width> <path> [<path>...]
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const [width, ...paths] = process.argv.slice(2);
const state = resolve(import.meta.dirname, '../.auth/recruiter.json');
const browser = await chromium.launch();
for (const path of paths) {
  const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, storageState: path.startsWith('/demo') ? undefined : state });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:5173${path}`, { waitUntil: 'networkidle' });
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 || r.width === 0) continue;
      // Report only the outermost offender: skip if its parent also overflows.
      const p = el.parentElement?.getBoundingClientRect();
      if (p && p.right > vw + 1) continue;
      const cs = getComputedStyle(el);
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} w=${Math.round(r.width)} right=${Math.round(r.right)} display=${cs.display} minW=${cs.minWidth}`);
    }
    return { vw, scroll: document.documentElement.scrollWidth, out: out.slice(0, 8) };
  });
  console.log(`${path} vw=${wide.vw} scrollWidth=${wide.scroll}\n  ${wide.out.join('\n  ')}`);
  await ctx.close();
}
await browser.close();
