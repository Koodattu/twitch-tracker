"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="panel">
      <div className="empty-state" role="alert">
        <span className="empty-mark" aria-hidden="true">·</span>
        <div>
          <h1 className="error-title">This page could not be loaded</h1>
          <p>The service may be temporarily unavailable. Try the request again.</p>
        </div>
        <div className="empty-action"><button className="button" type="button" onClick={reset}>Try again</button></div>
      </div>
    </section>
  );
}
