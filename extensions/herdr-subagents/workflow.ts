import { closeJobs, jobs, LIMIT, locked, reportPage, type Scope } from "./core.ts";
import { acknowledgeReport, readManyReports, waitForReports, type ReportBatch, type ReportsReady } from "./reports.ts";

export interface NextReports extends ReportBatch, Omit<ReportsReady, "ready"> {
  acknowledgementRequired: boolean;
  finished: boolean;
  closed: string[];
  closedOmitted?: number;
}

/**
 * One delivery cycle, NOT a consuming collect. Only caller-supplied receipts
 * from previously consumed output may advance cursors. New pages stay unacked.
 * A failed call may have committed prior acknowledgements/closures: replaying
 * those receipts is safe; report delivery resumes at the acknowledged cursor.
 * No scope lock spans the wait, so Stop/other operations remain available.
 */
export async function nextReports(scope: Scope, acknowledge: string[], seconds: number, signal?: AbortSignal, details = false): Promise<NextReports> {
  signal?.throwIfAborted();
  if (!Array.isArray(acknowledge) || acknowledge.length > LIMIT || new Set(acknowledge).size !== acknowledge.length || acknowledge.some((receipt) => typeof receipt !== "string" || !/^[a-f0-9]{12}\.[a-f0-9]{64}$/.test(receipt))) {
    throw new Error("Expected 0..16 unique report receipts to acknowledge.");
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error("Wait seconds must be 0..60.");
  if (typeof details !== "boolean") throw new Error("Wait details must be boolean.");
  // Snapshot explicit input before the first await. Never acknowledge receipts
  // inferred from disk, most recent reads, or a batch returned by this call.
  for (const receipt of [...acknowledge]) await acknowledgeReport(scope, receipt, signal);
  const closed = await locked(scope, async () => closeJobs(scope, await jobs(scope)), signal);
  signal?.throwIfAborted();
  // seconds bounds polling, not preceding acknowledgement/verified cleanup I/O.
  const { ready, ...readiness } = await waitForReports(scope, seconds, signal, details);
  const metadata = {
    ...readiness,
    // false is the longer JSON boolean: reserve both flags before issuing pages.
    acknowledgementRequired: false,
    finished: false,
    closed: closed.slice(0, LIMIT).map((name) => reportPage(name, 0, 64)),
    ...(closed.length > LIMIT ? { closedOmitted: closed.length - LIMIT } : {}),
  };
  // Reserve ALL metadata before issuing pages, not after concatenating a full
  // 12 KB report batch with progress/cleanup. Native/codemode envelope headroom
  // remains reserved inside readManyReports. No text is dropped to make it fit.
  const batch = ready.length
    ? await readManyReports(scope, ready, signal, Buffer.byteLength(JSON.stringify(metadata)))
    : { reports: [], errors: [] };
  signal?.throwIfAborted();
  return {
    ...batch, ...metadata,
    acknowledgementRequired: batch.reports.length > 0,
    finished: batch.reports.length === 0 && batch.errors.length === 0 && metadata.pending === 0,
  };
}
