import {
  getAgentDir,
  type ExtensionAPI,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const WEB_ACCESS_SOURCE = "npm:pi-web-access";
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
const ENABLE_CHOICE = "On — load web tools and the librarian skill";
const DISABLE_CHOICE = "Off — keep the package installed";

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isWebAccessEntry(entry: PackageSource): boolean {
  const source = sourceOf(entry);
  return source === WEB_ACCESS_SOURCE || source.startsWith(`${WEB_ACCESS_SOURCE}@`);
}

type WebAccessState = "on" | "off" | "filtered";

function entryState(entry: PackageSource): WebAccessState {
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
  // Effective glob matches require resolved package contents. Status must not
  // install/resolve packages or claim arbitrary nonempty filters load resources.
  return "filtered";
}

export function getWebAccessState(
  packages: readonly PackageSource[],
): WebAccessState | undefined {
  const states = packages.filter(isWebAccessEntry).map(entryState);
  if (states.length === 0) return undefined;
  return states.every((state) => state === states[0]) ? states[0] : "filtered";
}

export function setWebAccessEnabled(
  packages: readonly PackageSource[],
  enabled: boolean,
): PackageSource[] | undefined {
  let found = false;
  const updated = packages.map((entry): PackageSource => {
    if (!isWebAccessEntry(entry)) return entry;
    found = true;
    const source = sourceOf(entry);
    return enabled ? source : { source, autoload: false };
  });
  return found ? updated : undefined;
}

export default function webAccessToggle(pi: ExtensionAPI): void {
  pi.registerCommand("web-access", {
    description: "Enable or disable pi-web-access and reload Pi",
    getArgumentCompletions: (prefix) => {
      const operations = ["on", "off", "status"];
      const matches = operations.filter((operation) => operation.startsWith(prefix));
      return matches.length > 0
        ? matches.map((operation) => ({ value: operation, label: operation }))
        : null;
    },
    handler: async (args, ctx) => {
      const operation = args.trim().toLowerCase();
      if (operation && operation !== "on" && operation !== "off" && operation !== "status") {
        ctx.ui.notify("Usage: /web-access [on|off|status]", "warning");
        return;
      }

      const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const loadError = settingsManager
        .drainErrors()
        .find(({ scope }) => scope === "global");
      if (loadError) {
        ctx.ui.notify(
          `Could not read global Pi settings: ${loadError.error.message}`,
          "error",
        );
        return;
      }

      const packages = settingsManager.getGlobalSettings().packages ?? [];
      const currentState = getWebAccessState(packages);
      if (currentState === undefined) {
        ctx.ui.notify(
          "pi-web-access is not registered in global Pi settings.",
          "error",
        );
        return;
      }

      if (operation === "status") {
        ctx.ui.notify(
          currentState === "filtered"
            ? "Web access is filtered in global settings; effective loading depends on resource matches. Use /web-access on to restore default loading."
            : `Web access is ${currentState} in global settings${currentState === "off" ? "; the package remains installed" : ""}.`,
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
            `Web access is ${currentState} in global settings. Usage: /web-access <on|off|status>`,
            "info",
          );
          return;
        }
        const choice = await ctx.ui.select(
          `Web access is currently ${currentState} in global settings`,
          currentState === "on"
            ? [DISABLE_CHOICE, ENABLE_CHOICE]
            : [ENABLE_CHOICE, DISABLE_CHOICE],
        );
        if (choice === undefined) return;
        enable = choice === ENABLE_CHOICE;
      }

      if (currentState === (enable ? "on" : "off")) {
        ctx.ui.notify(
          enable
            ? "Web access is already on."
            : "Web access is already off; the package remains installed.",
          "info",
        );
        return;
      }

      const updatedPackages = setWebAccessEnabled(packages, enable);
      if (!updatedPackages) {
        ctx.ui.notify("Could not update the pi-web-access package entry.", "error");
        return;
      }

      settingsManager.setPackages(updatedPackages);
      await settingsManager.flush();
      const writeError = settingsManager
        .drainErrors()
        .find(({ scope }) => scope === "global");
      if (writeError) {
        ctx.ui.notify(
          `Could not update global Pi settings: ${writeError.error.message}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Web access ${enable ? "enabled" : "disabled"}; reloading Pi.`,
        "info",
      );
      await ctx.reload();
      return;
    },
  });
}
