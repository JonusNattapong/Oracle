import fs from "node:fs/promises";
import path from "node:path";
import type { ChatGptBrowserConfig, DiagnosticResult } from "./types.js";
import { COMPOSER_TOOL_LABELS } from "./types.js";
import {
  ChromeLauncher,
  findChromeExecutable,
  findOrCreatePageTarget
} from "./chrome.js";
import { CHATGPT_SELECTORS } from "./selectors.js";
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

/**
 * Reports whether each selector Browser Mode depends on still resolves.
 *
 * ChatGPT's DOM is not an API, and its composer menu carries no data-testid at
 * all — the handles are a class name and the visible label. When the UI changes,
 * every affected feature fails at the moment a user runs it, with a timeout that
 * says nothing about the cause. This turns that into something checkable before
 * it bites.
 *
 * Each group lists fallbacks in preference order, so the index that matched is
 * reported too: falling through to a later alternate is drift that has already
 * started, even while everything still works.
 */
export async function checkChatGptSelectors(
  config: ChatGptBrowserConfig
): Promise<DoctorCheck[]> {
  let session: CdpSession | undefined;
  try {
    const processInfo = await new ChromeLauncher().launch({ ...config, headed: true });
    const target = await findOrCreatePageTarget(processInfo.port);
    if (!target.webSocketDebuggerUrl) {
      throw new Error("ChatGPT page does not expose a Chrome debugger endpoint.");
    }
    session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    const monitor = new ResponseMonitor(session);
    await monitor.navigateToChatGPT();
    await monitor.waitForComposerReady();

    const checks: DoctorCheck[] = [];
    const resolve = async (group: keyof typeof CHATGPT_SELECTORS): Promise<number> =>
      session!.evaluate<number>(
        `(() => {
           const selectors = ${JSON.stringify(CHATGPT_SELECTORS[group])};
           for (let i = 0; i < selectors.length; i++) {
             if (document.querySelector(selectors[i])) return i;
           }
           return -1;
         })()`
      );

    // Present on an idle composer. `modelSelector` is included because its
    // failure is otherwise invisible: `selectModel` is only called when the
    // requested model differs from the default, so a UI without a model picker
    // at all — which is what this account now shows — goes unnoticed until
    // someone overrides the model and gets a click on an unrelated button.
    for (const group of ["promptInput", "attachButton", "fileInput", "modelSelector"] as const) {
      const index = await resolve(group);
      checks.push({
        name: `selector ${group}`,
        ok: index === 0,
        detail: index === -1
          ? `no selector matched: ${CHATGPT_SELECTORS[group].join(" | ")}`
          : index === 0
            ? `matched ${CHATGPT_SELECTORS[group][0]}`
            : `fell through to fallback #${index} (${CHATGPT_SELECTORS[group][index]}) — the preferred selector no longer matches`
      });
    }

    // The composer menu only exists while open, and only opens for trusted
    // input. Open it, read it, close it: a check must not leave a tool switched
    // on in the user's composer.
    const opened = await monitor.openComposerMenu();
    const items = opened ? await monitor.waitForComposerMenuItems() : [];
    if (opened) await monitor.closeComposerMenu();

    const menuIndex = opened ? await resolve("composerMenuItem") : -1;
    checks.push({
      name: "selector composerMenuItem",
      ok: opened && menuIndex === 0,
      detail: !opened
        ? "the composer plus menu did not open — --web-search and --deep-research will fail"
        : menuIndex === -1
          ? `no selector matched: ${CHATGPT_SELECTORS.composerMenuItem.join(" | ")}`
          : menuIndex === 0
            ? `matched ${CHATGPT_SELECTORS.composerMenuItem[0]}`
            : `fell through to fallback #${menuIndex} (${CHATGPT_SELECTORS.composerMenuItem[menuIndex]})`
    });

    // Driven by the tool registry, not a hand-written list: a tool added to
    // COMPOSER_TOOL_LABELS without a matching menu entry is drift this check
    // exists to catch, and a hardcoded list would not have caught it.
    for (const label of Object.values(COMPOSER_TOOL_LABELS)) {
      const present = items.some((item) => item.toLowerCase().startsWith(label.toLowerCase()));
      checks.push({
        name: `composer tool "${label}"`,
        ok: present,
        detail: present
          ? "listed in the composer menu"
          : `not listed — ${items.length ? `menu shows: ${items.join(", ")}` : "the menu appeared empty"}`
      });
    }

    return checks;
  } catch (error) {
    return [{
      name: "selectors",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }];
  } finally {
    session?.close();
  }
}
