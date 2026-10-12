import { documents } from "../src/server/documents";
import { pool } from "../src/server/db";
const userId = process.env.SEED_USER_ID;
if (!userId) throw new Error("Set SEED_USER_ID to a Neon Auth user ID.");
try {
  const result = await documents.create(
    {
      principal: `user:${userId}`,
      userId,
      name: "Writer",
      kind: "person",
      expiresAt: Date.now() + 60_000,
      scopes: ["read", "edit", "write"],
    },
    "Welcome to Carriage",
    "# Welcome to Carriage\n\nWrite together with people and agents.\n\n## Try it\n\n- Open this page in two browser windows\n- Invite a collaborator\n- Connect an agent with read, edit, and write tools\n",
  );
  console.log(`Created document ${result.id}.`);
} finally {
  await pool.end();
}
