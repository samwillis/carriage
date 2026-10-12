import { readFile, writeFile } from "node:fs/promises";
// Test harness only. Credentials and the resulting short-lived JWT stay ignored.
export async function testIdentity(base) {
  const credentials = JSON.parse(
    await readFile(".cache/test-user.json", "utf8"),
  );
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  const login = await fetch(`${config.authUrl}/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(base).origin,
    },
    body: JSON.stringify(credentials),
  });
  if (!login.ok) throw new Error(`Test sign-in failed (${login.status})`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const response = await fetch(`${config.authUrl}/get-session`, {
      headers: { Cookie: cookie },
    }),
    data = await response.json(),
    token = response.headers.get("set-auth-jwt");
  if (!response.ok || !token) throw new Error("Test JWT unavailable");
  const identity = { token, userId: data.user.id };
  await writeFile(".cache/test-identity.json", JSON.stringify(identity), {
    mode: 0o600,
  });
  return identity;
}
