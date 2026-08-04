import { describe, expect, test } from "vitest";
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from "../config/project.js";
import { resolveProviderRoute } from "./router.js";

function config(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    include: [...DEFAULT_PROJECT_CONFIG.include],
    exclude: [...DEFAULT_PROJECT_CONFIG.exclude],
    browser: { ...DEFAULT_PROJECT_CONFIG.browser },
    worker: { ...DEFAULT_PROJECT_CONFIG.worker },
    azure: { ...DEFAULT_PROJECT_CONFIG.azure },
    openrouter: { ...DEFAULT_PROJECT_CONFIG.openrouter },
    routing: { ...DEFAULT_PROJECT_CONFIG.routing },
    ...overrides
  };
}

describe("resolveProviderRoute", () => {
  test("honors an explicit provider", () => {
    expect(
      resolveProviderRoute({
        model: "gpt-5.6",
        selection: "openai",
        selectionSource: "explicit",
        config: config(),
        environment: {}
      })
    ).toMatchObject({
      provider: "openai",
      source: "explicit",
      credentialSource: "OPENAI_API_KEY",
      configured: false
    });
  });

  test("routes vendor/model ids to OpenRouter", () => {
    expect(
      resolveProviderRoute({
        model: "anthropic/claude-sonnet-4.6",
        selection: "auto",
        config: config(),
        environment: { OPENROUTER_API_KEY: "secret" }
      })
    ).toMatchObject({
      provider: "openrouter",
      source: "model-prefix",
      configured: true
    });
  });

  test("routes GPT models to OpenAI when configured and browser otherwise", () => {
    expect(
      resolveProviderRoute({
        model: "gpt-5.6",
        selection: "auto",
        config: config(),
        environment: { OPENAI_API_KEY: "secret" }
      }).provider
    ).toBe("openai");
    expect(
      resolveProviderRoute({
        model: "gpt-5.6",
        selection: "auto",
        config: config(),
        environment: {}
      }).provider
    ).toBe("chatgpt-browser");
  });

  test("supports explicit Azure model prefixes without exposing credentials", () => {
    expect(
      resolveProviderRoute({
        model: "azure:company-gpt",
        selection: "auto",
        config: config({
          azure: {
            endpoint: "https://company.openai.azure.com",
            deployment: "company-gpt",
            apiVersion: "2025-01-01"
          }
        }),
        environment: { AZURE_OPENAI_API_KEY: "top-secret" }
      })
    ).toEqual(
      expect.objectContaining({
        provider: "azure",
        model: "company-gpt",
        endpoint: "company.openai.azure.com",
        credentialSource: "AZURE_OPENAI_API_KEY",
        configured: true
      })
    );
  });
});
