export type OracleErrorCode =
  | "ORACLE_CONFIG_INVALID"
  | "ORACLE_PROVIDER_UNAVAILABLE"
  | "ORACLE_NO_FILES"
  | "ORACLE_SECRET_DETECTED"
  | "ORACLE_INPUT_TOO_LARGE"
  | "ORACLE_SESSION_NOT_FOUND"
  | "ORACLE_INVALID_REQUEST"
  | "ORACLE_WEB_UNAVAILABLE"
  | "ORACLE_AGENT_UNAVAILABLE"
  | "ORACLE_BROWSER_UNSUPPORTED_PLATFORM"
  | "ORACLE_BROWSER_MODE_DISABLED"
  | "ORACLE_BROWSER_NOT_IMPLEMENTED"
  | "ORACLE_BROWSER_EXECUTION_FAILED"
  | "ORACLE_ACCOUNT_MEMORY_UNSUPPORTED"
  | "ORACLE_ACCOUNT_MEMORY_INVALID"
  | "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED"
  | "ORACLE_BRIDGE_INVALID"
  | "ORACLE_BRIDGE_UNAVAILABLE"
  | "ORACLE_INTERNAL_ERROR";

export class OracleError extends Error {
  constructor(
    readonly code: OracleErrorCode,
    message: string,
    readonly suggestion: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "OracleError";
  }
}

export interface SerializedOracleError {
  code: OracleErrorCode;
  message: string;
  suggestion: string;
  details?: Record<string, unknown>;
}

export function serializeOracleError(error: unknown): SerializedOracleError {
  if (error instanceof OracleError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      ...(error.details ? { details: error.details } : {})
    };
  }
  return {
    code: "ORACLE_INTERNAL_ERROR",
    message: "Oracle encountered an unexpected error.",
    suggestion: "Run oracle_doctor and inspect the server logs."
  };
}
