export type DelegateLoopState =
  | "implementing"
  | "checking"
  | "reviewing"
  | "repairing"
  | "awaiting_apply"
  | "blocked"
  | "exhausted"
  | "failed";

export type ReviewVerdict = "pass" | "repair" | "blocked";

export interface LoopTransitionInput {
  attempt: number;
  maxAttempts: number;
  checksPassed: boolean;
  reviewVerdicts: Array<ReviewVerdict | undefined>;
  candidateFingerprint: string;
  previousCandidateFingerprints: ReadonlySet<string>;
}

export interface LoopTransition {
  state: "repairing" | "awaiting_apply" | "blocked" | "exhausted";
  reason: string;
}

export function normalizeValidationCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized) throw new Error("Validation commands must contain non-whitespace text.");
  return normalized;
}

export function parseReviewVerdict(output: string): ReviewVerdict | undefined {
  const finalLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const match = finalLine?.match(/^VERDICT:\s*(PASS|REPAIR|BLOCKED)$/i);
  return match?.[1].toLowerCase() as ReviewVerdict | undefined;
}

export function decideLoopTransition(input: LoopTransitionInput): LoopTransition {
  const repairOrExhaust = (repairReason: string, exhaustedReason: string): LoopTransition => {
    if (input.previousCandidateFingerprints.has(input.candidateFingerprint)) {
      return {
        state: "exhausted",
        reason: "Candidate state repeated without measurable progress.",
      };
    }
    return input.attempt < input.maxAttempts
      ? { state: "repairing", reason: repairReason }
      : { state: "exhausted", reason: exhaustedReason };
  };

  if (!input.checksPassed) {
    return repairOrExhaust(
      "One or more predeclared checks failed.",
      "Predeclared checks still fail after the final attempt.",
    );
  }

  if (input.reviewVerdicts.some((verdict) => verdict === undefined)) {
    return {
      state: "blocked",
      reason: "A reviewer did not return the required structured verdict.",
    };
  }

  if (input.reviewVerdicts.some((verdict) => verdict === "blocked")) {
    return {
      state: "blocked",
      reason: "A reviewer found an issue that requires human input or unavailable evidence.",
    };
  }

  if (input.reviewVerdicts.some((verdict) => verdict === "repair")) {
    return repairOrExhaust(
      "Context-isolated review requested repairs.",
      "Context-isolated review still requests repairs after the final attempt.",
    );
  }

  if (input.reviewVerdicts.length === 0) {
    return {
      state: "blocked",
      reason: "No context-isolated review verdicts were produced.",
    };
  }

  return {
    state: "awaiting_apply",
    reason: "All predeclared checks and context-isolated reviews passed.",
  };
}
