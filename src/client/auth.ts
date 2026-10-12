import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";
import { ApiError, type Session } from "./api";
const url = import.meta.env.VITE_NEON_AUTH_BASE_URL;
export const auth = url
  ? createAuthClient(url, { adapter: BetterAuthReactAdapter() })
  : null;
export async function currentSession(): Promise<Session | null> {
  if (!auth) return null;
  const result = await auth.getSession();
  if (!result.data) return null;
  return {
    userId: result.data.user.id,
    name: result.data.user.name,
    token: async () => {
      // This SDK injects the set-auth-jwt header into session.token and caches
      // /token as a session response. Retrieve the JWT through that supported
      // session representation rather than expecting an uncached token body.
      const result = await auth!.getSession();
      const token = result.data?.session.token;
      if (!token || token.split(".").length !== 3)
        throw new ApiError(
          401,
          "credential_expired",
          "Your login expired. Sign in again.",
        );
      return token;
    },
  };
}
