const defaultTimeoutMs = 15_000;

export const fetchWithTimeout = (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = defaultTimeoutMs
): Promise<Response> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal == null
    ? timeoutSignal
    : AbortSignal.any([init.signal, timeoutSignal]);

  return fetch(input, { ...init, signal });
};
