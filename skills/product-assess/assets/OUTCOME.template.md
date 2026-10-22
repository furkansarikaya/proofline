# Outcome: <product>

<!-- Run the script, save its output to outcome/OC-1.out, record both hashes (sha256sum or shasum -a 256). -->

- OC-1 <what was measured and when>, follows DEC-1 and FR-1.
  metric: M-1
  baseline: <value before>
  target: >= <number>
  script: <path from the project root> sha256:<64 hex>
  output: outcome/OC-1.out sha256:<64 hex>
  value: <number from the output>
  result: <reached|not-reached|inconclusive>
  follow-up: <continue|change|drop>
