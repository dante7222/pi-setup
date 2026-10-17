import * as os from "node:os";
import type {
  ExtensionAPI,
  Theme,
  ThemeColor,
  ThemeStyle,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";

/** Header path text as Pi's renderToolPath displays it (home shortened to `~`). */
function headerPathTexts(args: unknown): Set<string> {
  const texts = new Set<string>();
  if (typeof args !== "object" || args === null) return texts;
  const record = args as Record<string, unknown>;
  const raw = record.file_path ?? record.path;
  if (typeof raw !== "string" || raw === "") return texts;
  texts.add(raw);
  const home = os.homedir();
  if (raw.startsWith(home)) texts.add(`~${raw.slice(home.length)}`);
  return texts;
}

/**
 * Recolor only the header: the `toolTitle` token and the `accent` used for the
 * header path. Other accents in the output keep their color.
 *
 * Object.create keeps the original theme as prototype, so Theme methods run with
 * the wrapper as `this` and internal `this.fg(...)` calls are recolored too.
 * Theme 1.3.0 stores state in ordinary fields (no `#private`), which the
 * prototype chain resolves.
 */
function withYellowHeader(theme: Theme, args: unknown): Theme {
  const paths = headerPathTexts(args);
  const recolor = <T extends ThemeStyle["fg"]>(color: T, text: string): T | "warning" =>
    color === "toolTitle" || (color === "accent" && paths.has(text)) ? "warning" : color;
  const wrapper: Theme = Object.create(theme);
  Object.defineProperties(wrapper, {
    fg: {
      value: (color: ThemeColor, text: string) => theme.fg.call(wrapper, recolor(color, text), text),
    },
    style: {
      value: (text: string, options: ThemeStyle) =>
        theme.style.call(wrapper, text, { ...options, fg: recolor(options.fg, text) }),
    },
  });
  return wrapper;
}

export default function yellowFileHeaders(pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next) => {
    const original = next();
    if ((toolName !== "edit" && toolName !== "write") || !original) return original;

    const renderers: ToolRenderers = { ...original };
    if (original.renderCall) {
      const renderCall = original.renderCall;
      renderers.renderCall = (args, theme, context) =>
        renderCall(args, withYellowHeader(theme, args), context);
    }
    if (original.renderResult) {
      const renderResult = original.renderResult;
      // Native edit results rebuild their call header after settling. Apply
      // the same presentation there without replacing executable tools.
      renderers.renderResult = (result, options, theme, context) =>
        renderResult(result, options, withYellowHeader(theme, context.args), context);
    }
    return renderers;
  });
}
