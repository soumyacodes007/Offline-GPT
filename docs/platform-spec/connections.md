# Platform spec: shared MCP connections

Admins connect a company tool once (an MCP server reachable from the platform)
and every allowed member's workspace agent can use its tools. Members never
see the tool's credential.

## Registering

- An admin registers a **connection**: a short name (`slug`, lowercase letters,
  numbers and `-`, at most 32 characters), a title, a description, the server's
  URL (`http` or `https`) and optionally one secret header (for example
  `Authorization: Bearer …`).
- The secret is stored encrypted with the deployment's `SECRETS_KEY`. Without
  that setting, connections with a secret are refused; connections without one
  still work.
- Admin listings show the header name and whether a secret is set, never its
  value. Registering the same slug again replaces it (an omitted secret keeps
  the stored one).
- Uses the policy kind `mcp-connection` (baseline **closed**): nobody can use a
  connection until an allow rule names them.
- Registering, replacing and deleting are audited.

## For the agent

- The platform MCP endpoint lists, after its own tools, the tools of every
  connection the member may use, each named `<slug>__<tool>` and described as
  coming from that connection's title.
- Calling such a tool forwards the call to the connection's server with its
  secret header, and returns the server's result unchanged.
- A connection the member may not use is neither listed nor callable; calling
  it returns an error result, not a protocol error.
- If a connection's server is unreachable or fails, listing skips it and
  calling it returns an error result naming the connection. One broken tool
  must not hide the others.
- Every call through a connection is audited with the member, the connection
  and the tool name (not the arguments).
