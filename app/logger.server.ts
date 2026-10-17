import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type LogValue = string | number | boolean | null | undefined;
type LogDetails = Record<string, LogValue>;

const correlation = new AsyncLocalStorage<string>();

function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Runs a webhook handler so every log inside it is tagged with the same
 * `req=<id>`, which keeps concurrent requests tellable apart.
 */
export function withCorrelation<T>(handler: () => T): T {
  return correlation.run(newRequestId(), handler);
}

function formatDetails(details: LogDetails): string {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function write(
  level: "log" | "warn" | "error",
  scope: string,
  message: string,
  details: LogDetails,
): void {
  const requestId = correlation.getStore();
  const payload: LogDetails = requestId
    ? { req: requestId, ...details }
    : details;
  const marker =
    level === "error" ? "ERROR: " : level === "warn" ? "WARN: " : "";

  // Always stdout: mixing stdout/stderr lets the CLI reorder lines.
  console.log(
    `[storebridge:${scope}] ${marker}${message}${formatDetails(payload)}`,
  );
}

export function log(
  scope: string,
  message: string,
  details: LogDetails = {},
): void {
  write("log", scope, message, details);
}

export function logWarn(
  scope: string,
  message: string,
  details: LogDetails = {},
): void {
  write("warn", scope, message, details);
}

export function logError(
  scope: string,
  message: string,
  details: LogDetails = {},
): void {
  write("error", scope, message, details);
}
