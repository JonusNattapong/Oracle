# Oracle Situated Companion

Oracle Companion is a local-first Runtime loop for semantic presence and
self-initiated conversation. It does not ingest coordinates, call a model, or
send a message by itself in this MVP. It decides whether a downstream channel
may speak and records both speech and silence as auditable intents.

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

## Runtime API

All routes require the Runtime admin bearer token:

```text
GET    /v1/companion/state
POST   /v1/companion/presence
POST   /v1/companion/evaluate
POST   /v1/companion/pause
POST   /v1/companion/resume
DELETE /v1/companion/presence
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

## Deliberate MVP boundary

This version provides operational initiative: Oracle forms a candidate,
reflects through an interruption and privacy boundary, and records a decision.
It does not claim consciousness or felt desire. A future notification, mobile,
or voice adapter should consume only `speak` intents and must keep the same
pause, freshness, quiet-hour, and semantic-only boundaries.
