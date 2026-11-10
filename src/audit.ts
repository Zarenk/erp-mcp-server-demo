/**
 * One line per tool call. By design it contains NO secrets and NO arguments:
 * only who (key prefix + org), what (tool name), how long, and whether it worked.
 */
export interface AuditEntry {
  ts: string;
  event: "tool_call";
  keyPrefix: string;
  org: string;
  tool: string;
  durationMs: number;
  ok: boolean;
}

export type AuditSink = (entry: AuditEntry) => void;

/** Writes JSON lines to stderr (stdout is reserved for the MCP protocol in stdio mode). */
export const stderrAudit: AuditSink = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

export const noAudit: AuditSink = () => undefined;
