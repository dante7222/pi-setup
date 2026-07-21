interface ShellWord {
  kind: "word";
  value: string;
}

interface ShellOperator {
  kind: "operator";
  value: string;
}

type ShellToken = ShellWord | ShellOperator;

const COMMAND_SEPARATORS = new Set(["\n", ";", ";;", ";&", ";;&", "&", "&&", "|", "|&", "||", "(", ")"]);
const REDIRECTIONS = new Set(["<", ">", "<<", ">>", "<<<", "<>", "<&", ">&"]);
const CONTROL_PREFIXES = new Set(["!", "if", "then", "elif", "else", "while", "until", "do"]);
const SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const SIMPLE_WRAPPERS = new Set(["builtin", "command", "exec", "nohup", "time"]);
const SUDO_OPTIONS_WITH_VALUES = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u"]);
const XARGS_OPTIONS_WITH_VALUES = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]);

function commandName(word: string): string {
  return word.split("/").at(-1) ?? word;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function closingCommandSubstitution(command: string, start: number): number | undefined {
  let depth = 1;
  let quote: "single" | "double" | undefined;

  for (let index = start; index < command.length; index++) {
    const character = command[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "(") depth++;
    if (character !== ")") continue;
    depth--;
    if (depth === 0) return index;
  }

  return undefined;
}

function tokenize(command: string): { tokens: ShellToken[]; substitutions: string[] } {
  const tokens: ShellToken[] = [];
  const substitutions: string[] = [];
  let word = "";
  let hasWord = false;

  const flushWord = (): void => {
    if (!hasWord) return;
    tokens.push({ kind: "word", value: word });
    word = "";
    hasWord = false;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (/[^\S\r\n]/.test(character)) {
      flushWord();
      continue;
    }
    if (character === "\r" || character === "\n") {
      flushWord();
      if (character === "\r" && command[index + 1] === "\n") index++;
      tokens.push({ kind: "operator", value: "\n" });
      continue;
    }
    if (character === "#" && !hasWord) {
      while (index + 1 < command.length && !/[\r\n]/.test(command[index + 1])) index++;
      continue;
    }
    if (character === "\\") {
      hasWord = true;
      if (index + 1 < command.length) word += command[++index];
      continue;
    }
    if (character === "'") {
      hasWord = true;
      while (++index < command.length && command[index] !== "'") word += command[index];
      continue;
    }
    if (character === '"') {
      hasWord = true;
      while (++index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) {
          word += command[++index];
          continue;
        }
        if (command[index] === "$" && command[index + 1] === "(") {
          const end = closingCommandSubstitution(command, index + 2);
          if (end !== undefined) {
            substitutions.push(command.slice(index + 2, end));
            word += command.slice(index, end + 1);
            index = end;
            continue;
          }
        }
        if (command[index] === "`") {
          const end = command.indexOf("`", index + 1);
          if (end !== -1) {
            substitutions.push(command.slice(index + 1, end));
            word += command.slice(index, end + 1);
            index = end;
            continue;
          }
        }
        word += command[index];
      }
      continue;
    }
    if (character === "`") {
      hasWord = true;
      const end = command.indexOf("`", index + 1);
      if (end !== -1) {
        substitutions.push(command.slice(index + 1, end));
        word += command.slice(index, end + 1);
        index = end;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      hasWord = true;
      const end = closingCommandSubstitution(command, index + 2);
      if (end !== undefined) {
        substitutions.push(command.slice(index + 2, end));
        word += command.slice(index, end + 1);
        index = end;
        continue;
      }
    }

    if (";&|()<>".includes(character)) {
      flushWord();
      const threeCharacters = command.slice(index, index + 3);
      const twoCharacters = command.slice(index, index + 2);
      if (threeCharacters === ";;&" || threeCharacters === "<<<") {
        tokens.push({ kind: "operator", value: threeCharacters });
        index += 2;
      } else if (["&&", "||", "|&", ";;", ";&", "<<", ">>", "<>", "<&", ">&"].includes(twoCharacters)) {
        tokens.push({ kind: "operator", value: twoCharacters });
        index++;
      } else {
        tokens.push({ kind: "operator", value: character });
      }
      continue;
    }

    hasWord = true;
    word += character;
  }

  flushWord();
  return { tokens, substitutions };
}

function firstNonOption(words: string[], start: number): number | undefined {
  for (let index = start; index < words.length; index++) {
    if (words[index] === "--") return index + 1 < words.length ? index + 1 : undefined;
    if (!words[index].startsWith("-") || words[index] === "-") return index;
  }
  return undefined;
}

function executableIsGrep(words: string[], executableIndex: number, depth = 0): boolean {
  if (depth > 8 || executableIndex >= words.length) return false;

  const executable = commandName(words[executableIndex]);
  if (executable === "grep") return true;

  if (SHELLS.has(executable)) {
    for (let index = executableIndex + 1; index < words.length - 1; index++) {
      if (/^-[^-]*c/.test(words[index])) return invokesGrep(words[index + 1]);
    }
    return false;
  }

  if (SIMPLE_WRAPPERS.has(executable)) {
    const wrappedIndex = firstNonOption(words, executableIndex + 1);
    return wrappedIndex === undefined ? false : executableIsGrep(words, wrappedIndex, depth + 1);
  }

  if (executable === "env") {
    let index = executableIndex + 1;
    while (index < words.length) {
      if (words[index] === "--") {
        index++;
        break;
      }
      if (words[index] === "-u" || words[index] === "--unset" || words[index] === "-C" || words[index] === "--chdir") {
        index += 2;
        continue;
      }
      if (words[index].startsWith("-") || isAssignment(words[index])) {
        index++;
        continue;
      }
      break;
    }
    return executableIsGrep(words, index, depth + 1);
  }

  if (executable === "sudo") {
    let index = executableIndex + 1;
    while (index < words.length && words[index].startsWith("-")) {
      if (words[index] === "--") {
        index++;
        break;
      }
      index += SUDO_OPTIONS_WITH_VALUES.has(words[index]) ? 2 : 1;
    }
    return executableIsGrep(words, index, depth + 1);
  }

  if (executable === "xargs") {
    let index = executableIndex + 1;
    while (index < words.length && words[index].startsWith("-")) {
      if (words[index] === "--") {
        index++;
        break;
      }
      index += XARGS_OPTIONS_WITH_VALUES.has(words[index]) ? 2 : 1;
    }
    return executableIsGrep(words, index, depth + 1);
  }

  if (executable === "nice") {
    let index = executableIndex + 1;
    if (words[index] === "-n" || words[index] === "--adjustment") index += 2;
    else if (/^-\d+$/.test(words[index] ?? "")) index++;
    return executableIsGrep(words, index, depth + 1);
  }

  if (executable === "timeout") {
    const durationIndex = firstNonOption(words, executableIndex + 1);
    return durationIndex === undefined ? false : executableIsGrep(words, durationIndex + 1, depth + 1);
  }

  if (executable === "stdbuf") {
    const wrappedIndex = firstNonOption(words, executableIndex + 1);
    return wrappedIndex === undefined ? false : executableIsGrep(words, wrappedIndex, depth + 1);
  }

  if (executable === "busybox" && commandName(words[executableIndex + 1] ?? "") === "grep") return true;
  if (executable === "git" && words[executableIndex + 1] === "grep") return true;

  if (executable === "find") {
    for (let index = executableIndex + 1; index < words.length - 1; index++) {
      if (["-exec", "-execdir", "-ok", "-okdir"].includes(words[index])) {
        if (executableIsGrep(words, index + 1, depth + 1)) return true;
      }
    }
  }

  return false;
}

function segmentInvokesGrep(words: string[]): boolean {
  let index = 0;
  while (index < words.length && (CONTROL_PREFIXES.has(words[index]) || isAssignment(words[index]))) index++;
  return executableIsGrep(words, index);
}

export function invokesGrep(command: string): boolean {
  const { tokens, substitutions } = tokenize(command);
  if (substitutions.some((substitution) => invokesGrep(substitution))) return true;

  let words: string[] = [];
  let skipRedirectionTarget = false;
  const flushSegment = (): boolean => {
    const blocked = segmentInvokesGrep(words);
    words = [];
    skipRedirectionTarget = false;
    return blocked;
  };

  for (const token of tokens) {
    if (token.kind === "operator") {
      if (REDIRECTIONS.has(token.value)) {
        if (/^\d+$/.test(words.at(-1) ?? "")) words.pop();
        skipRedirectionTarget = true;
        continue;
      }
      if (COMMAND_SEPARATORS.has(token.value) && flushSegment()) return true;
      continue;
    }
    if (skipRedirectionTarget) {
      skipRedirectionTarget = false;
      continue;
    }
    words.push(token.value);
  }

  return flushSegment();
}
