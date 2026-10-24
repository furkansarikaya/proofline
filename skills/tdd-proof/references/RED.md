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

`scripts/classify-red.mjs` applies the patterns below to the runner output (stdin or `--file`) and prints `{class, evidence, red_valid}`; exit 0 only for `assertion`. When several classes match the precedence is syntax, compile, import, missing_file, no_tests, setup_crash, timeout, assertion, crash. A non-assertion signal anywhere in the output wins, because it means part of the suite never ran: re-run just the one test so the output is clean.

The patterns of `compile`, `no_tests` and `assertion` are not in the script. They are the `test_output` section of the ecosystem definition (`references/ecosystems.json`, a byte-identical copy of `control-plane/agents/ecosystems.json`, A173), one list per ecosystem, so a runner is added by adding an entry there. Every entry names its `runner` and its evidence: `source: captured` (`evidence` is the id of a recorded real run in `tests/skills/fixtures/tdd-proof-output/`, with the tool, version, command and exit code in its header) or `source: docs` (the tool was not installed where the patterns were collected; `evidence` is the URL of the tool's own documentation or source that contains the text or the exit code). Nothing was filled in by guess: a pattern or an exit code that neither a run nor a document backs is absent (see "Not covered" below). An entry may carry `unless`: a pattern that cancels it when the output also shows that a test ran, so `[no test files]` of one package, `[no tests to run]` of the packages a `-run` filter skipped, a second test project of a solution or a `running 0 tests` of one cargo target never hide the failing assertion of another (an `unless` that matches means "something ran", not "nothing ran").

`--exit-code N` and `--ecosystem ID` are optional. The exit code is a cross-check and never evidence of RED: exit 0 turns an assertion message into `unknown` (a passing run is not RED), and with `--ecosystem` an output that matches nothing is classified `no_tests` or `compile` when N is listed in the definition for exactly that class of the ecosystem and for no other (pytest and unittest 5, Microsoft.Testing.Platform 8, dart test 79). An exit code never produces `assertion`.

How to tell, per ecosystem (examples of the runner output signatures; the evidence table below says which are captured and which are from documentation):

| Ecosystem | Not RED | RED |
|---|---|---|
| Node (`node --test`, bun test, vitest, jest, mocha, tsc) | `SyntaxError`, `Cannot find module`, `ERR_MODULE_NOT_FOUND`, `Failed to resolve import`, `error TS2304` / `TS2339`, `[PARSE_ERROR]` / `Transform failed with 1 error` (vitest), `# Unhandled error between tests` (bun), `Test suite failed to run`, `ℹ tests 0` / `# tests 0`, `No test files found`, `No tests found, exiting with code 1`, `Could not find '<path>'` (node), `The following filters did not match any test files` (bun), `ReferenceError`/`TypeError: x is not a function` | `AssertionError [ERR_ASSERTION]`, `AssertionError: expected 4 to be 5` (vitest), `expect(received).toBe(expected)` with `Expected:` / `Received:` (bun, jest) |
| Python (pytest, unittest) | `ModuleNotFoundError`, `ImportError: Failed to import test module`, `SyntaxError`, `IndentationError`, `ERROR at setup of`, `fixture '...' not found`, `collected 0 items`, `no tests ran`, `NO TESTS RAN` with `Ran 0 tests` (unittest), `unittest.loader._FailedTest` (a named test that does not exist), `NameError`, `AttributeError` | `AssertionError: 4 != 5`, lines starting `E   assert` |
| Go | `[build failed]` (compile, type, vet and syntax errors), `[setup failed]`, `undefined:`, `cannot use ... as ... value`, `syntax error:`, `[no test files]`, `[no tests to run]`, `testing: warning: no tests to run`, `panic: runtime error` | `--- FAIL: TestX` followed by a `_test.go:NN:` message (got/want) |
| Rust (cargo test) | `error[E0432]`, `error[E0425]`, `could not compile`, `unresolved import`, `running 0 tests` in every target | `assertion `left == right` failed`, `assertion failed: <expr>` |
| .NET VSTest (`dotnet test` with Microsoft.NET.Test.Sdk) | `error CS1061`, `error CS0246`, `error FS0039`, `error BC30451`, `error MSB1003`, `error NU1101`, `Build FAILED`, `Test Run Aborted`, `No test is available in <dll>` and `No test matches the given testcase filter` (both exit 0) | xUnit `Assert.Equal() Failure: Values differ` / `Assert.True() Failure`; NUnit `Assert.That(2 + 2, Is.EqualTo(5))` followed by `Expected: 5` and `But was:  4`; MSTest 4 `Assertion failed. Expected values to be equal.`, MSTest 3 `Assert.AreEqual failed. Expected:<5>. Actual:<4>.` |
| .NET Microsoft.Testing.Platform (`global.json` `test.runner`, xUnit v3, NUnit with `EnableNUnitRunner`, MSTest with `EnableMSTestRunner`) | `Zero tests ran` with `Exit code: 8` (no test, or a filter that matched none), `Build failed with exit code: 1`, `error CS...`, `Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later` (an MTP project without the opt-in), a host crash prints `Zero tests ran` with another `Exit code:` and is `unknown` | the same assertion messages as above, then `failed with N error(s)` and `Exit code: 2` |
| Java/Kotlin (JUnit, Maven, Gradle) | `COMPILATION ERROR`, `cannot find symbol`, `Compilation failed; see the compiler`, `No tests to run.`, `No tests were executed!`, `No tests found for given includes`, `NoClassDefFoundError`, `NullPointerException` | `AssertionFailedError`, `ComparisonFailure`, `AssertionError` |
| Ruby (rspec, minitest, test-unit) | `SyntaxError`, `LoadError`, `cannot load such file`, `0 runs, 0 assertions`, `Nothing ran for filter`, `0 examples, 0 failures`, `NameError`, `NoMethodError` | minitest `Expected: 5` / `Actual: 4`, rspec `expected: 200` / `got: 404`, test-unit `<5> expected but was` / `<4>` |
| PHP (phpunit) | `Parse error: syntax error`, `Class "X" not found`, `No tests executed!`, `Error:` | `Failed asserting that` |
| Swift (swift test: XCTest and Swift Testing) | `error: cannot find 'x' in scope`, `<file>.swift:L:C: error:`, `error: Build failed`, `Executed 0 tests` together with `Test run with 0 tests`, `No matching test cases were run` | `XCTAssertEqual failed: ("4") is not equal to ("5")`, `Expectation failed: plus(2, 2) == 5` |
| Dart/Flutter (dart test, flutter test) | `Failed to load "test/x_test.dart"`, `No tests were found.`, `No tests match`, `Test directory "test" not found`, `does not appear to contain any test files` | `Expected: <5>` followed by `Actual: <4>` |
| Shell/other | script error, `command not found`, exit 127 | the script's own explicit `FAIL`/expected-vs-actual message that you wrote; read it by hand |

Exit code alone is never evidence: most non-RED failures also exit non-zero. Exit codes differ per tool, and a missing test is not always an error: the same "nothing ran" is exit 0 for `go test`, node:test, bun 1.2.8, `dotnet test` with VSTest (also when `--filter` matches nothing), Minitest without a filter and `swift test`; exit 1 for vitest, jest and Minitest `-n`; exit 5 for pytest and unittest; exit 8 for Microsoft.Testing.Platform; exit 79 for `dart test`. A failing assertion is exit 1 almost everywhere and exit 2 for Microsoft.Testing.Platform, 101 for cargo.

### Evidence behind the patterns

Collected on 2026-10-25 (macOS arm64). `captured` is a real run of the command, kept with its exit code as a fixture; `docs` is the tool's documentation or source (the tool was not installed). Exit codes in brackets.

| Ecosystem | Runner and version | Source | no_tests | compile | assertion |
|---|---|---|---|---|---|
| Node | node:test (Node.js 24.14.1) | captured | `ℹ tests 0`, `# tests 0` with `--test-reporter=tap` [0]; `Could not find '<path>'` [1] | `SyntaxError` is the syntax class | `AssertionError [ERR_ASSERTION]` [1] |
| Node | bun test 1.2.8 | captured | `The following filters did not match any test files` [0] | `# Unhandled error between tests` [1] | `expect(received).toBe(expected)`, `Expected:` / `Received:` [1] |
| Node | vitest 5.0.1 | captured | `No test files found, exiting with code 1` [1] | `[PARSE_ERROR]`, `Transform failed with 1 error` [1] | `AssertionError: expected 4 to be 5` [1] |
| Node | tsc 5.9.3 | captured | | `error TS2322` [2] | |
| Node | jest | docs | `No tests found, exiting with code 1` [1] | | `expect(received).toBe(expected)` |
| Node | mocha | docs | `No test files found` | | |
| Python | unittest (Python 3.12.3) | captured | `Ran 0 tests` / `NO TESTS RAN` [5] | `SyntaxError`, `IndentationError` | `AssertionError: 4 != 5` [1] |
| Python | pytest | docs | `collected 0 items`, `no tests ran` [5] | | `E   assert 4 == 5` [1] |
| Go | go 1.27.1 | captured | `[no test files]`, `[no tests to run]`, `testing: warning: no tests to run` [0] | `[build failed]`, `[setup failed]`, `undefined:`, `cannot use ... as ... value` [1] | `--- FAIL` and `_test.go:7:` [1] |
| Java/Kotlin | Maven surefire, Gradle, JUnit 4 and 5 | docs | `No tests to run.`, `No tests were executed!`, `No tests found for given includes` | `COMPILATION ERROR`, `cannot find symbol`, `Compilation failed; see the compiler` | `AssertionFailedError`, `ComparisonFailure` |
| Rust | cargo test | docs | `running 0 tests` [0] | `error[E0277]`, `could not compile` [101] | ``assertion `left == right` failed``, `assertion failed: ` [101] |
| .NET | .NET SDK 10.0.402: xunit.v3 3.2.2, xunit 2.9.3, NUnit 5.0.0, MSTest 3.11.1 and 4.5.1, VSTest (Microsoft.NET.Test.Sdk 18.11.0) | captured | `No test is available in`, `No test matches the given testcase filter` [0] | `error CS0103`, `error FS0039`, `error BC30451`, `error MSB1003`, `error NU1101`, `Build FAILED`, `Test Run Aborted` [1] | `Assert.Equal() Failure`, NUnit `Expected:` / `But was:`, MSTest `Assertion failed. Expected` and `Assert.AreEqual failed.` [1] |
| .NET | .NET SDK 10.0.402: xunit.v3 4.0.2 (its Microsoft.Testing.Platform package), NUnit 5.0.0, MSTest 3.11.1 and 4.5.1 on Microsoft.Testing.Platform 1.x and 2.x | captured | `Zero tests ran`, `Exit code: 8` [8] | `Build failed with exit code: 1` [1]; `Testing with VSTest target is no longer supported` [1] | the assertion messages above and `Exit code: 2` [2] |
| .NET | Microsoft.Testing.Platform exit codes | docs | 8: zero tests ran (or all skipped under the strict zero-tests policy) | | 2: at least one test failed; 3 aborted; 7 host crashed; 9 fewer tests than `--minimum-expected-tests` (none of these three is mapped) |
| PHP | PHPUnit | docs | `No tests executed!` [0] | `Parse error: syntax error` | `Failed asserting that` [1] |
| Ruby | minitest 6.0.0, test-unit 3.7.5 (Ruby 4.0.7) | captured | `0 runs, 0 assertions` [0]; `Nothing ran for filter` [1]; test-unit prints nothing at all [0] (unknown) | `SyntaxError` [1] | `Expected: 5` / `Actual: 4`, `<5> expected but was` [1] |
| Ruby | RSpec | docs | `0 examples, 0 failures` [0] | | `expected: 200` / `got: 404` [1] |
| Swift | swift test, Apple Swift 6.4 (XCTest and Swift Testing 2084) | captured | `Executed 0 tests` with `Test run with 0 tests`, `No matching test cases were run` [0] | `error: cannot find 'x' in scope`, `.swift:4:37: error:`, `error: Build failed` [1] | `XCTAssertEqual failed`, `Expectation failed:` [1] |
| Dart/Flutter | dart test, flutter test | docs | `No tests were found.`, `No tests match`, `Test directory "test" not found` [79 for dart test] | `Failed to load "<path>"` | `Expected: <5>` / `Actual: <4>` [1 for dart test] |

Things that are easy to get wrong, all seen in the captured runs:

- **A filter that matches nothing is not a failure.** `dotnet test --filter` (VSTest), `go test -run` and `swift test --filter` exit 0 with a "nothing ran" line; unittest and Minitest `-n` exit 1 for a name that does not exist. Under Microsoft.Testing.Platform it is exit 8. Check that the output names your test.
- **Several test targets in one output.** `go test ./...` prints `[no test files]` for packages without tests and `ok ... [no tests to run]` for every package a `-run` filter skipped; cargo prints `running 0 tests` for every target that does not hold the test; a solution prints one result per project; `swift test` prints `Executed 0 tests` for XCTest when only Swift Testing tests exist. These lines do not mean "nothing ran": the `unless` of the entry sees the other results.
- **.NET 10 and the two modes.** On the .NET 10 SDK `dotnet test` runs a Microsoft.Testing.Platform project only after `global.json` has `"test": { "runner": "Microsoft.Testing.Platform" }`; without it the build fails with `Testing with VSTest target is no longer supported by Microsoft.Testing.Platform` (class `compile`, not a test failure). xunit.v3 4.x is such a project; xunit.v3 3.x, xunit 2.x, NUnit and MSTest with their VSTest adapters still run in VSTest mode. A test host that crashes prints `Zero tests ran` and an `Exit code:` other than 8 under Microsoft.Testing.Platform (classified `unknown`) and `Test Run Aborted` under VSTest (classified `compile`); neither is RED.
- **MSTest and NUnit assertion text.** NUnit 5: the failing expression `Assert.That(2 + 2, Is.EqualTo(5))`, then `Expected: 5` and `But was:  4`. MSTest 4: `Assertion failed. Expected values to be equal.` with `expected: 5` and `actual:   4`; MSTest 3: `Assert.AreEqual failed. Expected:<5>. Actual:<4>.` and `Assert.IsTrue failed.`. `Assert.Fail("message")` and an exception thrown inside a test were not captured and are not classified as an assertion.
- **Language.** The .NET SDK localises its messages by the operating system language (observed for `dotnet new`). The fixtures were captured with `DOTNET_CLI_UI_LANGUAGE=en` and `VSLANG=1033`; the patterns are the English texts, so set them when the classifier answers `unknown` on a localised machine.

### Not covered (neither a run nor a document backs it)

Pest has no pattern of its own (it prints PHPUnit's `Failed asserting that`, but this was not checked); PHP's exit code 255 for a parse error, the Maven and Gradle exit codes, the Kotlin compiler's `e:` lines, mocha's assertion text and exit codes, flutter test exit codes, pytest's collection errors (`Interrupted: n errors during collection`) and `dart test` compile exit codes are absent from the definition. A run that shows any of them is `unknown` until a capture or a document is added.



## 2. Run one test

Prove the narrowest command that runs exactly the new test and reports its name in the output, before writing production code. Source of the command: plan `## Verification commands`, CI config, the project's test runner conventions. Check the output names the test and the count of tests run is at least 1. A filter that matches nothing is `no_tests`, not RED. Capture the output to a file; the excerpt recorded in `tdd.json` is copied from it (the assertion lines, at most 20 lines).

## 3. Stub first

When the test cannot compile or import because the unit does not exist: create the smallest stub inside scope (right signature/export, returns a neutral value such as null, 0, empty, or throws a not-implemented error only when the language needs a body that cannot return). Re-run. Expected: class `assertion` (the stub's neutral value differs from the expected). If the stub's value happens to satisfy the assertion, the test cannot fail: strengthen it so a wrong value is detectable (a second input, a distinguishing expected value), then re-run. A `not-implemented` throw that surfaces as an exception is `crash`, not RED: return a neutral value instead.

## 4. expected_failure text

One specific sentence: which behaviour, which actual value vs expected value. Valid: `parseDuration("90s") returns 0 instead of 90000`. Invalid (rejected by the recorder and the validator): `test fails`, `not implemented`, `fails as expected`, `assertion failed`, anything under 20 characters.

## 5. Validation rules

`validate-tdd.mjs` enforces per cycle: scope path relative; one cycle per (path, criterion), no duplicates; `red.exit_code` non-zero; `red.failure_class` is `assertion` and `classify(red.output_excerpt)` is also `assertion`; `red.expected_failure` specific; `red.command` equals `green.command`; `green.exit_code` 0 and `green.suite_exit_code` 0; the hollow check has a method (`revert|mutate`), an absolute worktree path, a non-zero exit code, `failed_for_expected_reason: true`, and an excerpt that classifies as `assertion`; `refactor`, when present, has exit code 0; exemptions have a reason of at least 20 characters that is not a stock phrase; with `--scope`, every scope path has a cycle or an exemption, no cycle targets a path outside the list, and with `path:AC-1+AC-2` every listed criterion has its own cycle at that path.
