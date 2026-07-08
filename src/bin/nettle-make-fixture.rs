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

fn origin_in(file: &str, line: u32) -> SourceOrigin {
    SourceOrigin {
        file: file.to_owned(),
        start_line: line,
        start_column: 1,
        end_line: line,
        end_column: Some(20),
    }
}

fn origin(line: u32) -> SourceOrigin {
    origin_in("rtl/top.sv", line)
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

fn comparison_boundary(
    id: &str,
    kind: NodeKind,
    direction: PortDirection,
    width: u32,
    line: u32,
) -> GraphNode {
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
            role: Some("data".to_owned()),
            width: Some(width),
        }],
        origins: vec![origin(line)],
    }
}

fn comparison_operator(id: &str, width: u32, line: u32) -> GraphNode {
    GraphNode {
        id: id.to_owned(),
        kind: NodeKind::Operator,
        label: "+".to_owned(),
        definition_name: None,
        parameters: BTreeMap::from([("WIDTH".to_owned(), width.into())]),
        attributes: BTreeMap::new(),
        ports: vec![
            GraphPort {
                id: format!("{id}-a"),
                name: "A".to_owned(),
                direction: PortDirection::Input,
                index: Some(0),
                role: Some("data".to_owned()),
                width: Some(width),
            },
            GraphPort {
                id: format!("{id}-y"),
                name: "Y".to_owned(),
                direction: PortDirection::Output,
                index: None,
                role: Some("data".to_owned()),
                width: Some(width),
            },
        ],
        origins: vec![origin(line)],
    }
}

fn comparison_instance(
    id: &str,
    label: &str,
    definition: &str,
    width: u32,
    source: &str,
) -> GraphNode {
    GraphNode {
        id: id.to_owned(),
        kind: NodeKind::ModuleInstance,
        label: label.to_owned(),
        definition_name: Some(definition.to_owned()),
        parameters: BTreeMap::from([("WIDTH".to_owned(), width.into())]),
        attributes: BTreeMap::new(),
        ports: vec![],
        origins: vec![origin_in(source, 1)],
    }
}

fn comparison_edge(
    id: &str,
    source_node: &str,
    source_port: &str,
    target_node: &str,
    target_port: &str,
    width: u32,
    line: u32,
) -> GraphEdge {
    GraphEdge {
        id: id.to_owned(),
        source_node: source_node.to_owned(),
        source_port: Some(source_port.to_owned()),
        target_node: target_node.to_owned(),
        target_port: Some(target_port.to_owned()),
        label: Some("data".to_owned()),
        width: Some(width),
        signal_type: Some(format!("logic [{}:0]", width - 1)),
        origins: vec![origin(line)],
    }
}

fn write_comparison_fixture(output: &Path, candidate: bool) {
    let width = if candidate { 16 } else { 8 };
    let operator_id = if candidate {
        "$add$top.sv:4"
    } else {
        "$add$top.sv:3"
    };
    let operator_line = if candidate { 4 } else { 3 };
    let mut nodes = vec![
        comparison_boundary("data_i", NodeKind::Input, PortDirection::Output, width, 1),
        comparison_operator(operator_id, width, operator_line),
        comparison_boundary("data_o", NodeKind::Output, PortDirection::Input, width, 1),
        comparison_instance("u-child", "u_child", "child", width, "rtl/top.sv"),
    ];
    if candidate {
        nodes.push(comparison_instance(
            "u-new",
            "u_new",
            "new_child",
            1,
            "rtl/new_child.sv",
        ));
    } else {
        nodes.push(comparison_instance(
            "u-legacy",
            "u_legacy",
            "legacy_child",
            1,
            "rtl/legacy_child.sv",
        ));
    }
    let mut unchanged_logic = comparison_operator("unchanged-logic", 1, 1);
    unchanged_logic.origins = vec![origin_in("rtl/common.svh", 1)];
    nodes.push(unchanged_logic);
    let mut elaboration_logic = comparison_operator("elaboration-logic", width, 1);
    elaboration_logic.origins = vec![origin_in("rtl/elaboration_only.sv", 1)];
    nodes.push(elaboration_logic);
    for suffix in ["a", "b"] {
        let id = if candidate {
            format!("ambiguous-candidate-{suffix}")
        } else {
            format!("ambiguous-reference-{suffix}")
        };
        let mut ambiguous_logic = comparison_operator(&id, 1, 1);
        ambiguous_logic.origins = vec![origin_in("rtl/ambiguous.sv", 1)];
        nodes.push(ambiguous_logic);
    }
    let mut edges = vec![
        comparison_edge(
            "edge-input",
            "data_i",
            "data_i-port",
            operator_id,
            &format!("{operator_id}-a"),
            width,
            operator_line,
        ),
        comparison_edge(
            "edge-output",
            operator_id,
            &format!("{operator_id}-y"),
            "data_o",
            "data_o-port",
            width,
            operator_line,
        ),
    ];
    if candidate {
        nodes.push(comparison_boundary(
            "status_o",
            NodeKind::Output,
            PortDirection::Input,
            1,
            5,
        ));
        edges.push(comparison_edge(
            "edge-status",
            operator_id,
            &format!("{operator_id}-y"),
            "status_o",
            "status_o-port",
            1,
            5,
        ));
    } else {
        nodes.push(comparison_boundary(
            "legacy_o",
            NodeKind::Output,
            PortDirection::Input,
            1,
            4,
        ));
        edges.push(comparison_edge(
            "edge-legacy",
            operator_id,
            &format!("{operator_id}-y"),
            "legacy_o",
            "legacy_o-port",
            1,
            4,
        ));
    }
    let snapshot_id = if candidate {
        "snapshot-comparison-candidate"
    } else {
        "snapshot-comparison-reference"
    };
    let mut files = vec![
        SourceFileRef {
            id: "file-top".to_owned(),
            path: "rtl/top.sv".to_owned(),
        },
        SourceFileRef {
            id: "file-common".to_owned(),
            path: "rtl/common.svh".to_owned(),
        },
        SourceFileRef {
            id: "file-elaboration-only".to_owned(),
            path: "rtl/elaboration_only.sv".to_owned(),
        },
        SourceFileRef {
            id: "file-ambiguous".to_owned(),
            path: "rtl/ambiguous.sv".to_owned(),
        },
    ];
    let (one_sided_definition, one_sided_file_id, one_sided_path) = if candidate {
        ("new_child", "file-new-child", "rtl/new_child.sv")
    } else {
        ("legacy_child", "file-legacy-child", "rtl/legacy_child.sv")
    };
    files.push(SourceFileRef {
        id: one_sided_file_id.to_owned(),
        path: one_sided_path.to_owned(),
    });
    let top = GraphSlice {
        snapshot_id: snapshot_id.to_owned(),
        module: GraphModule {
            id: "module-top".to_owned(),
            name: "top".to_owned(),
            instance_path: "top".to_owned(),
            definition_name: "top".to_owned(),
            parameters: BTreeMap::from([("WIDTH".to_owned(), width.into())]),
            attributes: BTreeMap::new(),
        },
        nodes,
        edges,
        groups: vec![],
        files: Some(files),
    };
    let mut child_input = comparison_boundary(
        "child-data-i",
        NodeKind::Input,
        PortDirection::Output,
        width,
        1,
    );
    child_input.origins = vec![origin_in("rtl/child.sv", 1)];
    let mut child_output = comparison_boundary(
        "child-data-o",
        NodeKind::Output,
        PortDirection::Input,
        width,
        1,
    );
    child_output.origins = vec![origin_in("rtl/child.sv", 1)];
    let mut child_edge = comparison_edge(
        "child-edge",
        "child-data-i",
        "child-data-i-port",
        "child-data-o",
        "child-data-o-port",
        width,
        1,
    );
    child_edge.origins = vec![origin_in("rtl/child.sv", 1)];
    let child = GraphSlice {
        snapshot_id: snapshot_id.to_owned(),
        module: GraphModule {
            id: "module-child".to_owned(),
            name: "child".to_owned(),
            instance_path: "child".to_owned(),
            definition_name: "child".to_owned(),
            parameters: BTreeMap::from([("WIDTH".to_owned(), width.into())]),
            attributes: BTreeMap::new(),
        },
        nodes: vec![child_input, child_output],
        edges: vec![child_edge],
        groups: vec![],
        files: Some(vec![SourceFileRef {
            id: "file-child".to_owned(),
            path: "rtl/child.sv".to_owned(),
        }]),
    };
    let mut one_sided_boundary = comparison_boundary(
        "one-sided-data-o",
        NodeKind::Output,
        PortDirection::Input,
        1,
        1,
    );
    one_sided_boundary.origins = vec![origin_in(one_sided_path, 1)];
    let one_sided_child = GraphSlice {
        snapshot_id: snapshot_id.to_owned(),
        module: GraphModule {
            id: format!("module-{one_sided_definition}"),
            name: one_sided_definition.to_owned(),
            instance_path: one_sided_definition.to_owned(),
            definition_name: one_sided_definition.to_owned(),
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
        },
        nodes: vec![one_sided_boundary],
        edges: vec![],
        groups: vec![],
        files: Some(vec![SourceFileRef {
            id: one_sided_file_id.to_owned(),
            path: one_sided_path.to_owned(),
        }]),
    };
    let mut modules = BTreeMap::from([("child".to_owned(), child), ("top".to_owned(), top)]);
    modules.insert(one_sided_definition.to_owned(), one_sided_child);
    let snapshot = DesignSnapshot {
        snapshot_id: snapshot_id.to_owned(),
        top: "top".to_owned(),
        tops: vec!["top".to_owned()],
        modules,
    };
    let source = if candidate {
        b"module top #(parameter WIDTH = 16)(input logic [WIDTH-1:0] data_i, output logic [WIDTH-1:0] data_o, output logic status_o);\n  // Candidate widens the datapath and replaces the legacy output.\n  logic [WIDTH-1:0] sum;\n  assign sum = data_i + 2;\n  assign {status_o, data_o} = {1'b1, sum};\nendmodule\n".to_vec()
    } else {
        b"module top #(parameter WIDTH = 8)(input logic [WIDTH-1:0] data_i, output logic [WIDTH-1:0] data_o, output logic legacy_o);\n  logic [WIDTH-1:0] sum;\n  assign sum = data_i + 1;\n  assign {legacy_o, data_o} = {1'b0, sum};\nendmodule\n".to_vec()
    };
    let mut sources = vec![
        BundleSource {
            id: "file-top".to_owned(),
            path: "rtl/top.sv".to_owned(),
            contents: source,
        },
        BundleSource {
            id: "file-common".to_owned(),
            path: "rtl/common.svh".to_owned(),
            contents: b"`define NETTLE_FIXTURE_COMMON 1\n".to_vec(),
        },
        BundleSource {
            id: "file-child".to_owned(),
            path: "rtl/child.sv".to_owned(),
            contents: b"module child #(parameter WIDTH = 1)(); endmodule\n".to_vec(),
        },
        BundleSource {
            id: "file-elaboration-only".to_owned(),
            path: "rtl/elaboration_only.sv".to_owned(),
            contents: b"// Graph width changes only because the bundle parameter changes.\n"
                .to_vec(),
        },
        BundleSource {
            id: "file-ambiguous".to_owned(),
            path: "rtl/ambiguous.sv".to_owned(),
            contents: b"// Repeated generated operators intentionally have ambiguous identities.\n"
                .to_vec(),
        },
        BundleSource {
            id: "file-source-only".to_owned(),
            path: "rtl/z_source_only.sv".to_owned(),
            contents: if candidate {
                b"// Candidate-only documentation edit with no elaborated graph effect.\n".to_vec()
            } else {
                b"// Reference documentation text with no elaborated graph effect.\n".to_vec()
            },
        },
    ];
    sources.push(BundleSource {
        id: one_sided_file_id.to_owned(),
        path: one_sided_path.to_owned(),
        contents: format!("module {one_sided_definition}(); endmodule\n").into_bytes(),
    });
    let build = BuildMetadata {
        filelist: "fixture.f".to_owned(),
        parameters: vec![("WIDTH".to_owned(), width.to_string())],
        defines: vec![],
        undefines: vec![],
        tools: vec![ToolMetadata {
            name: "slang".to_owned(),
            path: "slang".to_owned(),
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
    .expect("write comparison fixture bundle");
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
    if let Some(argument) = env::args_os().nth(2) {
        if argument == "--shift-register" {
            write_shift_register_fixture(&output);
            return;
        }
        if argument == "--comparison-reference" || argument == "--comparison-candidate" {
            write_comparison_fixture(&output, argument == "--comparison-candidate");
            return;
        }
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
