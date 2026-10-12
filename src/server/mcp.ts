import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { documents } from "./documents";
import { authenticate } from "./identity";
import { AppError } from "./errors";
import { z } from "zod";
import {
  readInput,
  editInput,
  writeInput,
  listInput,
  createInput,
} from "../shared/contracts";
import { resource, apiBase, appOrigin } from "./oauth";
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
          "WWW-Authenticate": `Bearer resource_metadata="${apiBase}/.well-known/oauth-protected-resource", scope="document:read document:edit document:write document:create"`,
        },
      },
    );
  }
  const server = new McpServer(
    { name: "carriage", version: "0.1.0" },
    {
      instructions:
        "Use list_documents to find accessible documents by title; follow next_cursor using after for further pages. Account connections can create_document. Read the document outline, then selected blocks. Use replace_text for small changes and retain the supplied refs and hashes. Reuse request_id and identical input after transport failures, including creates. Full writes require an unchanged revision. Tools return committed database revisions. Current document permissions always apply.",
    },
  );
  const invoke = async (
    method: "read" | "edit" | "write" | "discover" | "createAgent",
    input: any,
  ) => {
    try {
      const result = await documents[method](identity, input);
      if (method === "createAgent") {
        const created = result as { id: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                document_id: created.id,
                title: (result as any).title,
                revision: 0,
                url: `${appOrigin}/?doc=${created.id}`,
              }),
            },
          ],
        };
      }
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
    "list_documents",
    {
      title: "Find documents",
      description:
        "List documents accessible to the connected account, optionally filter by title. Returns IDs, roles and revisions without document bodies. Pass next_cursor as after for the next page. A legacy document connection lists only its approved document.",
      inputSchema: listInput.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => invoke("discover", input),
  );
  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description:
        "Create a document owned by the connected account, with an optional initial Markdown body. Requires an account connection with create permission. Use a UUID request_id and reuse it with identical input on retries. Returns its ID and editor URL.",
      inputSchema: createInput.shape,
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    (input) => invoke("createAgent", input),
  );
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
