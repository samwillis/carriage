import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { documents } from "./documents";
import { authenticate } from "./identity";
import { AppError } from "./errors";
import { z } from "zod";
import { readInput, editInput, writeInput } from "../shared/contracts";
import { pool } from "./db";
import { resource, apiBase } from "./oauth";
export async function handleMcp(request: Request) {
  let identity;
  try {
    identity = await authenticate(request, true);
  } catch (error) {
    return Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${apiBase}/.well-known/oauth-protected-resource", scope="document:read document:edit document:write"`,
        },
      },
    );
  }
  const server = new McpServer(
    { name: "margin", version: "0.1.0" },
    {
      instructions:
        "Read the document outline, then selected blocks. Use replace_text for small changes and retain the supplied refs and hashes. Reuse request_id after transport failures. Full writes require an unchanged revision. Tools return committed database revisions.",
    },
  );
  const invoke = async (method: "read" | "edit" | "write", input: any) => {
    try {
      const result = await documents[method](identity, input);
      if (identity.kind === "agent")
        await pool.query(
          `INSERT INTO document_presence(document_id,session_id,user_id,label,kind,activity,expires_at)
        VALUES($1,$2,$3,$4,'agent',$5,clock_timestamp()+interval '45 seconds') ON CONFLICT(document_id,session_id) DO UPDATE SET activity=excluded.activity,expires_at=excluded.expires_at`,
          [
            input.document_id,
            identity.principal,
            identity.userId,
            identity.name,
            method === "read" ? "Reading" : "Editing",
          ],
        );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      const details =
        error instanceof AppError
          ? {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            }
          : error instanceof z.ZodError
            ? {
                code: "invalid_request",
                message: "Invalid tool input.",
                retryable: false,
              }
            : {
                code: "internal_error",
                message: "Request failed. Retry with the same request ID.",
                retryable: true,
              };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
      };
    }
  };
  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read current committed Markdown, outline, or selected blocks. References and hashes support narrow safe edits.",
      inputSchema: readInput.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => invoke("read", input),
  );
  server.registerTool(
    "edit_document",
    {
      title: "Edit document",
      description:
        "Atomically apply targeted text/block edits. Use refs and expected content from read_document. Reuse the same request_id on retries.",
      inputSchema: editInput.shape,
      annotations: { idempotentHint: true, destructiveHint: true },
    },
    (input) => invoke("edit", input),
  );
  server.registerTool(
    "write_document",
    {
      title: "Write document",
      description:
        "Replace the whole document only if expected_revision still matches. Prefer edit_document for concurrent collaboration.",
      inputSchema: writeInput.shape,
      annotations: { idempotentHint: true, destructiveHint: true },
    },
    (input) => invoke("write", input),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
