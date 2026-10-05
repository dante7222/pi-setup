import type {
  ExtensionAPI,
  Theme,
  ThemeColor,
  ThemeStyle,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";

function withYellowHeader(theme: Theme): Theme {
  return new Proxy(theme, {
    get(target, property) {
      if (property === "fg") {
        return (color: ThemeColor, text: string) =>
          target.fg(color === "toolTitle" || color === "accent" ? "warning" : color, text);
      }

      if (property === "style") {
        return (text: string, options: ThemeStyle) => target.style(text, {
          ...options,
          fg: options.fg === "toolTitle" || options.fg === "accent" ? "warning" : options.fg,
        });
      }

      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function yellowFileHeaders(pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next) => {
    const original = next();
    if ((toolName !== "edit" && toolName !== "write") || !original) return original;

    const renderers: ToolRenderers = { ...original };
    if (original.renderCall) {
      const renderCall = original.renderCall;
      renderers.renderCall = (args, theme, context) =>
        renderCall(args, withYellowHeader(theme), context);
    }
    if (original.renderResult) {
      const renderResult = original.renderResult;
      // Native edit results rebuild their call header after settling. Apply
      // the same presentation there without replacing executable tools.
      renderers.renderResult = (result, options, theme, context) =>
        renderResult(result, options, withYellowHeader(theme), context);
    }
    return renderers;
  });
}
