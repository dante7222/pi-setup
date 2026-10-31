import {
  getAgentDir,
  type ExtensionAPI,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
const ENABLE_CHOICE = "On — load visual-explainer resources";
const DISABLE_CHOICE = "Off — keep the package installed";
const OFF_NOTE = "The package remains installed. Prior session history is unchanged; use /new for a clean context.";

type VisualExplainerState = "on" | "off" | "filtered";

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isVisualExplainerEntry(entry: PackageSource): boolean {
  // Match the canonical git source and its HTTPS spelling, including optional
  // .git and @refs (branch refs can contain slashes), but never sibling repos.
  return /^(?:git:github\.com\/|(?:git:)?https:\/\/github\.com\/)nicobailon\/visual-explainer(?:\.git)?(?:@[^\s]+)?$/.test(sourceOf(entry));
}

export function getVisualExplainerState(
  packages: readonly PackageSource[],
): VisualExplainerState | undefined {
  const states = packages.filter(isVisualExplainerEntry).map((entry): VisualExplainerState => {
    if (typeof entry === "string") return "on";
    if (entry.autoload === false) {
      const hasIncludes = RESOURCE_TYPES.some((resourceType) =>
        entry[resourceType]?.some(
          (pattern) => !pattern.startsWith("!") && !pattern.startsWith("-"),
        ) === true,
      );
      return hasIncludes ? "filtered" : "off";
    }
    if (RESOURCE_TYPES.every((resourceType) => entry[resourceType] === undefined)) {
      return "on";
    }
    if (RESOURCE_TYPES.every((resourceType) => entry[resourceType]?.length === 0)) {
      return "off";
    }
    // Arbitrary filters need resolved package contents; status must not resolve
    // or install packages, or claim that a nonempty filter matches resources.
    return "filtered";
  });
  if (states.length === 0) return undefined;
  return states.every((state) => state === states[0]) ? states[0] : "filtered";
}

export function setVisualExplainerEnabled(
  packages: readonly PackageSource[],
  enabled: boolean,
): PackageSource[] | undefined {
  let found = false;
  const updated = packages.map((entry): PackageSource => {
    if (!isVisualExplainerEntry(entry)) return entry;
    found = true;
    const source = sourceOf(entry);
    return enabled ? source : { source, autoload: false };
  });
  return found ? updated : undefined;
}

export default function visualExplainerToggle(pi: ExtensionAPI): void {
  // Command-only: no tools, event hooks, messages, or model-facing hints.
  pi.registerCommand("visual-explainer", {
    description: "Enable or disable visual-explainer and reload Pi",
    getArgumentCompletions: (prefix) => {
      const matches = ["on", "off", "status"].filter((operation) => operation.startsWith(prefix));
      return matches.length > 0
        ? matches.map((operation) => ({ value: operation, label: operation }))
        : null;
    },
    handler: async (args, ctx) => {
      const operation = args.trim().toLowerCase();
      if (operation && operation !== "on" && operation !== "off" && operation !== "status") {
        ctx.ui.notify("Usage: /visual-explainer [on|off|status]", "warning");
        return;
      }

      const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const loadError = settingsManager.drainErrors().find(({ scope }) => scope === "global");
      if (loadError) {
        ctx.ui.notify(`Could not read global Pi settings: ${loadError.error.message}`, "error");
        return;
      }

      // SettingsManager does not validate JSON shapes. Fail closed rather than
      // throwing on malformed package entries or overwriting their values.
      const configuredPackages: unknown = settingsManager.getGlobalSettings().packages;
      const packages = configuredPackages === undefined ? [] : configuredPackages;
      if (!Array.isArray(packages) || !packages.every((entry: unknown): entry is PackageSource => {
        if (typeof entry === "string") return true;
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
        const value = entry as Record<string, unknown>;
        return typeof value.source === "string"
          && (value.autoload === undefined || typeof value.autoload === "boolean")
          && RESOURCE_TYPES.every((resourceType) => {
            const patterns = value[resourceType];
            return patterns === undefined
              || (Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string"));
          });
      })) {
        ctx.ui.notify("Could not read global Pi settings: malformed packages configuration.", "error");
        return;
      }

      const currentState = getVisualExplainerState(packages);
      if (currentState === undefined) {
        ctx.ui.notify("visual-explainer is not registered in global Pi settings.", "error");
        return;
      }
      if (operation === "status") {
        ctx.ui.notify(
          currentState === "filtered"
            ? "Visual explainer is filtered in global settings; effective loading depends on resource matches. Use /visual-explainer on to restore default loading."
            : `Visual explainer is ${currentState} in global settings.${currentState === "off" ? ` ${OFF_NOTE}` : ""}`,
          "info",
        );
        return;
      }

      let enable: boolean;
      if (operation) {
        enable = operation === "on";
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Visual explainer is ${currentState} in global settings. Usage: /visual-explainer <on|off|status>`,
            "info",
          );
          return;
        }
        const choice = await ctx.ui.select(
          `Visual explainer is currently ${currentState} in global settings`,
          currentState === "on"
            ? [DISABLE_CHOICE, ENABLE_CHOICE]
            : [ENABLE_CHOICE, DISABLE_CHOICE],
        );
        if (choice === undefined) return;
        enable = choice === ENABLE_CHOICE;
      }

      if (currentState === (enable ? "on" : "off")) {
        ctx.ui.notify(
          `Visual explainer is already ${currentState} in global settings.${enable ? "" : ` ${OFF_NOTE}`}`,
          "info",
        );
        return;
      }
      const updatedPackages = setVisualExplainerEnabled(packages, enable);
      if (!updatedPackages) {
        ctx.ui.notify("Could not update the visual-explainer package entry.", "error");
        return;
      }
      settingsManager.setPackages(updatedPackages);
      await settingsManager.flush();
      const writeError = settingsManager.drainErrors().find(({ scope }) => scope === "global");
      if (writeError) {
        ctx.ui.notify(`Could not update global Pi settings: ${writeError.error.message}`, "error");
        return;
      }

      ctx.ui.notify(
        `Visual explainer ${enable ? "enabled" : "disabled"} in global settings; reloading Pi.${enable ? "" : ` ${OFF_NOTE}`}`,
        "info",
      );
      await ctx.reload();
      return;
    },
  });
}
