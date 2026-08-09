export const dynamic = "force-static";

export function GET() {
  return new Response("ok", {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
