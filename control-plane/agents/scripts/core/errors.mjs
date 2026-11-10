// @ts-check
// Errors of the core. A ProoflineError carries the message text exactly as agent.sh printed it (`fail` writes it to stderr plus a
// newline) and the exit code the shell had. Handlers never call process.exit; they return a code or throw.

export class ProoflineError extends Error {
  /**
   * @param {string} message the text agent.sh prints on stderr (without the newline)
   * @param {number} [exitCode] the exit status of the shell for this failure (`fail` returns 1)
   * @param {string} [code] a stable machine-readable code
   */
  constructor(message, exitCode = 1, code = 'FAIL') {
    super(message);
    this.name = 'ProoflineError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

/**
 * An input the Node implementation does not handle (A210: there is no fallback to the shell code any more): exit status 1 and a message that
 * names the reason. `usage` stands for a missing or empty mandatory argument.
 * @param {string} reason @returns {ProoflineError}
 */
export function unsupported(reason) {
  if (reason === 'usage') return new ProoflineError('proofline: a mandatory argument is missing or empty (see: proofline help)', 1, 'USAGE');
  return new ProoflineError(`proofline: input not supported (${reason})`, 1, 'UNSUPPORTED_INPUT');
}

/** Shell `fail "text"`: exit status 1 and the text on stderr. @param {string} message @returns {never} */
export function fail(message) {
  throw new ProoflineError(message, 1);
}
