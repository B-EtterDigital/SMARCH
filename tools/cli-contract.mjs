/**
 * @typedef {object} CliErrorOptions
 * @property {unknown} [cause]
 * @property {number} [exitCode]
 * @property {string} [nextCommand]
 * @property {Record<string, unknown>} [context]
 */

export class CliError extends Error {
  /** @param {string} code @param {string} message @param {CliErrorOptions} [options] */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.nextCommand = options.nextCommand || "Run the command with --help.";
    this.context = options.context || {};
  }
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error @param {CliErrorOptions & { code?: string }} [fallback] @returns {CliError} */
export function asCliError(error, fallback = {}) {
  if (error instanceof CliError) return error;
  return new CliError(fallback.code || "UNEXPECTED_ERROR", errorMessage(error), {
    cause: error instanceof Error ? error : undefined,
    exitCode: fallback.exitCode ?? 1,
    nextCommand: fallback.nextCommand,
    context: fallback.context,
  });
}

/** @param {string} tool @param {unknown} error @param {Record<string, unknown>} [extraContext] @returns {number} */
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

/** @param {readonly string[]} argv @param {number} index @param {string} flag @param {string} nextCommand @returns {string} */
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
