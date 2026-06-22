// SPDX-License-Identifier: Apache-2.0

//! Prints stable graph-summary metadata for integration-regression comparisons.
#![deny(missing_docs)]

use std::{collections::BTreeMap, env, fs, process::ExitCode};

use nettle::ir::{NodeKind, import_yosys_json};
use serde_json::json;

fn kind_name(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Input => "input",
        NodeKind::Output => "output",
        NodeKind::Inout => "inout",
        NodeKind::Operator => "operator",
        NodeKind::Mux => "mux",
        NodeKind::Register => "register",
        NodeKind::Latch => "latch",
        NodeKind::Memory => "memory",
        NodeKind::ModuleInstance => "moduleInstance",
        NodeKind::Constant => "constant",
        NodeKind::Primitive => "primitive",
        NodeKind::Unknown => "unknown",
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments
        .next()
        .ok_or_else(|| "usage: nettle-import-summary <yosys.json> <top>".to_owned())?;
    let top = arguments
        .next()
        .ok_or_else(|| "usage: nettle-import-summary <yosys.json> <top>".to_owned())?;
    if arguments.next().is_some() {
        return Err("usage: nettle-import-summary <yosys.json> <top>".to_owned());
    }
    let top = top
        .to_str()
        .ok_or_else(|| "top name is not valid UTF-8".to_owned())?;
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("failed to read {:?}: {error}", path))?;
    let snapshot = import_yosys_json(&contents, Some(top))
        .map_err(|error| format!("failed to import {:?}: {error}", path))?;
    let graph = snapshot
        .modules
        .get(&snapshot.top)
        .ok_or_else(|| format!("imported snapshot has no graph for top {:?}", snapshot.top))?;

    let mut kinds = BTreeMap::<&str, usize>::new();
    for node in &graph.nodes {
        *kinds.entry(kind_name(node.kind)).or_default() += 1;
    }
    let origin_count = graph
        .nodes
        .iter()
        .map(|node| node.origins.len())
        .sum::<usize>()
        + graph
            .edges
            .iter()
            .map(|edge| edge.origins.len())
            .sum::<usize>();
    let summary = json!({
        "moduleCount": snapshot.modules.len(),
        "topNodeCount": graph.nodes.len(),
        "topEdgeCount": graph.edges.len(),
        "sourceOriginCount": origin_count,
        "nodeKinds": kinds,
    });
    println!(
        "{}",
        serde_json::to_string(&summary).expect("summary is serializable")
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ERROR: {error}");
            ExitCode::FAILURE
        }
    }
}
