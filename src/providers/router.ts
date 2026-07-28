import type { ProjectConfig } from "../config/project.js";
import type { ProviderName, ProviderSelection } from "./factory.js";

export interface ProviderRoute {
  requestedModel: string;
  model: string;
  provider: ProviderName;
  source: "explicit" | "project-config" | "model-prefix" | "environment" | "default";
  endpoint: string;
  credentialSource?: string;
  configured: boolean;
}

type Environment = NodeJS.ProcessEnv;

function host(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function describe(
  provider: ProviderName,
  model: string,
  source: ProviderRoute["source"],
  config: ProjectConfig,
  environment: Environment
): ProviderRoute {
  if (provider === "browser") {
    return {
      requestedModel: model,
      model: model.replace(/^browser:/, ""),
      provider,
      source,
      endpoint:
        environment.ORACLE_REMOTE_HOST ??
        config.browser.remoteHost ??
        config.browser.remoteChrome ??
        "local Chrome",
      credentialSource: environment.ORACLE_REMOTE_TOKEN
        ? "ORACLE_REMOTE_TOKEN"
        : "browser session",
      configured: true
    };
  }
  if (provider === "openai") {
    return {
      requestedModel: model,
      model,
      provider,
      source,
      endpoint: "api.openai.com",
      credentialSource: "OPENAI_API_KEY",
      configured: Boolean(environment.OPENAI_API_KEY)
    };
  }
  if (provider === "anthropic") {
    return {
      requestedModel: model,
      model,
      provider,
      source,
      endpoint: "api.anthropic.com",
      credentialSource: "ANTHROPIC_API_KEY",
      configured: Boolean(environment.ANTHROPIC_API_KEY)
    };
  }
  if (provider === "openrouter") {
    return {
      requestedModel: model,
      model,
      provider,
      source,
      endpoint: host(
        config.openrouter.baseURL ?? environment.OPENROUTER_BASE_URL,
        "openrouter.ai"
      ),
      credentialSource: "OPENROUTER_API_KEY",
      configured: Boolean(environment.OPENROUTER_API_KEY)
    };
  }
  if (provider === "azure") {
    const configured = Boolean(
      (config.azure.endpoint ?? environment.AZURE_OPENAI_ENDPOINT) &&
        (config.azure.deployment ?? environment.AZURE_OPENAI_DEPLOYMENT) &&
        (config.azure.apiVersion ?? environment.AZURE_OPENAI_API_VERSION) &&
        environment.AZURE_OPENAI_API_KEY
    );
    return {
      requestedModel: model,
      model: model.replace(/^azure:/, ""),
      provider,
      source,
      endpoint: host(
        config.azure.endpoint ?? environment.AZURE_OPENAI_ENDPOINT,
        "Azure endpoint not set"
      ),
      credentialSource: "AZURE_OPENAI_API_KEY",
      configured
    };
  }
  return {
    requestedModel: model,
    model,
    provider,
    source,
    endpoint: "local codex CLI",
    credentialSource: "codex login",
    configured: true
  };
}

export function resolveProviderRoute(input: {
  model: string;
  selection?: ProviderSelection;
  selectionSource?: "explicit" | "project-config";
  config: ProjectConfig;
  environment?: Environment;
}): ProviderRoute {
  const environment = input.environment ?? process.env;
  const selection = input.selection ?? "auto";
  if (selection !== "auto") {
    return describe(
      selection,
      input.model,
      input.selectionSource ?? "explicit",
      input.config,
      environment
    );
  }

  const model = input.model;
  if (model.startsWith("browser:")) {
    return describe("browser", model, "model-prefix", input.config, environment);
  }
  if (model.startsWith("azure:")) {
    return describe("azure", model, "model-prefix", input.config, environment);
  }
  if (model.includes("/")) {
    return describe("openrouter", model, "model-prefix", input.config, environment);
  }
  if (/^claude[-.:]/i.test(model)) {
    return describe("anthropic", model, "model-prefix", input.config, environment);
  }
  if (/^(gpt|o\d|chatgpt)[-.:]/i.test(model)) {
    if (input.config.routing.preferAzure) {
      return describe("azure", model, "project-config", input.config, environment);
    }
    if (environment.OPENAI_API_KEY) {
      return describe("openai", model, "environment", input.config, environment);
    }
    return describe("browser", model, "environment", input.config, environment);
  }
  return describe(
    input.config.routing.defaultProvider,
    model,
    "default",
    input.config,
    environment
  );
}
