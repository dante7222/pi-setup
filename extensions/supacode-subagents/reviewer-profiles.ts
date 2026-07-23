// Edit this file to change the reviewers that delegate_loop launches by default.
// Run /reload after saving changes.
//
// Skill paths may be absolute, start with ~, or be relative to this package root
// (for example "skills/my-review-skill"). Reviewers disable normal skill
// discovery, so only skills listed here are available to them.

export type ReviewerThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ReviewerProfile {
  /** Stable identifier written to loop artifacts. */
  id: string;
  /** Set false to keep the profile without launching it. */
  enabled: boolean;
  /** Short Supacode pane title. */
  title: string;
  /** Review angle and acceptance rubric appended to the shared review prompt. */
  prompt: string;
  /** Trusted Agent Skill file or directory paths loaded only for this reviewer. */
  skills: string[];
  /** Optional Pi model pattern; omit to inherit the parent model. */
  model?: string;
  /** Optional thinking level; omit to inherit the parent level. */
  thinking?: ReviewerThinkingLevel;
}

export const reviewerProfiles = [
  {
    id: "correctness",
    enabled: true,
    title: "correctness review",
    prompt: `Review behavioral correctness and completion of the stated objective.
Check requirements coverage, logic, edge cases, regressions, compatibility, and whether tests exercise the changed behavior.
Distinguish blocking defects from optional improvements; request repair only for concrete issues that affect acceptance.`,
    skills: [],
  },
  {
    id: "architecture",
    enabled: true,
    title: "architecture review",
    prompt: `Review architecture and long-term maintainability.
Check module boundaries, API design, coupling, duplication, dependency choices, consistency with established repository patterns, and unnecessary complexity.
Request repair for structural defects that create material maintenance or compatibility risk, not subjective style preferences.`,
    skills: [],
  },
  {
    id: "security-reliability",
    enabled: true,
    title: "security reliability review",
    prompt: `Review security, reliability, and failure behavior.
Check trust boundaries, input validation, command and filesystem safety, concurrency and race conditions, resource cleanup, recovery paths, error handling, and unsafe defaults.
Request repair for exploitable behavior, data-loss risk, orphaned resources, or failures that can incorrectly report success.`,
    skills: [],
  },
] satisfies ReviewerProfile[];

export function enabledReviewerProfiles(
  profiles: ReadonlyArray<ReviewerProfile> = reviewerProfiles,
): ReviewerProfile[] {
  const enabled = profiles.filter((profile) => profile.enabled);
  const ids = new Set<string>();
  for (const profile of enabled) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) {
      throw new Error(`Reviewer profile ID must use lowercase words separated by hyphens: ${profile.id || "(empty)"}`);
    }
    if (ids.has(profile.id)) throw new Error(`Duplicate reviewer profile ID: ${profile.id}`);
    ids.add(profile.id);
    if (!profile.title.trim()) throw new Error(`Reviewer profile ${profile.id} has an empty title.`);
    if (!profile.prompt.trim()) throw new Error(`Reviewer profile ${profile.id} has an empty prompt.`);
    for (const skill of profile.skills) {
      if (!skill.trim()) throw new Error(`Reviewer profile ${profile.id} contains an empty skill path.`);
    }
  }
  return enabled;
}
