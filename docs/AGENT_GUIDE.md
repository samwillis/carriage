# Use an agent with Carriage

Open a document and click **Agent** in the top-right corner. Choose your app to see its setup instructions. The panel shows the current server URL, client-specific configuration, and a copyable example prompt containing your document ID. ChatGPT and Claude connect through browser sign-in; the local-client guides create a document-scoped access token for you.

Keep the document open while the agent works. Accepted edits appear in the editor, and the agent appears in presence while it reads or edits.

## ChatGPT

1. On ChatGPT web, open **Plugins → + → Add custom MCP server**. Name it **Carriage** and paste the MCP URL from the Agent panel.
2. Choose **OAuth** authentication. If a client registration choice appears, select **dynamic registration (DCR)**. Leave the client ID and client secret blank; Carriage registers the client automatically.
3. Create the plugin and follow the sign-in flow. Sign in with the same Carriage account you use in the editor, select the document, and approve the requested permissions. Install the plugin if prompted.
4. Start a chat, type **@**, and select **Carriage**. Paste the example prompt from the Agent panel. Approve an edit when ChatGPT asks for confirmation.

Custom MCP availability depends on your account and workspace permissions. Some versions label these features Apps or Connectors. If custom MCP setup is absent or disabled, check with your workspace administrator or use another client below. Local Codex configuration does not install a plugin in ChatGPT web.

[Official ChatGPT setup instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server)

## Claude web or desktop

1. Open **Customize → Connectors → + Add → Add custom connector**. Name it **Carriage**, paste the MCP URL, and continue.
2. Choose **Sign in now**. If the OAuth client setting is shown, choose **Register automatically**.
3. Sign in to Carriage, choose the document, approve access, and finish adding the connector.
4. In a chat, open **+ → Connectors** and enable **Carriage**. Paste the example prompt and approve edits when asked.

Custom connectors depend on your plan. For a team workspace, an owner may need to add the connector before members can connect.

[Official Claude connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Cursor

1. In Carriage, open **Agent**, choose **Cursor**, name the connection, and select its permissions.
2. Click **Create connection**. Copy the generated JSON into your personal `~/.cursor/mcp.json`, merging the `carriage` entry with any existing servers.
3. Enable Carriage in Cursor’s MCP settings, open an Agent chat, and paste the example prompt.

The configuration has this shape; the Agent panel fills in the real endpoint and token:

```json
{
  "mcpServers": {
    "carriage": {
      "url": "https://YOUR-CARRIAGE-HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_DOCUMENT_TOKEN"
      }
    }
  }
}
```

[Official Cursor MCP instructions](https://cursor.com/docs/context/mcp)

## Claude Code

In **Agent**, choose **Claude Code** and create a connection. Run the generated command in your terminal. It adds a personal connection, rather than storing the token in a project file:

```sh
claude mcp add --transport http --scope user \
  carriage 'https://YOUR-CARRIAGE-HOST/mcp' \
  --header 'Authorization: Bearer YOUR_DOCUMENT_TOKEN'
```

Start a new Claude Code session. Use `/mcp` to check that Carriage is connected, then paste the example prompt. If you already have a server named `carriage`, update or remove that existing connection before adding its replacement.

Claude Code can also use sign-in instead of a token: add the HTTP server without the Authorization header, then authenticate through `/mcp`.

[Official Claude Code MCP instructions](https://code.claude.com/docs/en/mcp)

## Codex

In **Agent**, choose **Codex** and create a connection. Add the generated TOML entry to your personal `~/.codex/config.toml`, preserving any existing servers:

```toml
[mcp_servers.carriage]
url = "https://YOUR-CARRIAGE-HOST/mcp"
http_headers = { Authorization = "Bearer YOUR_DOCUMENT_TOKEN" }
```

Restart Codex to load it. In the CLI, `/mcp` shows connected servers. Paste the example prompt into a task and approve tool calls as requested.

To use OAuth instead, configure only the URL, leave out the Authorization header, and run `codex mcp login carriage`. Sign in to Carriage and select the document when prompted.

[Official Codex MCP instructions](https://developers.openai.com/codex/mcp/)

## Other MCP clients

Choose **Other MCP clients** in the Agent panel, then select the connection method your client supports. Use a remote **Streamable HTTP** server at the MCP URL shown there. For browser sign-in, the client must support OAuth authorization code with PKCE and dynamic client registration. For an access token, configure an `Authorization: Bearer YOUR_DOCUMENT_TOKEN` header instead. Use your client’s configuration format; `mcpServers` JSON is not universal.

Enable Carriage’s tools in the conversation and give the agent the document ID or the panel’s example prompt.

## What to ask the agent

The Agent panel includes a prompt tailored to the connected document and token permissions. For example:

> Use Carriage to read document DOCUMENT_ID. Start with its outline, then read the opening paragraph. Tighten that paragraph using edit_document, preserving the rest of the document. Tell me what you changed.

For read-only access:

> Use Carriage to read document DOCUMENT_ID and summarize it. Do not make edits.

To make a larger edit, specify what should change and what should stay:

> Use Carriage to read document DOCUMENT_ID. Add a short next-steps section at the end, keeping all existing content. Apply the change to the live document and tell me what you added.

These tools operate on the connected document:

| Tool             | Use                                                | Required permission |
| ---------------- | -------------------------------------------------- | ------------------- |
| `read_document`  | Read Markdown, an outline, or selected blocks.     | Read                |
| `edit_document`  | Change selected text or blocks, or insert content. | Edit                |
| `write_document` | Replace the entire Markdown document.              | Write               |

Start with an outline, then read the relevant blocks. Prefer targeted edits for collaboration. Whole-document replacement requires write permission and a current revision; ask for it explicitly when that is what you want. If a collaborator changes the same text first, the agent should reread that section before trying again.

## Access and troubleshooting

- Each connection is limited to one document and its approved permissions. Connect again to work on another document.
- Document tokens are shown once and expire after seven days. Keep token configurations private and out of Git. Create a new connection when a token expires.
- Click **Revoke** beside a connection in the Agent panel to stop its access. Removing the plugin from a client alone does not revoke the Carriage grant.
- If the agent only describes a proposed change, ask it to call Carriage’s `edit_document` tool and apply the change. Check that the client has enabled write tools and that the grant includes edit permission.
- If authorization fails, reconnect and choose the correct document. For token clients, replace an expired or revoked token in their configuration.
- If the agent asks for a document ID, copy the example prompt from the Agent panel. If you selected a different document during sign-in, use that document’s ID instead.
- This server uses Streamable HTTP at `/mcp`; use the full URL from the panel rather than the app homepage or an SSE URL.

The setup above follows the linked client documentation. The demo’s OAuth and token flows are protocol-tested with MCP clients; the hosted ChatGPT and Claude interfaces still need their own end-to-end connection checks.
