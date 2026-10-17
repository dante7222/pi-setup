import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

/**
 * Supply a deadline without replacing the shell tools, their settings,
 * rendering, or prompt. Pi's built-in `powershell` tool shares Bash's input
 * schema (`PowerShellToolInput = BashToolInput`), so it gets the same default.
 */
export default function bashTimeout(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (
      (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) &&
      event.input.timeout === undefined
    ) {
      // Mutating input is a supported Pi API. Keep explicit values (including
      // invalid ones) for the backend to honor or reject, rather than guessing.
      event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
    }
  });
}
