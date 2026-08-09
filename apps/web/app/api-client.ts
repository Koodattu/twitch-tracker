import "server-only";
import { cookies } from "next/headers";

export const getApiBaseUrl = () => {
  return process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
};

export async function getPublicApiInit(): Promise<RequestInit> {
  const cookieHeader = (await cookies()).toString();
  return cookieHeader === ""
    ? {}
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
}

export async function getAuthenticatedApiInit(): Promise<RequestInit> {
  const cookieHeader = (await cookies()).toString();
  return cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
}

export async function getApiData<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const fetchInit =
      init?.cache === "no-store"
        ? init
        : {
            next: { revalidate: 15 },
            ...init
          };
    const timeoutSignal = AbortSignal.timeout(10_000);
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...fetchInit,
      signal: fetchInit.signal == null ? timeoutSignal : AbortSignal.any([fetchInit.signal, timeoutSignal])
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { data?: T };
    return payload.data ?? null;
  } catch {
    return null;
  }
}
