import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";

function withYellowHeader(theme: Theme): Theme {
  return new Proxy(theme, {
    get(target, property) {
      if (property === "fg") {
        return (color: ThemeColor, text: string) =>
          target.fg(color === "toolTitle" || color === "accent" ? "warning" : color, text);
      }

      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function yellowFileHeaders(pi: ExtensionAPI): void {
  const edit = createEditToolDefinition(process.cwd());
  const write = createWriteToolDefinition(process.cwd());

  pi.registerTool({
    ...edit,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      return edit.renderCall!(args, withYellowHeader(theme), context);
    },
  });

  pi.registerTool({
    ...write,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      return write.renderCall!(args, withYellowHeader(theme), context);
    },
  });
}
