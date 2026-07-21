import {
  createGrepToolDefinition,
  type ExtensionAPI,
  isToolCallEventType,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { invokesGrep } from "./command-policy.ts";

const POLICY = "Use `rg` (ripgrep) for all text searches. Never invoke `grep`, `git grep`, or a wrapped grep command.";

function withRgLabel(theme: Theme): Theme {
  return new Proxy(theme, {
    get(target, property) {
      if (property === "bold") {
        return (text: string) => target.bold(text === "grep" ? "rg" : text);
      }

      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function rgOnly(pi: ExtensionAPI): void {
  const rg = createGrepToolDefinition(process.cwd());

  pi.registerTool({
    ...rg,
    name: "rg",
    label: "rg",
    description: rg.description.replace("Search file contents", "Search file contents with ripgrep"),
    promptSnippet: "Search file contents with ripgrep (respects .gitignore)",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createGrepToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      return rg.renderCall!(args, withRgLabel(theme), context);
    },
  });

  pi.on("session_start", () => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("grep")) return;
    pi.setActiveTools([...activeTools.filter((name) => name !== "grep"), "rg"]);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Text search policy\n\n${POLICY}`,
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName === "grep") {
      return { block: true, reason: "The grep tool is disabled. Use the rg tool instead." };
    }
    if (isToolCallEventType("bash", event) && invokesGrep(event.input.command)) {
      return { block: true, reason: "grep is disabled. Rewrite the command with rg (ripgrep)." };
    }
    return undefined;
  });
}
