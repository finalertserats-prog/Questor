import { describe, expect, it } from 'vitest';
import { CATALOG_ATTRIBUTIONS } from '../src/components/catalogAttributionModel';
// The server's copy is the one the public endpoint serves; importing it rather
// than repeating it means a change on either side fails here.
import { CATALOG_ATTRIBUTIONS as SERVER_ATTRIBUTIONS } from '../../server/src/domain/catalogAttribution';

describe('catalog source attributions', () => {
  it('match the server word for word', () => {
    expect(CATALOG_ATTRIBUTIONS.map(({ name, text, url }) => ({ name, text, url }))).toEqual(SERVER_ATTRIBUTIONS.map(({ name, text, url }) => ({ name, text, url })));
  });

  it('name the licence inside the O*NET text they link from', () => {
    expect(CATALOG_ATTRIBUTIONS[0].text).toContain(CATALOG_ATTRIBUTIONS[0].linkText);
  });
});
