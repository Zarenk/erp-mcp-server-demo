import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext } from "./auth.js";
import type { AuditSink } from "./audit.js";
import type { Db } from "./db.js";
import { limaDate } from "./dates.js";
import { TOOLS, findTool, jsonSchemaFor } from "./tools.js";

export interface McpDeps {
  db: Db;
  auth: AuthContext;
  audit: AuditSink;
  now: () => number;
}

function fail(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/**
 * Builds an MCP server bound to ONE authenticated key. The tenant is captured in this closure
 * from the key record; nothing in the request (headers, arguments) can change it.
 */
export function createMcpServer(deps: McpDeps): Server {
  const server = new Server({ name: "erp-mcp-server-demo", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchemaFor(t) as { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const tool = findTool(request.params.name);
    let ok = false;
    try {
      if (!tool) return fail("Unknown tool.");
      const parsed = tool.input.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
        return fail(`Invalid arguments. ${issues.join("; ")}`);
      }
      const today = limaDate(deps.now());
      const result = tool.run({ db: deps.db, tenantId: deps.auth.tenantId, today }, parsed.data as never);
      ok = true;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch {
      return fail("Internal error while running the tool.");
    } finally {
      deps.audit({
        ts: new Date(deps.now()).toISOString(),
        event: "tool_call",
        keyPrefix: deps.auth.keyPrefix,
        org: deps.auth.tenantId,
        // Only whitelisted names are logged verbatim; client-supplied junk is not echoed into logs.
        tool: tool ? tool.name : "(unknown)",
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ok,
      });
    }
  });

  return server;
}
