import { createSocket } from "node:dgram";
import { hostname } from "node:os";
import { connect, type Socket } from "node:net";

/**
 * Forwards audit events to the organization's SIEM as RFC 5424 syslog lines
 * (facility "security/authorization", severity "notice"). Sending is
 * best-effort: a down collector never blocks or fails the audited action.
 */
export type SyslogTarget = { protocol: "udp" | "tcp"; host: string; port: number };
export type AuditLine = { id: number; at: Date; actor: string; action: string; details: Record<string, unknown> };
export type SyslogSender = { send(event: AuditLine): void; close(): void };

const PRIORITY = 4 * 8 + 5;
const HOST = hostname().replace(/[^\x21-\x7e]/g, "-") || "-";

export function parseSyslogTarget(value: string): SyslogTarget {
  const url = new URL(value);
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "udp" && protocol !== "tcp") throw new Error("AUDIT_SYSLOG must start with udp:// or tcp://");
  return { protocol, host: url.hostname, port: url.port ? Number(url.port) : 514 };
}

export function formatSyslog(event: AuditLine): string {
  const message = JSON.stringify({ id: event.id, actor: event.actor, action: event.action, details: event.details });
  return `<${PRIORITY}>1 ${event.at.toISOString()} ${HOST} offlinegpt-control - ${event.action.slice(0, 32).replace(/[^\x21-\x7e]/g, "-")} - ${message}`;
}

export function createSyslogSender(target: SyslogTarget, onError: (error: Error) => void): SyslogSender {
  if (target.protocol === "udp") {
    const socket = createSocket(target.host.includes(":") ? "udp6" : "udp4");
    socket.on("error", onError);
    return {
      send: (event) => socket.send(Buffer.from(formatSyslog(event)), target.port, target.host, (error) => error && onError(error)),
      close: () => socket.close(),
    };
  }
  // TCP: one connection, reopened on failure; lines are newline-framed (RFC 6587 non-transparent framing).
  let socket: Socket | null = null;
  const open = (): Socket => {
    if (socket && !socket.destroyed) return socket;
    const next = connect({ host: target.host, port: target.port });
    next.on("error", (error) => {
      onError(error);
      next.destroy();
    });
    socket = next;
    return next;
  };
  return {
    send: (event) => {
      open().write(`${formatSyslog(event)}\n`);
    },
    close: () => socket?.end(),
  };
}
