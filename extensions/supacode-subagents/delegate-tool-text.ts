export interface DelegateToolText {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export const delegateToolText = {
  delegate_apply: {
    description:
      "After explicit user instruction, queue a confirmed preview to apply a returned coding worker's filesystem without a destination commit. Clean applies attempt cleanup; branch and artifacts remain.",
    promptSnippet: "Preview and confirm applying a returned coding worker",
    promptGuidelines: [
      "Call delegate_apply only when the user explicitly asks to apply a returned worker; never call it automatically after any delegation.",
    ],
  },
  delegate: {
    description:
      "Run one context-isolated worker on the same host. Research gets read-only built-ins; coding uses a preserved worktree and leaves changes for explicit apply. Workers are instructed not to push or merge. Returns bounded output plus an artifact path.",
    promptSnippet: "Run one delegated worker",
    promptGuidelines: [
      "Make every delegate task self-contained; workers do not inherit the parent conversation.",
    ],
  },
  delegate_loop: {
    description:
      "Run a bounded implement-check-review-repair loop from a clean parent in one same-host worktree, with predeclared validation commands and fail-closed context-isolated reviews. It never applies automatically; workers are instructed not to push or merge.",
    promptSnippet: "Run a coding loop with checks and review",
    promptGuidelines: [
      "Give delegate_loop a self-contained objective with acceptance criteria and boundaries.",
      "Pass delegate_loop only non-interactive validation commands supplied by the user or documented in trusted project files; they run on the host in a separate worktree, not a sandbox.",
      "Omit delegate_loop.reviewers unless the user explicitly requests one-off overrides; configured reviewer profiles are the default.",
    ],
  },
  delegate_parallel: {
    description:
      "Run up to eight context-isolated workers concurrently on the same host. Research gets read-only built-ins; coding uses separate preserved worktrees and leaves changes for explicit apply. Workers are instructed not to push or merge. Returns bounded outputs plus artifact paths.",
    promptSnippet: "Run independent tasks concurrently",
    promptGuidelines: [
      "Use delegate_parallel only for independent tasks; make each task self-contained and use no more workers than needed.",
    ],
  },
} satisfies Record<
  "delegate" | "delegate_parallel" | "delegate_loop" | "delegate_apply",
  DelegateToolText
>;
