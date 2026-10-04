# Granular report workflow

Use [the native next cycle](orchestration.md) for ordinary orchestration. Keep the separate actions for selective acknowledgement, replay/inspection, diagnosing failures or retaining a completed pane intentionally. They use the same receipts/cursors; do not run competing readers/acknowledgers for one report.

`wait` takes optional `seconds:0..60` (default 30) and `details:true`; returns ready IDs, pending count and optional progress/warning. Pending includes historical ready jobs outside its capped 16-ID page. Readiness is not acknowledgement. `read_many` takes 1–16 unique IDs and returns `{reports,errors}`, one page per job at its acknowledged cursor.

## Wait and emit one batch

```js
if ((load("herdr.manual.receipts") ?? []).length) throw Error("Previous pages await consumption/ack; do not overwrite their receipts.");
const ready = await tools.subagents({action:"wait", seconds:30});
if (!ready.ok) throw Error(ready.error);
if (!ready.data.ready.length) { text(ready.data); return; }
const r = await tools.subagents({action:"read_many", ids:ready.data.ready});
if (!r.ok) throw Error(r.error);
text(r.data);
store("herdr.manual.receipts", r.data.reports.map(p => p.receipt));
```

Inspect per-job errors. Read all emitted pages before acknowledging them in a later model call. One 12 KB batch per script; combined output from several batches can truncate.

## Acknowledge consumed pages, then close

```js
const receipts = load("herdr.manual.receipts") ?? [];
if (!receipts.length) throw Error("No delivered pages stored for acknowledgement.");
for (const receipt of receipts) {
  const r = await tools.subagents({action:"ack", receipt});
  if (!r.ok) throw Error(r.error);
}
const closed = await tools.subagents({action:"close"});
if (!closed.ok) throw Error(closed.error);
store("herdr.manual.receipts", undefined);
text(closed.data);
```

For selective handling, acknowledge only receipts for pages actually consumed; retain the others locally. Retrying partially committed acknowledgements is idempotent. Closing requires full acknowledgement and verified cleanup. Neither reading nor fetching a receipt proves the model consumed it.

## Replay and diagnostics

- `read` takes `id` and optional UTF-16 `offset`. Omit offset to read from the acknowledged cursor; explicit offsets replay exact ranges, including already acknowledged text. Receipts still require contiguous acknowledgement and cannot skip unseen pages.
- `status` takes optional `offset`; returns the artifact root, progress, finalized usage and optional next offset. Usage is metadata, not repeated parent charges. Avoid printing unchanged counters.
- `cancel` takes `ids` (array or `"all"`) and requests cleanup; unread reports remain saved. Never force-close workers. `stop` keeps the inspection pane; see [persistent.md](persistent.md).
- After a lost/truncated delivery, discard only its local stored receipt list and reread without acknowledgement. If switching workflows, first finish acknowledgement of consumed stored pages or reread unconsumed pages; never assume another store key proves consumption.
- Existing task failure, cleanup, ownership or stale-receipt errors remain explicit; neither `next` nor manual operations bypass them. See [troubleshooting.md](troubleshooting.md).
