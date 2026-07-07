import { getApiData } from "../../api-client";

type ChatterSummary = {
  login: string;
  publicSummary: boolean;
  detailAvailable: boolean;
};

export default async function ChatterPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const summary = await getApiData<ChatterSummary>(`/api/chatters/${login}`);

  return (
    <>
      <section className="page-title">
        <h1>{login}</h1>
        <p>{summary?.detailAvailable ? "Private MVP profile is available in this deployment mode." : "Public chatter summary."}</p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Chatter Summary</h2>
          <span className="badge">{summary?.detailAvailable ? "private detail enabled" : "limited public view"}</span>
        </div>
        <table className="table">
          <tbody>
            <tr>
              <th>Login</th>
              <td>{summary?.login ?? login}</td>
            </tr>
            <tr>
              <th>Raw timeline</th>
              <td>{summary?.detailAvailable ? "Available through private endpoints" : "Requires own-data login"}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
