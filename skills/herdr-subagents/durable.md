# Experimental durable subagents

This is a **separate opt-in prototype**, targeting `@earendil-works/pi-durable` 1.0.0. Its API is experimental. Ordinary `subagents` workers remain the default and retain normal Pi resource discovery.

The durable backend has one coordinator process and one storage owner per parent scope. Clients and terminal viewers use IPC; they never open the coordinator's storage. Conversations, submissions, request identities, reports and acknowledgements survive coordinator restarts. No report automatically prompts the parent model.

## Native interface

Discover deferred `durable_subagents`, or `/subagents durable-enable` to declare it directly (`durable-disable` returns it to deferred). Every result is `{ok,action,data?,error?}`; **check `ok`** even when a codemode call resolves.

1. Explicitly opt in: `{action:"start",experimental:true}`.
2. Spawn: `{action:"spawn",requestId:"review-1",name:"review",prompt:"Review the assigned files"}`. Model, thinking and cwd default from the live parent context. An explicit `model` is `{provider,modelId}`; overriding model drops inherited thinking.
3. `status` and `wait` (0–60 seconds) inspect bounded metadata/readiness. `read` an attempt `id`, consume all pages, then `ack` each `receipt` contiguously. Reads are replayable; never acknowledge unseen output.
4. `send` uses an existing report/attempt `id` (not the numeric `conversationId`), a new `message`, `kind:"steer"|"follow_up"`, and a stable `requestId`. It creates a separately tracked submission/report in the same conversation.
5. `cancel` requires `id` (or `"all"`) and stable `requestId`. Cancellation is intentional stop, not pause.
6. `shutdown` pauses/closes the coordinator while preserving unfinished work. A subsequent `start` opens it paused. `resume` explicitly recovers pending work. Status/read/open alone must not restart execution.

Retry requests with **the same ID and identical explicit arguments** after response loss. The first admission’s resolved model/thinking/cwd remain fixed even if parent defaults change. Different explicit arguments under the same ID are rejected. An unfinished durable intent is reconciled with the same durable submission ID, not a fresh prompt.

Parent Stop/session departure cancels durable work as well as ordinary workers. An offline coordinator receives a persisted stop intent, applied before any later resume/new work. A retained admission generation fences pre-Stop queued submissions even after cancellation completes; only a fresh explicit request can admit new work. Parent process death pauses the coordinator; it does not authorize indefinite detached model work. Reload alone preserves work. Cancelling only an IPC wait does not cancel the underlying submission.

## CLI and viewers

Run `node <absolute-skill-directory>/durable.mjs`:

- `start --experimental`
- `request [request.json|-]` (JSON action object; stdin with `-`)
- `cancel-all`
- `shutdown`
- `view <id>` (read-only status/report viewer in the current terminal)

A viewer does not own storage, execute a model, or replay a prompt. Closing a viewer is not task cancellation. Use explicit cancellation through the coordinator.

## Different resource contract

This prototype reuses Pi's saved authentication/model configuration, **not** ordinary extension factories, skills, prompt templates, group context, permission extensions, or custom extension providers. Use ordinary workers when those resources matter. Providers installed only by an extension may be unavailable here.

Default tools are **read-only**. `tools:"coding"` explicitly enables durable's built-in read/write/edit/bash tools in the supplied cwd. This is not an OS sandbox. Do not use the prototype to bypass an approval requirement; isolate untrusted work externally. The durable tools are not replacements for this package's ordinary Bash timeout/permission extensions. Durable Bash has independent process supervision and a 120-second default timeout. Startup recovery verifies cleanup before reopening tasks; unknown cleanup blocks progress rather than reporting success. This uses sampled process identities, not an OS sandbox: second-precision PID reuse and daemon escapes between samples remain limitations.

Durability does **not** make arbitrary file writes, shell commands, network effects or model requests exactly once. Safe declared tools can replay; interrupted unsafe calls become interrupted results. Model requests may be repeated after a crash before their result commits. Only explicit application request/report identities deduplicate admission and delivery.

Private coordinator files can contain prompts, commands, project data and model output. Shell environment values travel through anonymous pipes, not the journal or argv; a command that prints secrets still saves them as output. Do not share or delete coordinator files while it is live. The archive is retained without pruning; automatic retries and compaction are disabled. Crash recovery is not a power-loss durability guarantee. Usage is metadata and is never repeatedly charged to the parent on status/read. Prototype tests use a faux provider regardless of ambient API keys; production use requires a deliberate model choice and opt-in.
