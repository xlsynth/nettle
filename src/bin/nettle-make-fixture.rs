// SPDX-License-Identifier: Apache-2.0

//! Produces a deterministic `.nettle` fixture for browser end-to-end tests.
#![deny(missing_docs)]

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use nettle::bundle::{BuildMetadata, BundleContents, BundleSource, ToolMetadata, write_bundle};
use nettle::ir::{
    DesignSnapshot, GraphEdge, GraphModule, GraphNode, GraphPort, GraphSlice, NodeKind,
    PortDirection, SourceFileRef, SourceOrigin, import_yosys_value,
};

fn origin(line: u32) -> SourceOrigin {
    SourceOrigin {
        file: "rtl/top.sv".to_owned(),
        start_line: line,
        start_column: 1,
        end_line: line,
        end_column: Some(20),
    }
}

fn boundary(id: &str, kind: NodeKind, direction: PortDirection) -> GraphNode {
    GraphNode {
        id: id.to_owned(),
        kind,
        label: id.to_owned(),
        definition_name: None,
        parameters: BTreeMap::new(),
        attributes: BTreeMap::new(),
        ports: vec![GraphPort {
            id: format!("{id}-port"),
            name: id.to_owned(),
            direction,
            index: None,
            role: None,
            width: Some(8),
        }],
        origins: vec![origin(2)],
    }
}

fn graph_module(id: &str, name: &str) -> GraphModule {
    GraphModule {
        id: id.to_owned(),
        name: name.to_owned(),
        instance_path: name.to_owned(),
        definition_name: name.to_owned(),
        parameters: BTreeMap::from([("WIDTH".to_owned(), 8.into())]),
        attributes: BTreeMap::new(),
    }
}

fn write_shift_register_fixture(output: &Path) {
    let source = b"module top(input logic clk, resetn, accept, output logic ready);\n  reg [3:0] pipe;\n  always @(posedge clk or negedge resetn) begin\n    if (!resetn)\n      pipe <= 4'b0;\n    else\n      pipe <= {pipe[2:0], accept};\n  end\n  assign ready = pipe[3];\nendmodule\n";
    let yosys = serde_json::json!({
        "modules": {
            "top": {
                "attributes": {"top": 1, "src": "rtl/top.sv:1.1-11.10"},
                "ports": {
                    "clk": {"direction": "input", "bits": [2]},
                    "resetn": {"direction": "input", "bits": [3]},
                    "accept": {"direction": "input", "bits": [4]},
                    "ready": {"direction": "output", "bits": [13]}
                },
                "cells": {
                    "$driver$pipe": {
                        "type": "$aldff",
                        "parameters": {
                            "ALOAD_POLARITY": "0",
                            "CLK_POLARITY": "1",
                            "WIDTH": "00000000000000000000000000000100"
                        },
                        "attributes": {"src": "rtl/top.sv:3.3-9.6"},
                        "port_directions": {
                            "AD": "input",
                            "ALOAD": "input",
                            "CLK": "input",
                            "D": "input",
                            "Q": "output"
                        },
                        "connections": {
                            "AD": ["0", "0", "0", "0"],
                            "ALOAD": [3],
                            "CLK": [2],
                            "D": [4, 10, 11, 12],
                            "Q": [10, 11, 12, 13]
                        }
                    }
                },
                "netnames": {
                    "pipe": {
                        "hide_name": 0,
                        "bits": [10, 11, 12, 13],
                        "attributes": {"src": "rtl/top.sv:2.13-2.17"}
                    }
                }
            }
        }
    });
    let snapshot = import_yosys_value(yosys, Some("top")).expect("import shift register fixture");
    let source_id = snapshot.modules["top"].files.as_ref().unwrap()[0]
        .id
        .clone();
    let sources = vec![BundleSource {
        id: source_id,
        path: "rtl/top.sv".to_owned(),
        contents: source.to_vec(),
    }];
    let build = BuildMetadata {
        filelist: "fixture.f".to_owned(),
        parameters: vec![],
        defines: vec![],
        undefines: vec![],
        tools: vec![ToolMetadata {
            name: "yosys".to_owned(),
            path: "yosys".to_owned(),
            version: "fixture 1.0".to_owned(),
        }],
    };
    write_bundle(
        output,
        &BundleContents {
            snapshot: &snapshot,
            sources: &sources,
            diagnostics: &[],
            build: &build,
            debug_artifacts: &[],
        },
    )
    .expect("write shift register fixture bundle");
}

fn main() {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: cargo run --bin nettle-make-fixture -- OUTPUT.nettle");
    if env::args_os()
        .nth(2)
        .is_some_and(|argument| argument == "--shift-register")
    {
        write_shift_register_fixture(&output);
        return;
    }
    let file = SourceFileRef {
        id: "file-top".to_owned(),
        path: "rtl/top.sv".to_owned(),
    };
    let child = GraphSlice {
        snapshot_id: "snapshot-browser-fixture".to_owned(),
        module: graph_module("module-child", "child"),
        nodes: vec![
            boundary("data_i", NodeKind::Input, PortDirection::Output),
            boundary("data_o", NodeKind::Output, PortDirection::Input),
        ],
        edges: vec![GraphEdge {
            id: "edge-child".to_owned(),
            source_node: "data_i".to_owned(),
            source_port: Some("data_i-port".to_owned()),
            target_node: "data_o".to_owned(),
            target_port: Some("data_o-port".to_owned()),
            label: Some("data_i".to_owned()),
            width: Some(8),
            signal_type: Some("logic [7:0]".to_owned()),
            origins: vec![origin(7)],
        }],
        groups: vec![],
        files: Some(vec![file.clone()]),
    };
    let top = GraphSlice {
        snapshot_id: "snapshot-browser-fixture".to_owned(),
        module: graph_module("module-top", "top"),
        nodes: vec![
            boundary("data_i", NodeKind::Input, PortDirection::Output),
            GraphNode {
                id: "instance-child".to_owned(),
                kind: NodeKind::ModuleInstance,
                label: "u_child".to_owned(),
                definition_name: Some("child".to_owned()),
                parameters: BTreeMap::from([("WIDTH".to_owned(), 8.into())]),
                attributes: BTreeMap::new(),
                ports: vec![
                    GraphPort {
                        id: "child-in".to_owned(),
                        name: "data_i".to_owned(),
                        direction: PortDirection::Input,
                        index: None,
                        role: Some("data".to_owned()),
                        width: Some(8),
                    },
                    GraphPort {
                        id: "child-out".to_owned(),
                        name: "data_o".to_owned(),
                        direction: PortDirection::Output,
                        index: None,
                        role: Some("data".to_owned()),
                        width: Some(8),
                    },
                ],
                origins: vec![origin(6)],
            },
            boundary("data_o", NodeKind::Output, PortDirection::Input),
        ],
        edges: vec![
            GraphEdge {
                id: "edge-in".to_owned(),
                source_node: "data_i".to_owned(),
                source_port: Some("data_i-port".to_owned()),
                target_node: "instance-child".to_owned(),
                target_port: Some("child-in".to_owned()),
                label: Some("data_i".to_owned()),
                width: Some(8),
                signal_type: Some("logic [7:0]".to_owned()),
                origins: vec![origin(6)],
            },
            GraphEdge {
                id: "edge-out".to_owned(),
                source_node: "instance-child".to_owned(),
                source_port: Some("child-out".to_owned()),
                target_node: "data_o".to_owned(),
                target_port: Some("data_o-port".to_owned()),
                label: Some("data_o".to_owned()),
                width: Some(8),
                signal_type: Some("logic [7:0]".to_owned()),
                origins: vec![origin(6)],
            },
        ],
        groups: vec![],
        files: Some(vec![file]),
    };
    let snapshot = DesignSnapshot {
        snapshot_id: "snapshot-browser-fixture".to_owned(),
        top: "top".to_owned(),
        tops: vec!["top".to_owned()],
        modules: BTreeMap::from([("child".to_owned(), child), ("top".to_owned(), top)]),
    };
    let sources = vec![BundleSource {
        id: "file-top".to_owned(),
        path: "rtl/top.sv".to_owned(),
        contents: b"module top(input logic [7:0] data_i, output logic [7:0] data_o);\n  child #(.WIDTH(8)) u_child(.data_i, .data_o);\nendmodule\n\nmodule child #(parameter WIDTH = 8)(input logic [WIDTH-1:0] data_i, output logic [WIDTH-1:0] data_o);\n  assign data_o = data_i;\nendmodule\n".to_vec(),
    }];
    let build = BuildMetadata {
        filelist: "fixture.f".to_owned(),
        parameters: vec![("WIDTH".to_owned(), "8".to_owned())],
        defines: vec![("SYNTHESIS".to_owned(), None)],
        undefines: vec!["SIMULATION".to_owned()],
        tools: vec![ToolMetadata {
            name: "slang".to_owned(),
            path: "slang".to_owned(),
            version: "fixture 1.0".to_owned(),
        }],
    };
    write_bundle(
        &output,
        &BundleContents {
            snapshot: &snapshot,
            sources: &sources,
            diagnostics: &[],
            build: &build,
            debug_artifacts: &[],
        },
    )
    .expect("write fixture bundle");
}
