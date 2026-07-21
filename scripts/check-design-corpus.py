#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Fetch, elaborate, and lower Nettle's pinned third-party design corpora.

This is an opt-in integration regression because it requires the external
Slang and yosys-slang toolchain. The runner clones each upstream repository,
checks out the manifest's exact commit, and stages Nettle-owned test metadata
beside it. It performs both the default elaboration and any representative
top-parameter override recorded in each corpus manifest.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Dict, List, Tuple
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
CORPORA_ROOT = ROOT / "integration_tests"
CORPUS_NAMES = ("bedrock-rtl", "ibex", "opentitan")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--slang-only",
        action="store_true",
        help="skip yosys-slang lowering and validate elaboration only",
    )
    parser.add_argument(
        "--example",
        action="append",
        dest="examples",
        help="validate only this manifest example id (repeatable)",
    )
    parser.add_argument(
        "--corpus",
        action="append",
        choices=CORPUS_NAMES,
        help="validate only this corpus (repeatable)",
    )
    parser.add_argument(
        "--skip-expected",
        action="store_true",
        help="print graph summaries without enforcing manifest expectations",
    )
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="clone and stage selected corpora without running compiler tests",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        help=(
            "stage corpora in this persistent directory instead of a temporary "
            "workspace (required with --prepare-only)"
        ),
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="number of design corpora to validate concurrently (default: 1)",
    )
    return parser.parse_args()


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if path:
        return path
    raise RuntimeError(f"required executable {name!r} was not found on PATH")


def run(command: List[str], *, cwd: Path) -> subprocess.CompletedProcess:
    result = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        rendered = " ".join(command)
        raise RuntimeError(
            f"command failed ({result.returncode}): {rendered}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def parameter_args(parameters: Dict[str, str]) -> List[str]:
    return [part for name, value in parameters.items() for part in ("-G", f"{name}={value}")]


def validate_manifest(corpus: Path, manifest: Dict) -> None:
    """Validate immutable upstream provenance and Nettle-owned metadata."""
    if manifest.get("schemaVersion") != 2:
        raise RuntimeError(f"{corpus.name}: manifest schemaVersion must be 2")

    source = manifest.get("source")
    if not isinstance(source, dict):
        raise RuntimeError(f"{corpus.name}: manifest source metadata is missing")

    repository = source.get("repository")
    commit = source.get("commit")
    if not isinstance(repository, str) or not repository.startswith("https://"):
        raise RuntimeError(
            f"{corpus.name}: source.repository must be an HTTPS Git URL"
        )
    repository_name(repository)
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise RuntimeError(
            f"{corpus.name}: source.commit must be a full lowercase Git SHA"
        )
    if "licenseFile" not in source:
        raise RuntimeError(f"{corpus.name}: source.licenseFile is required")

    for field in ("licenseFile", "noticeFile"):
        relative = source.get(field)
        if relative is None:
            continue
        if not isinstance(relative, str) or not relative:
            raise RuntimeError(
                f"{corpus.name}: source.{field} must name an upstream file"
            )
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(
                f"{corpus.name}: source.{field} must stay within the checkout"
            )

    sparse_paths = source.get("sparsePaths")
    if not isinstance(sparse_paths, list) or not sparse_paths:
        raise RuntimeError(
            f"{corpus.name}: source.sparsePaths must be a non-empty list"
        )
    for relative in sparse_paths:
        if not isinstance(relative, str) or not relative or relative.startswith("-"):
            raise RuntimeError(
                f"{corpus.name}: sparse checkout paths must be non-option strings"
            )
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(
                f"{corpus.name}: sparse checkout paths must stay within the checkout"
            )

    scripts = corpus / "scripts"
    if scripts.exists() and not scripts.is_dir():
        raise RuntimeError(f"{corpus.name}: scripts must be a directory")

    examples = manifest.get("examples")
    if not isinstance(examples, list) or not examples:
        raise RuntimeError(f"{corpus.name}: manifest examples must be a non-empty list")
    for example in examples:
        if not isinstance(example, dict):
            raise RuntimeError(f"{corpus.name}: every example must be an object")
        relative = example.get("filelist")
        if not isinstance(relative, str):
            raise RuntimeError(f"{corpus.name}: every example requires a filelist")
        path = Path(relative)
        if path.parent != Path(".") or path.suffix != ".f":
            raise RuntimeError(
                f"{corpus.name}: example filelists must be root-level .f files"
            )
        if not (corpus / path).is_file():
            raise RuntimeError(f"{corpus.name}: filelist {relative!r} is missing")


def git(command: List[str], *, cwd: Path) -> subprocess.CompletedProcess:
    return run(["git", *command], cwd=cwd)


def repository_name(repository: str) -> str:
    name = Path(urlparse(repository).path).name.removesuffix(".git")
    if not name or re.fullmatch(r"[A-Za-z0-9._-]+", name) is None:
        raise RuntimeError(f"repository URL has no safe checkout name: {repository!r}")
    return name


def verify_checkout(corpus_name: str, checkout: Path, source: Dict) -> None:
    actual_repository = git(["remote", "get-url", "origin"], cwd=checkout).stdout.strip()
    if actual_repository.rstrip("/") != str(source["repository"]).rstrip("/"):
        raise RuntimeError(
            f"{corpus_name}: existing checkout origin is {actual_repository!r}, "
            f"expected {source['repository']!r}"
        )
    actual_commit = git(["rev-parse", "HEAD"], cwd=checkout).stdout.strip()
    if actual_commit != source["commit"]:
        raise RuntimeError(
            f"{corpus_name}: existing checkout is at {actual_commit}, "
            f"expected {source['commit']}; use a fresh workspace"
        )
    dirty = git(["status", "--porcelain", "--untracked-files=all"], cwd=checkout)
    if dirty.stdout:
        raise RuntimeError(
            f"{corpus_name}: existing repository checkout has local modifications"
        )

    for field in ("licenseFile", "noticeFile"):
        relative = source.get(field)
        if relative is not None and not (checkout / relative).is_file():
            raise RuntimeError(
                f"{corpus_name}: declared upstream {field} {relative!r} is missing"
            )
    for relative in source["sparsePaths"]:
        if not (checkout / relative).exists():
            raise RuntimeError(
                f"{corpus_name}: sparse checkout path {relative!r} is missing"
            )


def stage_corpus(corpus: Path, manifest: Dict, workspace: Path) -> Path:
    """Materialize one pinned upstream checkout with Nettle-owned test inputs."""
    staged = workspace / corpus.name
    staged.mkdir(parents=True, exist_ok=True)
    source = manifest["source"]
    checkout = staged / repository_name(str(source["repository"]))

    if checkout.exists():
        if checkout.is_symlink() or not checkout.is_dir():
            raise RuntimeError(f"{corpus.name}: repository checkout is not a directory")
        git(
            ["sparse-checkout", "set", *[str(path) for path in source["sparsePaths"]]],
            cwd=checkout,
        )
        verify_checkout(corpus.name, checkout, source)
    else:
        git(
            [
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                "--depth=1",
                "--sparse",
                str(source["repository"]),
                str(checkout),
            ],
            cwd=workspace,
        )
        git(
            ["sparse-checkout", "set", *[str(path) for path in source["sparsePaths"]]],
            cwd=checkout,
        )
        git(["fetch", "--depth=1", "origin", str(source["commit"])], cwd=checkout)
        git(["checkout", "--detach", str(source["commit"])], cwd=checkout)
        verify_checkout(corpus.name, checkout, source)

    generated = staged / "generated"
    if generated.exists() and (generated.is_symlink() or not generated.is_dir()):
        raise RuntimeError(f"{corpus.name}: generated output path is not a directory")
    for entry in staged.iterdir():
        if entry in (checkout, generated):
            continue
        if entry.is_symlink() or entry.is_file():
            entry.unlink()
        else:
            shutil.rmtree(entry)

    for filelist in corpus.glob("*.f"):
        shutil.copy2(filelist, staged / filelist.name)
    scripts = corpus / "scripts"
    if scripts.is_dir():
        shutil.copytree(scripts, staged / "scripts")
    shutil.copy2(corpus / "manifest.json", staged / "manifest.json")
    generated.mkdir(exist_ok=True)
    return staged


def validate_slang(
    slang: str,
    filelist: Path,
    top: str,
    parameters: Dict[str, str],
    diagnostics: Path,
) -> None:
    run(
        [
            slang,
            "--std",
            "1800-2017",
            "--single-unit",
            "-F",
            str(filelist),
            "--top",
            top,
            *parameter_args(parameters),
            "--diag-json",
            str(diagnostics),
            "--quiet",
        ],
        cwd=ROOT,
    )
    reported = json.loads(diagnostics.read_text(encoding="utf-8"))
    if reported:
        raise RuntimeError(
            f"Slang reported diagnostics for {top}:\n{json.dumps(reported, indent=2)}"
        )


def validate_yosys(
    yosys: str,
    filelist: Path,
    top: str,
    parameters: Dict[str, str],
    script: Path,
    output: Path,
) -> Tuple[int, int, Dict[str, object]]:
    overrides = " ".join(
        f"-G {name}={value}" for name, value in parameters.items()
    )
    script.write_text(
        "\n".join(
            [
                f"read_slang --best-effort-hierarchy --no-synthesis-define {overrides} -F {filelist}",
                f"hierarchy -top {top}",
                "proc -noopt",
                f'write_json "{output}"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    run([yosys, "-Q", "-m", "slang", "-s", str(script)], cwd=ROOT)
    netlist = json.loads(output.read_text(encoding="utf-8"))
    modules = netlist.get("modules", {})
    if top not in modules:
        raise RuntimeError(f"Yosys JSON for {top} does not contain its top module")
    cells = sum(len(module.get("cells", {})) for module in modules.values())
    imported = run(
        [
            "cargo",
            "run",
            "--quiet",
            "--bin",
            "nettle-import-summary",
            "--",
            str(output),
            top,
        ],
        cwd=ROOT,
    )
    try:
        summary = json.loads(imported.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Nettle importer returned invalid summary JSON for {top}:\n{imported.stdout}"
        ) from error
    return len(modules), cells, summary


def validate_nettle_bundle(
    slang: str,
    yosys: str,
    corpus: Path,
    example: Dict[str, object],
    scratch: Path,
) -> None:
    filelist = (corpus / str(example["filelist"])).resolve()
    top = str(example["top"])
    outputs = [scratch / "example-first.nettle", scratch / "example-second.nettle"]
    for output in outputs:
        run(
            [
                "cargo",
                "run",
                "--quiet",
                "-p",
                "nettle",
                "--",
                "build",
                "--filelist",
                str(filelist),
                "--project-root",
                str(corpus),
                "--top",
                top,
                "--slang-bin",
                slang,
                "--yosys-bin",
                yosys,
                "--output",
                str(output),
            ],
            cwd=ROOT,
        )
        run(
            [
                "cargo",
                "run",
                "--quiet",
                "-p",
                "nettle",
                "--",
                "validate",
                str(output),
            ],
            cwd=ROOT,
        )
    if outputs[0].read_bytes() != outputs[1].read_bytes():
        raise RuntimeError(f"repeated .nettle builds are not deterministic for {top}")
    print(
        f"PASS {example['id']} (.nettle) — validated deterministic bundle "
        f"({outputs[0].stat().st_size} bytes)"
    )


def build_nettle_bundle(
    slang: str,
    yosys: str,
    corpus: Path,
    example: Dict[str, object],
    parameters: Dict[str, str],
    output: Path,
) -> None:
    """Build and validate one browser-consumable bundle."""
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "cargo",
        "run",
        "--quiet",
        "-p",
        "nettle",
        "--",
        "build",
        "--filelist",
        str((corpus / str(example["filelist"])).resolve()),
        "--project-root",
        str(corpus),
        "--top",
        str(example["top"]),
        "--slang-bin",
        slang,
        "--yosys-bin",
        yosys,
        "--output",
        str(output),
    ]
    for name, value in sorted(parameters.items()):
        command.extend(["--param", f"{name}={value}"])
    run(command, cwd=ROOT)
    run(
        [
            "cargo",
            "run",
            "--quiet",
            "-p",
            "nettle",
            "--",
            "validate",
            str(output),
        ],
        cwd=ROOT,
    )


def build_comparison_fixtures(
    slang: str,
    yosys: str,
    corpus: Path,
    examples: List[Dict[str, object]],
) -> None:
    """Build a real one-line RTL diff pair for the browser geometry test."""
    reference_path = os.environ.get("NETTLE_COMPARISON_REFERENCE_FIXTURE")
    candidate_path = os.environ.get("NETTLE_COMPARISON_CANDIDATE_FIXTURE")
    if reference_path is None and candidate_path is None:
        return
    if reference_path is None or candidate_path is None:
        raise RuntimeError(
            "NETTLE_COMPARISON_REFERENCE_FIXTURE and "
            "NETTLE_COMPARISON_CANDIDATE_FIXTURE must be set together"
        )
    example = next(
        (example for example in examples if example["id"] == "priority-encoder"),
        None,
    )
    if example is None:
        raise RuntimeError(
            "real comparison fixtures require the Bedrock RTL priority-encoder example"
        )
    parameters = example.get("parameters", {})
    if not isinstance(parameters, dict) or not parameters:
        raise RuntimeError("priority-encoder comparison fixture requires parameters")
    source = corpus / "bedrock-rtl/enc/rtl/br_enc_priority_encoder.sv"
    original = source.read_bytes()
    reference_expression = b"in_masked[in_idx] && (in_masked[in_idx-1:out_idx] == '0)"
    candidate_expression = b"in_masked[in_idx] || (in_masked[in_idx-1:out_idx] == '0)"
    if original.count(reference_expression) != 1:
        raise RuntimeError(
            "priority-encoder comparison mutation no longer has one exact source match"
        )
    build_nettle_bundle(
        slang,
        yosys,
        corpus,
        example,
        parameters,
        Path(reference_path).resolve(),
    )
    source.write_bytes(original.replace(reference_expression, candidate_expression))
    try:
        build_nettle_bundle(
            slang,
            yosys,
            corpus,
            example,
            parameters,
            Path(candidate_path).resolve(),
        )
    finally:
        source.write_bytes(original)
    print(
        "PASS priority-encoder (comparison) — built validated parameterized "
        "bundles around a one-line RTL mutation for browser geometry testing"
    )


def validate_generated_netlist(
    yosys: str, corpus: Path, example: Dict[str, object]
) -> None:
    """Generate one netlist from the pinned checkout and verify its digest."""
    generated = example.get("generatedNetlist")
    if not isinstance(generated, dict):
        return
    netlist = corpus / str(generated["path"])
    expected_digest = str(generated["sha256"])
    run(
        [yosys, "-Q", "-m", "slang", "-s", str(generated["script"])],
        cwd=corpus,
    )
    generated_bytes = netlist.read_bytes()
    actual_digest = hashlib.sha256(generated_bytes).hexdigest()
    if actual_digest != expected_digest:
        raise RuntimeError(
            f"generated netlist digest changed for {example['id']}: "
            f"expected {expected_digest}, actual {actual_digest}"
        )
    print(
        f"PASS {example['id']} (synthesis) — generated {len(generated_bytes)} bytes "
        f"with SHA-256 {expected_digest}"
    )


def validate_nettle_render(
    slang: str,
    yosys: str,
    corpus: Path,
    example: Dict[str, object],
    scratch: Path,
) -> None:
    """Build and serve one synthesized-netlist bundle through `nettle render`."""
    filelist = (corpus / str(example["filelist"])).resolve()
    requested_output = os.environ.get("NETTLE_NETLIST_FIXTURE")
    output = (
        Path(requested_output).resolve()
        if requested_output
        else scratch / "synthesized-netlist.nettle"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    web_root = scratch / "render-web"
    web_root.mkdir()
    (web_root / "index.html").write_text("<!doctype html><title>Nettle</title>\n")

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]

    command = [
        "cargo",
        "run",
        "--quiet",
        "-p",
        "nettle",
        "--",
        "render",
        "--filelist",
        str(filelist),
        "--project-root",
        str(corpus),
        "--top",
        str(example["top"]),
        "--slang-bin",
        slang,
        "--yosys-bin",
        yosys,
        "--output",
        str(output),
        "--web-root",
        str(web_root),
        "--port",
        str(port),
    ]
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(200):
            if process.poll() is not None:
                output_text = process.stdout.read() if process.stdout else ""
                raise RuntimeError(
                    f"nettle render exited before serving the netlist:\n{output_text}"
                )
            try:
                with urlopen(f"{base_url}/healthz", timeout=0.2) as response:
                    if response.read() == b"ok":
                        break
            except (URLError, TimeoutError):
                time.sleep(0.05)
        else:
            raise RuntimeError("timed out waiting for nettle render")

        with urlopen(f"{base_url}/startup.nettle", timeout=5) as response:
            served = response.read()
            if response.headers.get("Cache-Control") != "no-store":
                raise RuntimeError("render startup bundle is not marked no-store")
        if served != output.read_bytes():
            raise RuntimeError("render startup route did not serve its built netlist bundle")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    print(
        f"PASS {example['id']} (render) — built and served "
        f"{len(served)} bundle bytes from synthesized Verilog"
    )


def main() -> int:
    args = parse_args()
    if args.jobs < 1:
        raise RuntimeError("--jobs must be a positive integer")
    if args.prepare_only and args.workspace is None:
        raise RuntimeError("--prepare-only requires --workspace")
    require_tool("git")
    corpus_names = tuple(args.corpus or CORPUS_NAMES)
    requested = set(args.examples or [])
    corpora = []
    for corpus_name in corpus_names:
        corpus = CORPORA_ROOT / corpus_name
        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        validate_manifest(corpus, manifest)
        examples = [
            example
            for example in manifest["examples"]
            if not requested or example["id"] in requested
        ]
        corpora.append((corpus_name, corpus, manifest, examples))
    found = {
        str(example["id"])
        for _, _, _, examples in corpora
        for example in examples
    }
    missing = requested - found
    if missing:
        raise RuntimeError(f"unknown example id(s): {', '.join(sorted(missing))}")

    def run_in_workspace(workspace: Path) -> int:
        staged_corpora = [
            (corpus_name, stage_corpus(corpus, manifest, workspace), examples)
            for corpus_name, corpus, manifest, examples in corpora
        ]
        if args.prepare_only:
            for corpus_name, corpus, _ in staged_corpora:
                print(f"Prepared {corpus_name} at {corpus}")
            return 0

        slang = require_tool("slang")
        yosys = None if args.slang_only else require_tool("yosys")
        started = time.perf_counter()
        scratch = workspace / "results"
        scratch.mkdir(exist_ok=True)

        def validate_corpus(staged_corpus: Tuple[str, Path, List[Dict]]) -> int:
            corpus_name, corpus, examples = staged_corpus
            checks = 0
            corpus_scratch = scratch / corpus_name
            corpus_scratch.mkdir(exist_ok=True)
            if yosys is not None:
                for example in examples:
                    validate_generated_netlist(yosys, corpus, example)
            for example in examples:
                filelist = (corpus / str(example["filelist"])).resolve()
                top = str(example["top"])
                variants = [("default", {})]
                parameters = example.get("parameters", {})
                if parameters:
                    variants.append(("parameters", parameters))
                for variant, parameter_values in variants:
                    stem = f"{example['id']}-{variant}"
                    validate_slang(
                        slang,
                        filelist,
                        top,
                        parameter_values,
                        corpus_scratch / f"{stem}-diagnostics.json",
                    )
                    detail = "Slang: clean"
                    if not args.slang_only:
                        assert yosys is not None
                        modules, cells, graph_summary = validate_yosys(
                            yosys,
                            filelist,
                            top,
                            parameter_values,
                            corpus_scratch / f"{stem}.ys",
                            corpus_scratch / f"{stem}.json",
                        )
                        expected = example.get("expectedGraph", {}).get(variant)
                        if not args.skip_expected:
                            if expected is None:
                                raise RuntimeError(
                                    f"manifest has no expected graph summary for "
                                    f"{corpus_name}/{example['id']} ({variant}); actual: "
                                    f"{json.dumps(graph_summary, sort_keys=True)}"
                                )
                            if graph_summary != expected:
                                raise RuntimeError(
                                    f"Nettle graph summary changed for "
                                    f"{corpus_name}/{example['id']} ({variant}):\n"
                                    f"expected: {json.dumps(expected, sort_keys=True)}\n"
                                    f"actual:   {json.dumps(graph_summary, sort_keys=True)}"
                                )
                        detail += (
                            f", Yosys: {modules} modules / {cells} cells"
                            f", Nettle: {graph_summary['topNodeCount']} nodes / "
                            f"{graph_summary['topEdgeCount']} edges"
                        )
                        if args.skip_expected:
                            detail += f", summary: {json.dumps(graph_summary, sort_keys=True)}"
                    checks += 1
                    print(f"PASS {corpus_name}/{example['id']} ({variant}) — {detail}")

            if yosys is not None and examples:
                if corpus_name == "bedrock-rtl":
                    build_comparison_fixtures(slang, yosys, corpus, examples)
                preferred = next(
                    (example for example in examples if example["id"] == "counter"),
                    examples[0],
                )
                validate_nettle_bundle(
                    slang, yosys, corpus, preferred, corpus_scratch
                )
                synthesized = next(
                    (example for example in examples if example.get("generatedNetlist")),
                    None,
                )
                if synthesized is not None:
                    validate_nettle_render(
                        slang, yosys, corpus, synthesized, corpus_scratch
                    )
            return checks

        if args.jobs == 1 or len(staged_corpora) == 1:
            checks = sum(validate_corpus(corpus) for corpus in staged_corpora)
        else:
            futures = []
            with ThreadPoolExecutor(
                max_workers=min(args.jobs, len(staged_corpora))
            ) as executor:
                futures = [
                    executor.submit(validate_corpus, corpus)
                    for corpus in staged_corpora
                ]
                try:
                    checks = sum(
                        future.result() for future in as_completed(futures)
                    )
                except BaseException:
                    for future in futures:
                        future.cancel()
                    raise

        elapsed = time.perf_counter() - started
        print(f"Validated {checks} design-corpus elaborations in {elapsed:.2f} s")
        return 0

    if args.workspace is not None:
        workspace = args.workspace.resolve()
        if workspace == ROOT or (
            workspace.is_relative_to(ROOT)
            and not workspace.is_relative_to(ROOT / "target")
        ):
            raise RuntimeError(
                "a persistent workspace inside the repository must be under target/"
            )
        workspace.mkdir(parents=True, exist_ok=True)
        return run_in_workspace(workspace)
    with tempfile.TemporaryDirectory(prefix="nettle-design-corpus-") as directory:
        return run_in_workspace(Path(directory))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
