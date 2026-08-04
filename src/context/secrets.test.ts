import { describe, expect, test } from "vitest";
import type { ContextFile } from "../types.js";
import { scanFilesForSecrets } from "./secrets.js";

function file(content: string): ContextFile {
  return { path: "config.txt", content, sizeBytes: Buffer.byteLength(content) };
}

describe("scanFilesForSecrets", () => {
  test.each([
    ["private-key", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"],
    ["openai-api-key", "sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
    ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
    ["sensitive-assignment", "database_password = super-secret-value"]
  ])("detects %s", (detector, content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([
      { path: "config.txt", line: 1, detector }
    ]);
  });

  test.each([
    "api_key = your-api-key-here",
    "password = <password>",
    "token = process.env.API_TOKEN",
    "client_secret = ${CLIENT_SECRET}",
    "const token = undefined"
  ])("allows placeholder value %s", (content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([]);
  });

  test.each([
    "function decodePlanTier(accessToken: string): PlanTier {",
    "  apiKey: string;",
    "async function refresh(clientSecret: string, token: string): Promise<void> {",
    "  password?: Record<string, unknown>;",
    "const read = (authToken: Buffer): number => authToken.length;"
  ])("allows TypeScript type annotation %s", (content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([]);
  });

  test.each([
    "      accessToken: data.access_token,",
    "const key = config.auth.apiKey;",
    "  clientSecret: options?.client_secret"
  ])("allows a value that references a secret instead of embedding it %s", (content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([]);
  });

  test("still reports a bare unquoted literal", () => {
    expect(scanFilesForSecrets([file("PASSWORD=hunter2000")])).toEqual([
      { path: "config.txt", line: 1, detector: "sensitive-assignment" }
    ]);
  });

  test("still reports a quoted value that merely looks like a type name", () => {
    expect(scanFilesForSecrets([file('password: "stringy-actual-value"')])).toEqual([
      { path: "config.txt", line: 1, detector: "sensitive-assignment" }
    ]);
  });

  test("does not include secret values in findings", () => {
    const secret = "extremely-sensitive-value";
    expect(JSON.stringify(scanFilesForSecrets([file(`password=${secret}`)]))).not.toContain(
      secret
    );
  });
});
