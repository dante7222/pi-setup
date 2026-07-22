const MAX_TASK_SLUG_LENGTH = 40;
const WORKER_ID_SUFFIX_LENGTH = 12;

export function codingWorktreeName(title: string, workerId: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TASK_SLUG_LENGTH)
    .replace(/-+$/g, "");
  const suffix = workerId
    .replace(/[^a-f0-9]/gi, "")
    .toLowerCase()
    .slice(0, WORKER_ID_SUFFIX_LENGTH);

  if (suffix.length !== WORKER_ID_SUFFIX_LENGTH) {
    throw new Error("Worker ID must contain at least 12 hexadecimal characters.");
  }
  return `${slug || "task"}-${suffix}`;
}
