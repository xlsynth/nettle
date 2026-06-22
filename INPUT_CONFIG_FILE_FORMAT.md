<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nettle build input configuration file format

The `nettle build --config PATH` command accepts a UTF-8 YAML mapping containing
build inputs. This file does not configure resource limits. Unknown fields are
rejected. All fields are optional in the file, but the merged YAML and
command-line configuration must provide both `filelist` and `output`.

## Schema

| Field             | YAML type                           | Meaning                                                                        |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `filelist`        | string (path)                       | Slang-compatible root `.f` filelist.                                           |
| `output`          | string (path)                       | Destination `.nettle` file.                                                    |
| `top`             | string                              | Explicit top module.                                                           |
| `project_root`    | string (path)                       | Boundary containing the filelist and all sources embedded in the bundle.       |
| `parameters`      | mapping of string to string         | Top-level parameter overrides as raw, single-line SystemVerilog expressions.   |
| `defines`         | mapping of string to string or null | Preprocessor macros. A null value defines a macro without a value.             |
| `undefines`       | sequence of strings                 | Preprocessor macro names to undefine.                                          |
| `slang_bin`       | string (path)                       | Standalone Slang executable; otherwise it is discovered in `PATH`.             |
| `yosys_bin`       | string (path)                       | Yosys executable with yosys-slang; otherwise it is discovered in `PATH`.       |
| `debug_artifacts` | boolean                             | Include raw compiler JSON and transcripts under `debug/`. Defaults to `false`. |

All paths in the YAML file are resolved relative to the directory containing
the configuration file. Paths supplied on the command line are resolved
relative to the current working directory.

## Example

```yaml
filelist: filelists/project.f
output: output/design.nettle
top: top
project_root: .
parameters:
  DEPTH: "32"
  WIDTH: "16"
defines:
  NUM_HARTS: "4"
  SYNTHESIS: null
undefines:
  - SIMULATION
slang_bin: tools/slang
yosys_bin: tools/yosys
debug_artifacts: false
```

Quote parameter expressions and macro values so YAML decodes them as strings.
Parameter and macro names must be valid SystemVerilog identifiers. Values must
be nonempty, single-line strings; duplicate names and define/undefine conflicts
are rejected during validation.

## Command-line merging

Scalar command-line options override their YAML counterparts. The `parameters`,
`defines`, and `undefines` collections are appended to the YAML collections and
then validated together. `--debug-artifacts` enables debug artifacts regardless
of the YAML value; there is no command-line flag that forces an enabled YAML
value off.

The same configuration fields are accepted by `nettle render`, which embeds
the build arguments before starting the viewer.
