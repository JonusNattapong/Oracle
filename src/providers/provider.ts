import type {
  ExecutionBackend,
  ExecutionBackendRequest,
  ExecutionBackendResponse
} from "../backends/backend.js";

/** @deprecated Use `ExecutionBackendRequest` instead. */
export type ProviderRequest = ExecutionBackendRequest;

/** @deprecated Use `ExecutionBackendResponse` instead. */
export type ProviderResponse = ExecutionBackendResponse;

/** @deprecated Use `ExecutionBackend` instead. */
export type Provider = ExecutionBackend;
