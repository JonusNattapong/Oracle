import fs from "node:fs/promises";
import path from "node:path";
import type { ChatGptBrowserConfig, DiagnosticResult } from "./types.js";
import {
  ChromeLauncher,
  findChromeExecutable,
  findOrCreatePageTarget
} from "./chrome.js";
import { CdpSession, ResponseMonitor } from "./response.js";
import type { DoctorCheck } from "../backend.js";

export class BrowserDiagnostics {
  async runDoctor(config: ChatGptBrowserConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    // 1. Platform check
    const supported: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    const isSupported = supported.includes(process.platform);
    checks.push({
      name: "platform",
      ok: isSupported,
      detail: isSupported ? process.platform : `unsupported platform: ${process.platform}`
    });

    // 2. Chrome binary check
    const chrome = await findChromeExecutable();
    checks.push({
      name: "chrome executable",
      ok: Boolean(chrome),
      detail: chrome ?? "Google Chrome not found in standard paths"
    });

    // 3. Profile dir check
    let profileReady = false;
    try {
      const stat = await fs.stat(config.profileDir);
      profileReady = stat.isDirectory();
    } catch {
      profileReady = false;
    }
    checks.push({
      name: "oracle chrome profile",
      ok: profileReady,
      detail: profileReady
        ? config.profileDir
        : `profile not initialized. Run \`oracle browser setup\` to create ${config.profileDir}`
    });

    // 4. Experimental mode check
    checks.push({
      name: "experimental.browserMode",
      ok: config.enabled,
      detail: config.enabled
        ? "enabled"
        : "set experimental.browserMode to true in .oracle/config.json"
    });

    return checks;
  }

  async captureDiagnosticScreenshot(session: CdpSession, outputDir: string): Promise<string> {
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const res = await session.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" }
      );
      const filename = `browser-diagnostic-${Date.now()}.png`;
      const filePath = path.join(outputDir, filename);
      await fs.writeFile(filePath, Buffer.from(res.data, "base64"));
      return filePath;
    } catch (err) {
      throw new Error(`Failed to capture diagnostic screenshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function checkLiveChatGptAuthentication(
  config: ChatGptBrowserConfig
): Promise<DoctorCheck> {
  let session: CdpSession | undefined;
  try {
    const processInfo = await new ChromeLauncher().launch({
      ...config,
      headed: true
    });
    const target = await findOrCreatePageTarget(processInfo.port);
    if (!target.webSocketDebuggerUrl) {
      throw new Error("ChatGPT page does not expose a Chrome debugger endpoint.");
    }
    session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    const monitor = new ResponseMonitor(session);
    await monitor.navigateToChatGPT();
    const authentication = await monitor.authenticationStatus();
    return {
      name: "chatgpt account session",
      ok: authentication.authenticated,
      detail: authentication.detail
    };
  } catch (error) {
    return {
      name: "chatgpt account session",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    session?.close();
  }
}
