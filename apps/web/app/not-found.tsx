import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false }
};

export default function NotFoundPage() {
  return (
    <section className="panel">
      <div className="empty-state">
        <span className="empty-mark" aria-hidden="true">·</span>
        <div>
          <h1 className="error-title">Page not found</h1>
          <p>The requested page does not exist or is no longer available.</p>
        </div>
        <div className="empty-action"><Link className="button" href="/">Return to live streams</Link></div>
      </div>
    </section>
  );
}
