import type { RuntimeEventBus } from "../runtime/events.js";
import { sanitizeNotificationText } from "./notifier.js";
import type { CompanionService } from "./service.js";
import { CompanionStore, DuplicateDeliveryError } from "./store.js";
import type {
  CompanionChannelStatus,
  CompanionDelivery,
  CompanionIntent,
  CompanionNotifier
} from "./types.js";

const DEFAULT_COOLDOWN_MINUTES = 30;
const MAX_COOLDOWN_MINUTES = 24 * 60;

export interface CompanionDeliveryServiceOptions {
  now?: () => Date;
  /** Minimum gap between two delivered notifications on the same channel. */
  cooldownMinutes?: number;
}

/**
 * Carries a `speak` intent to local notification channels.
 *
 * Delivery is a separate stage from the decision itself: the Companion Inner
 * Loop decides whether to speak, and this service decides whether that decision
 * may still leave the terminal right now. Every gate re-runs here because time
 * passes between evaluation and dispatch — presence can expire, the user can
 * pause, quiet hours can begin. Anything uncertain fails closed to suppression.
 */
export class CompanionDeliveryService {
  private readonly now: () => Date;
  private readonly cooldownMinutes: number;

  constructor(
    private readonly store: CompanionStore,
    private readonly companion: CompanionService,
    private readonly events: RuntimeEventBus,
    private readonly notifiers: CompanionNotifier[],
    options: CompanionDeliveryServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.cooldownMinutes = options.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
    if (
      !Number.isInteger(this.cooldownMinutes)
      || this.cooldownMinutes < 0
      || this.cooldownMinutes > MAX_COOLDOWN_MINUTES
    ) {
      throw new Error(
        `cooldownMinutes must be an integer between 0 and ${MAX_COOLDOWN_MINUTES}.`
      );
    }
  }

  channels(): CompanionChannelStatus[] {
    const policy = this.store.getChannelPolicy();
    return this.notifiers.map((notifier) => ({
      channel: notifier.channel,
      enabled: notifier.enabled && policy[notifier.channel] === true,
      available: notifier.available,
      reason: notifier.unavailableReason
    }));
  }

  /**
   * Turns a channel on or off. Channels start disabled, so leaving the terminal
   * is always something the user asked for rather than a default.
   */
  setChannelEnabled(channel: string, enabled: boolean): CompanionChannelStatus[] {
    if (!this.notifiers.some((notifier) => notifier.channel === channel)) {
      throw new Error(`Unknown notification channel: ${channel}`);
    }
    this.store.setChannelEnabled(channel, enabled);
    this.events.publish("companion.channel.updated", { channel, enabled });
    return this.channels();
  }

  listDeliveries(limit = 20): CompanionDelivery[] {
    return this.store.listDeliveries(limit);
  }

  /**
   * Dispatches an intent to every configured channel. A `silence` intent is
   * rejected before any channel is consulted, so silence can never become a
   * notification. Returns one record per channel that was considered.
   */
  async dispatch(intent: CompanionIntent): Promise<CompanionDelivery[]> {
    if (intent.action !== "speak") return [];
    const results: CompanionDelivery[] = [];
    for (const notifier of this.notifiers) {
      results.push(await this.dispatchToChannel(intent, notifier));
    }
    return results;
  }

  private async dispatchToChannel(
    intent: CompanionIntent,
    notifier: CompanionNotifier
  ): Promise<CompanionDelivery> {
    const existing = this.store.findDelivery(intent.id, notifier.channel);
    if (existing) return existing;

    const suppression = this.suppressionReason(intent, notifier);
    const createdAt = this.now().toISOString();

    // The insert claims the (intent, channel) slot before any await, so a
    // concurrent dispatch — or a daemon restart mid-flight — cannot produce a
    // second attempt for the same intent.
    let delivery: CompanionDelivery;
    try {
      delivery = this.store.createDelivery({
        intentId: intent.id,
        channel: notifier.channel,
        status: suppression ? "suppressed" : "pending",
        attempts: 0,
        detail: suppression,
        createdAt
      });
    } catch (error) {
      if (error instanceof DuplicateDeliveryError) return error.existing;
      throw error;
    }

    if (suppression) {
      this.events.publish("companion.delivery.suppressed", {
        deliveryId: delivery.id,
        intentId: intent.id,
        channel: notifier.channel,
        reason: suppression
      });
      return delivery;
    }

    this.events.publish("companion.delivery.requested", {
      deliveryId: delivery.id,
      intentId: intent.id,
      channel: notifier.channel
    });

    const attemptedAt = this.now().toISOString();
    let result;
    try {
      result = await notifier.deliver(intent);
    } catch (error) {
      // A channel that throws is a failed delivery, never a crashed Runtime.
      result = {
        delivered: false,
        errorKind: "spawn_failed" as const,
        detail: error instanceof Error ? error.name : "notifier threw"
      };
    }

    if (result.delivered) {
      const deliveredAt = this.now().toISOString();
      const updated = this.store.updateDelivery(delivery.id, {
        status: "delivered",
        attempts: 1,
        attemptedAt,
        deliveredAt
      });
      this.events.publish("companion.delivery.delivered", {
        deliveryId: delivery.id,
        intentId: intent.id,
        channel: notifier.channel,
        deliveredAt
      });
      return updated;
    }

    const updated = this.store.updateDelivery(delivery.id, {
      status: "failed",
      attempts: 1,
      // Retained locally for debugging; deliberately not published.
      detail: result.detail ? sanitizeNotificationText(result.detail) : undefined,
      attemptedAt
    });
    this.events.publish("companion.delivery.failed", {
      deliveryId: delivery.id,
      intentId: intent.id,
      channel: notifier.channel,
      // A closed vocabulary, so replayed events never leak host paths or output.
      errorKind: result.errorKind ?? "unavailable"
    });
    return updated;
  }

  private suppressionReason(
    intent: CompanionIntent,
    notifier: CompanionNotifier
  ): string | undefined {
    if (!notifier.enabled) {
      return `Channel ${notifier.channel} is disabled.`;
    }
    if (this.store.getChannelPolicy()[notifier.channel] !== true) {
      return `Channel ${notifier.channel} is not enabled; `
        + "run `oracle companion channel enable` to opt in.";
    }
    if (!notifier.available) {
      return notifier.unavailableReason
        ?? `Channel ${notifier.channel} is unavailable.`;
    }
    const boundary = this.companion.deliveryGuard(intent);
    if (boundary) return boundary;

    const message = sanitizeNotificationText(intent.message ?? "");
    if (!message) return "Intent carried no deliverable message.";

    if (this.cooldownMinutes > 0) {
      const last = this.store.lastDeliveredAt(notifier.channel);
      if (last) {
        const elapsedMs = this.now().getTime() - new Date(last).getTime();
        if (elapsedMs < this.cooldownMinutes * 60_000) {
          return `Channel ${notifier.channel} is in cooldown until `
            + `${this.cooldownMinutes} minutes after ${last}.`;
        }
      }
    }
    return undefined;
  }
}
