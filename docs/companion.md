# Oracle Situated Companion

Oracle Companion is a local-first Runtime loop for semantic presence and
self-initiated conversation. It does not ingest coordinates or call a model. It
decides whether a channel may speak, records both speech and silence as
auditable intents, and can carry a `speak` decision to a local notification
channel the user has explicitly enabled.

Four stages stay separate, and each is recorded on its own:

| Stage | Question it answers |
| --- | --- |
| Intent generation | What would Oracle say, if it said anything? |
| Boundary decision | Should it speak at all, right now? |
| Delivery | May that decision still leave the terminal? |
| Notification channel | How does it reach the user? |

## Start it

Companion state belongs to the persistent Runtime:

```bash
oracle daemon start
oracle companion status
```

Submit a semantic situation, not a latitude or longitude:

```bash
oracle companion presence away --source device --ttl 30
oracle companion presence home --source geofence --confidence 0.9 --ttl 180
```

Supported states are `home`, `work`, `transit`, `focus`, `available`, `away`,
and `unknown`. Sources are `manual`, `device`, `calendar`, and `geofence`.
Every observation has a confidence, provenance, observation time, and TTL.
The default TTL is 120 minutes and the maximum is 24 hours.

`presence` immediately evaluates a conversational candidate. Inspect or repeat
the decision:

```bash
oracle companion status
oracle companion evaluate
oracle companion evaluate --json
```

## Decision boundary

The deterministic MVP records this score:

```text
relevance
  + relational continuity
  + urgency
  - interruption cost
  - privacy risk
  - uncertainty
```

An intent speaks only when its score reaches the threshold and no hard gate is
active. The following conditions fail closed to `silence`:

- Companion is paused.
- Presence is missing or expired.
- Presence is `focus`, `transit`, `away`, or `unknown`.
- Local time is within the default quiet hours, 22:00-08:00.
- The candidate score is below the threshold.

Every intent includes its action, candidate, score components, reason, optional
message, presence reference, trigger, and timestamp. `silence` is persisted as
a first-class result so the absence of an interruption remains explainable.

## Human controls

```bash
# Pause until explicitly resumed
oracle companion pause

# Or pause temporarily
oracle companion pause --minutes 60

oracle companion resume

# Remove all retained semantic presence
oracle companion forget
```

Forgetting presence does not remove prior intent evidence. Intent records
contain only the semantic state reference and decision evidence, never raw
coordinates.

## Leaving the terminal

A `speak` intent is not a notification. Delivery is a separate stage with its
own gates, and every channel starts **disabled**: a fresh install never
notifies until asked.

```bash
oracle companion channels
oracle companion channel enable windows-toast
oracle companion notify-test
oracle companion deliveries
oracle companion channel disable windows-toast
```

On Windows, `windows-toast` raises a local toast. Nothing leaves the machine and
no cloud service is involved. On other platforms the channel reports itself as
unavailable rather than pretending a delivery succeeded.

Before anything is delivered, the Boundary runs a second time, because time
passes between deciding and delivering. Delivery is suppressed when:

- The intent action is `silence` — silence never reaches a channel at all.
- The channel is disabled or unavailable on this platform.
- Companion has been paused since the intent was formed.
- The referenced presence has expired or been forgotten.
- A newer presence observation superseded the intent.
- Presence is now `focus`, `transit`, `away`, or `unknown`.
- Local time has entered quiet hours.
- The channel is inside its cooldown window (30 minutes by default), so
  oscillating arrivals cannot produce repeated notifications.
- The intent carries no deliverable message.

Every attempt is persisted with its status, attempt count, and reason. A unique
constraint on (intent, channel) makes dispatch idempotent: an intent is never
delivered twice, and restarting the daemon never replays a completed delivery.
An interrupted delivery stays `pending` and is deliberately not retried —
failing closed is preferred to a surprise notification arriving late.

A failing channel never fails the decision that produced the intent, and never
takes the Runtime down with it. The failure is recorded; the presence update
stands.

## Runtime API

All routes require the Runtime admin bearer token:

```text
GET    /v1/companion/state
POST   /v1/companion/presence
POST   /v1/companion/evaluate
POST   /v1/companion/pause
POST   /v1/companion/resume
DELETE /v1/companion/presence
GET    /v1/companion/channels
POST   /v1/companion/channels
GET    /v1/companion/deliveries
POST   /v1/companion/notify-test
```

Example presence body:

```json
{
  "state": "home",
  "source": "geofence",
  "confidence": 0.9,
  "ttlMinutes": 180
}
```

The API rejects unexpected fields. `lat`, `latitude`, `lng`, `longitude`,
`coordinates`, and `gps` receive an explicit raw-location rejection.

Runtime emits replayable events:

- `companion.presence.updated`
- `companion.presence.forgotten`
- `companion.intent.evaluated`
- `companion.paused`
- `companion.resumed`
- `companion.channel.updated`
- `companion.delivery.requested`
- `companion.delivery.delivered`
- `companion.delivery.failed`
- `companion.delivery.suppressed`

Delivery events carry the delivery id, intent id, channel, and either a
suppression reason or a classified `errorKind`. Message text and raw channel
output stay out of the event log; failure detail is kept locally in the delivery
record instead.

## Deliberate MVP boundary

This version provides operational initiative: Oracle forms a candidate, reflects
through an interruption and privacy boundary, records a decision, and can raise
a local notification. It does not claim consciousness or felt desire.

Still out of scope: receiving presence from a phone or tray app, model-generated
messages, long-term relationship memory in candidate construction, learning from
whether the user answered, Control Center surfacing, and configurable quiet
hours or thresholds.

Any future channel — mobile, voice, or a remote transport — implements the same
`CompanionNotifier` interface, consumes only `speak` intents, and inherits the
same pause, freshness, quiet-hour, cooldown, and semantic-only boundaries.
Channels that leave the machine must stay opt-in and must never be enabled by
default.
