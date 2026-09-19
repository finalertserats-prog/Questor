import { CATALOG_ATTRIBUTIONS, type CatalogAttribution as Attribution } from './catalogAttributionModel';

function AttributionText({ item }: { readonly item: Attribution }) {
  const at = item.text.indexOf(item.linkText);
  // The O*NET licence name sits inside its sentence; ESCO's link follows it.
  if (at < 0) {
    return <>{item.text} <a href={item.url} target="_blank" rel="noopener noreferrer">{item.linkText}</a></>;
  }
  return (
    <>
      {item.text.slice(0, at)}
      <a href={item.url} target="_blank" rel="noopener noreferrer">{item.linkText}</a>
      {item.text.slice(at + item.linkText.length)}
    </>
  );
}

/** The O*NET and ESCO attributions their licences require wherever catalog data appears. */
export function CatalogAttribution({ className }: { readonly className?: string }) {
  return (
    <section className={className ?? 'catalog-attribution muted small'} aria-label="Catalog data sources">
      {CATALOG_ATTRIBUTIONS.map((item) => <p key={item.name}><AttributionText item={item} /></p>)}
    </section>
  );
}
