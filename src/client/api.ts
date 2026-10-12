export interface Session {
  userId: string;
  name: string;
  token: () => Promise<string>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(
  /\/$/,
  "",
);
export async function api<T = any>(
  path: string,
  session?: Session,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (session) headers.set("Authorization", `Bearer ${await session.token()}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.code ?? "request_failed",
      data.error ?? data.message ?? "Request failed.",
      data.retryable ?? false,
    );
  return data;
}
export const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});
