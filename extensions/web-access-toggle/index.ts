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

function entryLoadsResources(entry: PackageSource): boolean {
  if (typeof entry === "string") return true;

  if (entry.autoload === false) {
    return RESOURCE_TYPES.some((resourceType) =>
      entry[resourceType]?.some(
        (pattern) => !pattern.startsWith("!") && !pattern.startsWith("-"),
      ) === true,
    );
  }

  return RESOURCE_TYPES.some((resourceType) => {
    const patterns = entry[resourceType];
    return patterns === undefined || patterns.length > 0;
  });
}

export function getWebAccessEnabled(
  packages: readonly PackageSource[],
): boolean | undefined {
  const entries = packages.filter(isWebAccessEntry);
  if (entries.length === 0) return undefined;
  return entries.some(entryLoadsResources);
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
      const currentlyEnabled = getWebAccessEnabled(packages);
      if (currentlyEnabled === undefined) {
        ctx.ui.notify(
          "pi-web-access is not registered in global Pi settings.",
          "error",
        );
        return;
      }

      if (operation === "status") {
        ctx.ui.notify(
          currentlyEnabled
            ? "Web access is on."
            : "Web access is off; the package remains installed.",
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
            `Web access is ${currentlyEnabled ? "on" : "off"}. Usage: /web-access <on|off|status>`,
            "info",
          );
          return;
        }
        const choice = await ctx.ui.select(
          `Web access is currently ${currentlyEnabled ? "on" : "off"}`,
          currentlyEnabled
            ? [DISABLE_CHOICE, ENABLE_CHOICE]
            : [ENABLE_CHOICE, DISABLE_CHOICE],
        );
        if (choice === undefined) return;
        enable = choice === ENABLE_CHOICE;
      }

      if (enable === currentlyEnabled) {
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
