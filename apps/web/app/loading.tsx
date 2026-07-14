export default function Loading() {
  return (
    <div className="loading-layout" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading analytics</span>
      <section className="loading-heading" aria-hidden="true">
        <span className="skeleton-line skeleton-eyebrow" />
        <span className="skeleton-line skeleton-title" />
        <span className="skeleton-line skeleton-copy" />
      </section>
      <section className="stat-row" aria-hidden="true">
        <span className="skeleton-card" />
        <span className="skeleton-card" />
        <span className="skeleton-card" />
      </section>
      <section className="skeleton-panel" aria-hidden="true">
        <span className="skeleton-line skeleton-panel-title" />
        <span className="skeleton-line skeleton-panel-row" />
        <span className="skeleton-line skeleton-panel-row" />
        <span className="skeleton-line skeleton-panel-row" />
      </section>
    </div>
  );
}
