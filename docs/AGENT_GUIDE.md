# Use an agent with Carriage

The editor is at [carriage-neon.vercel.app](https://carriage-neon.vercel.app/). The MCP server and OAuth provider run on Neon Functions; use the MCP URL shown in Agent connections. Existing MCP configurations continue to work after the frontend move.

Open **Agent connections** in the sidebar to connect an agent to your Carriage account. Choose your app to see its setup instructions. ChatGPT and Claude connect through browser sign-in; the local-client guides create an account access token. The agent can find documents you own or that are shared with you, edit where your role allows it, and create documents if you approve that permission.

For a specific document, open **Share → Work with an agent**. Copy its document ID or the ready-made prompt. The **Set up MCP connection** button opens the connection guide if you haven’t connected your app yet. A document ID identifies the document; it does not grant access.

Keep the document open while the agent works. Accepted edits appear in the editor. The presence popover names people and agents, shows typing or recent agent activity, and lets you jump to a current selection. Reading selected blocks and targeted agent edits highlight the relevant text; activity expires when no further tools are called. Agents do not pretend to stay connected between tool calls.

## ChatGPT

1. On ChatGPT web, open **Plugins → + → Add custom MCP server**. Name it **Carriage** and paste the MCP URL from the Agent connections panel.
2. Choose **OAuth** authentication. If a client registration choice appears, select **dynamic registration (DCR)**. Leave the client ID and client secret blank; Carriage registers the client automatically.
3. Create the plugin and follow the sign-in flow. Sign in with the same Carriage account you use in the editor, approve access to your account’s documents with the requested permissions. Install the plugin if prompted.
4. Start a chat, type **@**, and select **Carriage**. Paste the example prompt from the Agent connections panel. Approve an edit when ChatGPT asks for confirmation.

Custom MCP availability depends on your account and workspace permissions. Some versions label these features Apps or Connectors. If custom MCP setup is absent or disabled, check with your workspace administrator or use another client below. Local Codex configuration does not install a plugin in ChatGPT web.

[Official ChatGPT setup instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server)

## Claude web or desktop

1. Open **Customize → Connectors → + Add → Add custom connector**. Name it **Carriage**, paste the MCP URL, and continue.
2. Choose **Sign in now**. If the OAuth client setting is shown, choose **Register automatically**.
3. Sign in to Carriage, approve access to your account’s documents, and finish adding the connector.
4. In a chat, open **+ → Connectors** and enable **Carriage**. Paste the example prompt and approve edits when asked.

Custom connectors depend on your plan. For a team workspace, an owner may need to add the connector before members can connect.

[Official Claude connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Cursor

1. In Carriage, open **Agent connections**, choose **Cursor**, name the connection, and select its permissions.
2. Click **Create connection**. Copy the generated JSON into your personal `~/.cursor/mcp.json`, merging the `carriage` entry with any existing servers.
3. Enable Carriage in Cursor’s MCP settings, open an Agent chat, and paste the example prompt.

The configuration has this shape; the Agent connections panel fills in the real endpoint and token:

```json
{
  "mcpServers": {
    "carriage": {
      "url": "https://YOUR-CARRIAGE-HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ACCOUNT_TOKEN"
      }
    }
  }
}
```

[Official Cursor MCP instructions](https://cursor.com/docs/context/mcp)

## Claude Code

In **Agent connections**, choose **Claude Code** and create a connection. Run the generated command in your terminal. It adds a personal connection, rather than storing the token in a project file:

```sh
claude mcp add --transport http --scope user \
  carriage 'https://YOUR-CARRIAGE-HOST/mcp' \
  --header 'Authorization: Bearer YOUR_ACCOUNT_TOKEN'
```

Start a new Claude Code session. Use `/mcp` to check that Carriage is connected, then paste the example prompt. If you already have a server named `carriage`, update or remove that existing connection before adding its replacement.

Claude Code can also use sign-in instead of a token: add the HTTP server without the Authorization header, then authenticate through `/mcp`.

[Official Claude Code MCP instructions](https://code.claude.com/docs/en/mcp)

## Codex

In **Agent connections**, choose **Codex** and create a connection. Add the generated TOML entry to your personal `~/.codex/config.toml`, preserving any existing servers:

```toml
[mcp_servers.carriage]
url = "https://YOUR-CARRIAGE-HOST/mcp"
http_headers = { Authorization = "Bearer YOUR_ACCOUNT_TOKEN" }
```

Restart Codex to load it. In the CLI, `/mcp` shows connected servers. Paste the example prompt into a task and approve tool calls as requested.

To use OAuth instead, configure only the URL, leave out the Authorization header, and run `codex mcp login carriage`. Sign in to Carriage and approve access to your documents.

[Official Codex MCP instructions](https://developers.openai.com/codex/mcp/)

## Other MCP clients

Choose **Other MCP clients** in the Agent connections panel, then select the connection method your client supports. Use a remote **Streamable HTTP** server at the MCP URL shown there. For browser sign-in, the client must support OAuth authorization code with PKCE and dynamic client registration. For an access token, configure an `Authorization: Bearer YOUR_ACCOUNT_TOKEN` header instead. Use your client’s configuration format; `mcpServers` JSON is not universal.

Enable Carriage’s tools in the conversation. Ask it to find a document by title, or give it the document ID or prompt from Share.

## What to ask the agent

The Share panel includes a prompt for the current document and your document role. For example:

> Use Carriage to read document DOCUMENT_ID. Start with its outline, then read the opening paragraph. Tighten that paragraph using edit_document, preserving the rest of the document. Tell me what you changed.

For read-only access:

> Use Carriage to read document DOCUMENT_ID and summarize it. Do not make edits.

To make a larger edit, specify what should change and what should stay:

> Use Carriage to read document DOCUMENT_ID. Add a short next-steps section at the end, keeping all existing content. Apply the change to the live document and tell me what you added.

The connection exposes these tools:

| Tool              | Use                                                                 | Required permission |
| ----------------- | ------------------------------------------------------------------- | ------------------- |
| `list_documents`  | Find accessible documents by title; paginate with `after`.          | Read                |
| `create_document` | Create a document owned by your account and return its editor link. | Create              |
| `read_document`   | Read Markdown, an outline, or selected blocks.                      | Read                |
| `edit_document`   | Change selected text or blocks, or insert content.                  | Edit                |
| `write_document`  | Replace the entire Markdown document.                               | Write               |

For example:

> Use Carriage to list my documents and find “Launch notes”. Read its outline, then tighten the introduction with edit_document. Leave the other sections as they are.

> Create a Carriage document called “Launch checklist” with a short checklist. Give me its editor link.

`list_documents` returns titles, IDs, roles, revisions and a `next_cursor`, without document bodies. Pass the cursor as `after` to fetch another page. Creation, targeted edits and full writes require a UUID `request_id`; reuse the same ID and identical input after a transport failure. Concurrent creation retries return the same document instead of making duplicates.

Start with an outline, then read the relevant blocks. Prefer targeted edits for collaboration. Whole-document replacement requires write permission and a current revision; ask for it explicitly when that is what you want. If a collaborator changes the same text first, the agent should reread that section before trying again.

## Access and troubleshooting

- New connections cover your account’s current and future documents, within the approved permissions. Shared viewer documents remain read-only. Removing your document membership removes the agent’s access too.
- Existing document-scoped connections remain restricted to their original document. Revoke and reconnect to approve account-level access; their permissions are never expanded automatically.
- Account tokens are shown once and expire after seven days. Keep token configurations private and out of Git. Create a new connection when a token expires.
- Click **Revoke** beside a connection in the Agent connections panel to stop its access. Removing the plugin from a client alone does not revoke the Carriage grant.
- If the agent only describes a proposed change, ask it to call Carriage’s `edit_document` tool and apply the change. Check that the client has enabled write tools and that the grant includes edit permission.
- If authorization fails, check your current document access and the connection’s permissions. For token clients, replace an expired or revoked token in their configuration.
- If the agent asks for a document ID, open that document’s Share panel and copy the ID or example prompt. It can also find documents with `list_documents`.
- This server uses Streamable HTTP at `/mcp`; use the full URL from the panel rather than the app homepage or an SSE URL.

The setup above follows the linked client documentation. The demo’s OAuth and token flows are protocol-tested with MCP clients; the hosted ChatGPT and Claude interfaces still need their own end-to-end connection checks.
