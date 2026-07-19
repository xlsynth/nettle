<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generate source-correlation fixture

This Nettle-owned fixture exercises parameterized generate loops, `if` branches
with and without `else`, and active and inactive `case` items. The integration
test target builds it twice with `USE_XOR=1` and `USE_XOR=0`, validates both
bundles, and opens them in Chromium to verify inactive-source styling and
source-to-schematic cross-probing.

Run the real-toolchain build and browser regression from the repository root:

```sh
npm run test:e2e:generate
```
