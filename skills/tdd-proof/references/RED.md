# RED: failing for the right reason

## 1. What counts

RED is valid only when the runner output shows the test body executed and an assertion about the new behaviour failed (expected value vs actual value, a thrown-vs-not-thrown expectation, a missing call on a mock). Everything that prevents the assertion from being evaluated is not RED:

| Class | Meaning | Not RED because |
|---|---|---|
| `syntax` | the file does not parse | no code ran |
| `compile` | type/compile/build error | no code ran |
| `import` | module or package not found/resolvable | the test never loaded |
| `missing_file` | a file, fixture or path does not exist | the precondition is broken |
| `no_tests` | runner found/ran zero tests (wrong filter, wrong path) | nothing was tested |
| `setup_crash` | an exception in setUp/beforeEach/fixture | the test body never ran |
| `timeout` | the test or runner timed out | nothing was asserted |
| `crash` | runtime exception unrelated to an assertion (TypeError, NullReference, panic) | the code under test blew up before any expectation; usually a missing stub |
| `unknown` | output matches no known pattern | cannot prove the reason; read the output by hand |
| `assertion` | an assertion failed | this is RED |

`scripts/classify-red.mjs` applies the patterns below to the runner output (stdin or `--file`) and prints `{class, evidence}`; exit 0 only for `assertion`. When several classes match the precedence is syntax, compile, import, missing_file, no_tests, setup_crash, timeout, assertion, crash. A non-assertion signal anywhere in the output wins, because it means part of the suite never ran: re-run just the one test so the output is clean.

How to tell, per ecosystem (examples of the runner output signatures):

| Ecosystem | Not RED | RED |
|---|---|---|
| Node (`node --test`, jest, vitest, mocha) | `SyntaxError`, `Cannot find module`, `ERR_MODULE_NOT_FOUND`, `Failed to resolve import`, `error TS2304` / `TS2339`, `Test suite failed to run`, `ReferenceError`/`TypeError: x is not a function` | `AssertionError [ERR_ASSERTION]`, `expect(received).toBe(expected)`, `Expected:` / `Received:` |
| Python (pytest, unittest) | `ModuleNotFoundError`, `ImportError`, `SyntaxError`, `IndentationError`, `ERROR at setup of`, `fixture '...' not found`, `collected 0 items`, `NameError`, `AttributeError` | `AssertionError`, lines starting `E   assert` |
| Go | `[build failed]`, `undefined:`, `cannot use ... as ... value`, `syntax error:`, `no test files`, `panic: runtime error` | `--- FAIL: TestX` followed by a `_test.go:NN:` message (got/want) |
| Rust (cargo test) | `error[E0432]`, `error[E0425]`, `could not compile`, `unresolved import` | `assertion `left == right` failed`, `panicked at ... assertion` |
| .NET (dotnet test) | `error CS1061`, `error CS0246`, `Build FAILED`, `Test Run Aborted`, `No test is available` | `Assert.Equal() Failure`, `Assert.True() Failure`, `Expected: ... Actual: ...` |
| Java/Kotlin (JUnit, Maven, Gradle) | `COMPILATION ERROR`, `cannot find symbol`, `Compilation failed`, `NoClassDefFoundError`, `NullPointerException` | `AssertionFailedError`, `ComparisonFailure`, `AssertionError` |
| Ruby (rspec, minitest) | `SyntaxError`, `LoadError`, `cannot load such file`, `NameError`, `NoMethodError` | `expected: ... got: ...`, `Expected: ... Actual: ...` |
| PHP (phpunit) | `Parse error`, `Class "X" not found`, `Error:` | `Failed asserting that` |
| Shell/other | script error, `command not found`, exit 127 | the script's own explicit `FAIL`/expected-vs-actual message that you wrote; read it by hand |

Exit code alone is never evidence: most non-RED failures also exit non-zero.

## 2. Run one test

Prove the narrowest command that runs exactly the new test and reports its name in the output, before writing production code. Source of the command: plan `## Verification commands`, CI config, the project's test runner conventions. Check the output names the test and the count of tests run is at least 1. A filter that matches nothing is `no_tests`, not RED. Capture the output to a file; the excerpt recorded in `tdd.json` is copied from it (the assertion lines, at most 20 lines).

## 3. Stub first

When the test cannot compile or import because the unit does not exist: create the smallest stub inside scope (right signature/export, returns a neutral value such as null, 0, empty, or throws a not-implemented error only when the language needs a body that cannot return). Re-run. Expected: class `assertion` (the stub's neutral value differs from the expected). If the stub's value happens to satisfy the assertion, the test cannot fail: strengthen it so a wrong value is detectable (a second input, a distinguishing expected value), then re-run. A `not-implemented` throw that surfaces as an exception is `crash`, not RED: return a neutral value instead.

## 4. expected_failure text

One specific sentence: which behaviour, which actual value vs expected value. Valid: `parseDuration("90s") returns 0 instead of 90000`. Invalid (rejected by the recorder and the validator): `test fails`, `not implemented`, `fails as expected`, `assertion failed`, anything under 20 characters.

## 5. Validation rules

`validate-tdd.mjs` enforces per cycle: scope path relative; one cycle per (path, criterion), no duplicates; `red.exit_code` non-zero; `red.failure_class` is `assertion` and `classify(red.output_excerpt)` is also `assertion`; `red.expected_failure` specific; `red.command` equals `green.command`; `green.exit_code` 0 and `green.suite_exit_code` 0; the hollow check has a method (`revert|mutate`), an absolute worktree path, a non-zero exit code, `failed_for_expected_reason: true`, and an excerpt that classifies as `assertion`; `refactor`, when present, has exit code 0; exemptions have a reason of at least 20 characters that is not a stock phrase; with `--scope`, every scope path has a cycle or an exemption, no cycle targets a path outside the list, and with `path:AC-1+AC-2` every listed criterion has its own cycle at that path.
