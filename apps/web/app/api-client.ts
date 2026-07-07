export const getApiBaseUrl = () => {
  return process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
};

export async function getApiData<T>(path: string, init?: RequestInit): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      next: { revalidate: 15 },
      ...init
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { data: T };
  return payload.data;
}
