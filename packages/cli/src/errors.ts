// The error codes an htmlgate Instance and this CLI produce, and the exit code each one ends the process with.

export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "CliError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

/** Process exit code for an error code. Stable: scripts switch on these. */
export function exitCodeFor(code: string): number {
  switch (code) {
    case "unauthorized":
    case "invalid_token":
    case "auth_required":
      return 2;
    case "forbidden":
      return 3;
    case "not_found":
    case "version_not_found":
    case "file_not_found":
    case "file_unreadable":
      return 4;
    case "rate_limited":
    case "quota_exceeded":
      return 5;
    case "html_too_large":
    case "body_too_large":
    case "site_too_large":
    case "file_too_large":
    case "title_too_long":
    case "description_too_long":
      return 6;
    case "invalid_arg":
    case "invalid_slug":
    case "invalid_json":
    case "invalid_token_id":
    case "html_required":
    case "title_required":
    case "metadata_only_on_patch":
    case "ambiguous_upsert":
    case "unsafe_path":
    case "site_invalid":
    case "invalid_expiry":
      return 7;
    case "network_error":
    case "insecure_url":
    case "redirected":
    case "bad_response":
    case "server_error":
    case "server_misconfigured":
    case "internal_error":
      return 8;
    case "cancelled":
      return 130;
    default:
      return 1;
  }
}
