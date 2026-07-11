export class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.nextCommand = options.nextCommand || "Run the command with --help.";
    this.context = options.context || {};
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function asCliError(error, fallback = {}) {
  if (error instanceof CliError) return error;
  return new CliError(fallback.code || "UNEXPECTED_ERROR", errorMessage(error), {
    cause: error instanceof Error ? error : undefined,
    exitCode: fallback.exitCode ?? 1,
    nextCommand: fallback.nextCommand,
    context: fallback.context,
  });
}

export function emitFailure(tool, error, extraContext = {}) {
  const failure = asCliError(error);
  process.stderr.write(`${JSON.stringify({
    area: `cli:${tool}`,
    severity: failure.exitCode === 2 ? "warning" : "error",
    tool,
    code: failure.code,
    message: failure.message,
    next_command: failure.nextCommand,
    context: { ...failure.context, ...extraContext },
  })}\n`);
  return failure.exitCode;
}

export function requireValue(argv, index, flag, nextCommand) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError("USAGE_ERROR", `${flag} requires a value.`, {
      exitCode: 2,
      nextCommand,
      context: { flag },
    });
  }
  return value;
}
