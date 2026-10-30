# AI usage

## Tools and scope

OpenAI Codex assisted with reading the assignment, reviewing the initial NestJS scaffold, designing the PostgreSQL schema and concurrency rules, implementing the API/worker/SSE services, writing integration tests, and preparing documentation. Commands and test output were used to check generated code. Channel providers remain mocked; no real provider credentials or live business database were used for tests.

## Real correction: impossible calendar dates

The initial AI-generated `timestamp()` function in [src/inbox/domain.ts](./src/inbox/domain.ts) used a broad ISO-shaped regular expression and `Number.isFinite(Date.parse(raw))`. That appeared to validate incoming webhook timestamps but accepted impossible calendar dates because JavaScript silently normalizes some values.

A regression assertion was added to [src/inbox/domain.spec.ts](./src/inbox/domain.spec.ts):

```ts
expect(() => timestamp('2026-02-30T10:15:00Z', 'sentAt')).toThrow();
```

Running `npm test -- --runInBand` actually failed with `Received function did not throw`: one failed test and three passing tests. This was an observed failure during implementation, not a hypothetical issue.

The correction validates exact timestamp components, leap years, month/day ranges, clock values and timezone offsets before converting to UTC. The regression also checks that `24:00:00` is rejected instead of silently moving to the next day. Invalid timestamps now produce HTTP 400 rather than changing message chronology and preview ordering.

## Verification approach

Domain tests cover validation and normalization; integration tests run actual PostgreSQL, parallel HTTP requests and SSE streams. They exercise database constraints/locks instead of pretending an in-memory mock proves concurrency. Provider failures and retry recovery are deterministic in tests, while normal application mock sends fail randomly at the configured probability.

Code and README document assumptions that the brief leaves open: explicit phone/email linking, globally unique provider IDs, terminal failures, read/reset ordering, and frozen pagination semantics. The implementation should be reviewed and understood before submission, including the external-send crash window and snapshot storage cost.
