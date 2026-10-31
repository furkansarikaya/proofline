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
 * Thrown when a moved command meets an input whose shell behaviour (an arithmetic or `awk` error text, a shell-specific message) is
 * not reproduced byte for byte. Nothing has been written yet: the caller runs the shell code for the same arguments instead.
 */
export class BridgeToShell extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = 'BridgeToShell';
    this.reason = reason;
  }
}

/** Shell `fail "text"`: exit status 1 and the text on stderr. @param {string} message @returns {never} */
export function fail(message) {
  throw new ProoflineError(message, 1);
}
