# ADR 0002 — The phone's local recording is the source of truth

- Status: accepted
- Date: 2026-11-07

## Context

Mobile coverage at test tracks is unreliable, MQTT batches can be lost (QoS 0) and the live
link adds latency. Engineering results (acceleration time, turning radius, fatigue usage
profile, DVP&R evidence) must not depend on whether the network held up.

## Decision

Sensor Logger always records locally (**"Skip Writing" off**). The CSV export of that
recording is the input for all offline analysis. The live stream is for monitoring only; its
NDJSON backup is a convenience (quick look, demo playback, cross-check), not evidence.

Both sources are parsed into the same long schema with the same sensor and field names, so
analysis code does not care where the data came from.

## Consequences

- Every run must be exported from the phone after the test (field guide step), and the export
  must not be edited in a spreadsheet (it destroys timestamp precision).
- Live counters and the dashboard can be approximate (decimated, simple axis alignment) without
  affecting reported results.
- Missing stream messages are reported in the dashboard but are not a data-loss event.
