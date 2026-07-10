<!-- SPDX-License-Identifier: Apache-2.0 -->

# Structural schematic diff fixture

This Nettle-owned fixture provides two independently compiled RTL projects for
the browser comparison regression. Both projects elaborate `top` with the same
`WIDTH`, while the candidate deliberately changes several schematic concerns:

| Concern          | Reference                        | Candidate                                               |
| ---------------- | -------------------------------- | ------------------------------------------------------- |
| Top ports        | `legacy_o`                       | adds `enable_i` and replaces `legacy_o` with `status_o` |
| Shared instance  | `u_keep (diff_child)`            | unchanged                                               |
| One-sided module | `u_removed (legacy_child)`       | `u_added (new_child)` with another port signature       |
| Structure        | mux plus reduction-and           | xor, mux, logical-and, and reduction-or                 |
| Connectivity     | output selects two child results | added child feeds a combined and gated output path      |

The Docker integration target builds both bundles with Slang and yosys-slang,
opens them in browser comparison mode, and checks semantic statuses plus
non-overlapping, endpoint-connected SVG geometry under conservative and
aggressive matching. It intentionally avoids screenshot or exact-coordinate
goldens so harmless ELK placement changes do not break CI.
