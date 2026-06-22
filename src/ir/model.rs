// SPDX-License-Identifier: Apache-2.0

//! Defines Nettle's compiler-neutral graph model and hierarchy projections.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Protocol version for all JSON DTOs in this crate.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Source range associated with a graph object or diagnostic.
pub struct SourceOrigin {
    /// Project-relative source path.
    pub file: String,
    /// One-based starting line.
    pub start_line: u32,
    /// One-based starting column.
    pub start_column: u32,
    /// One-based ending line.
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional one-based exclusive ending column.
    pub end_column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Stable identity and display path of a source referenced by a module graph.
pub struct SourceFileRef {
    /// Stable content-independent source identifier.
    pub id: String,
    /// Project-relative display path.
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Direction of a graph port or design boundary.
pub enum PortDirection {
    /// Signal enters the owning node.
    Input,
    /// Signal leaves the owning node.
    Output,
    /// Bidirectional signal.
    Inout,
    /// Direction could not be determined.
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Semantic category used to select a schematic glyph and behavior.
pub enum NodeKind {
    /// Top-level input boundary.
    Input,
    /// Top-level output boundary.
    Output,
    /// Top-level bidirectional boundary.
    Inout,
    /// Behavioral operator.
    Operator,
    /// Multiplexer or conditional selection.
    Mux,
    /// Edge-triggered storage.
    Register,
    /// Level-sensitive storage.
    Latch,
    /// Memory abstraction.
    Memory,
    /// Hierarchical module instance.
    ModuleInstance,
    /// Literal constant.
    Constant,
    /// Technology or language primitive.
    Primitive,
    /// Unclassified cell.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
/// One ordered connection point on a graph node.
pub struct GraphPort {
    /// Stable port identifier within the graph.
    pub id: String,
    /// Source-level or synthesized port name.
    pub name: String,
    /// Connection direction relative to the node.
    pub direction: PortDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Operand order for behavior whose inputs are not commutative.
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional semantic role such as clock, reset, select, or data.
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Flattened total signal width in bits.
    pub width: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
/// Schematic object with ports, metadata, and source provenance.
pub struct GraphNode {
    /// Stable node identifier.
    pub id: String,
    /// Semantic glyph category.
    pub kind: NodeKind,
    /// Human-readable short label.
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Referenced module definition for hierarchical instances.
    pub definition_name: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    /// Concrete elaborated parameters.
    pub parameters: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    /// Compiler or source attributes preserved as JSON values.
    pub attributes: BTreeMap<String, Value>,
    /// Ordered node connection points.
    pub ports: Vec<GraphPort>,
    #[serde(default)]
    /// Source ranges contributing to the node.
    pub origins: Vec<SourceOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
/// Directed signal connection between graph nodes.
pub struct GraphEdge {
    /// Stable edge identifier.
    pub id: String,
    /// Source node identifier.
    pub source_node: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional source port identifier.
    pub source_port: Option<String>,
    /// Target node identifier.
    pub target_node: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional target port identifier.
    pub target_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional source-visible signal name.
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Flattened total signal width in bits.
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional SystemVerilog type label.
    pub signal_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    /// Source ranges contributing to the connection.
    pub origins: Vec<SourceOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
/// Identity and metadata of the module represented by a graph slice.
pub struct GraphModule {
    /// Stable module graph identifier.
    pub id: String,
    /// Module name used for navigation.
    pub name: String,
    /// Hierarchical instance path represented by the slice.
    pub instance_path: String,
    /// Source-level module definition name.
    pub definition_name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    /// Concrete parameters applied at this hierarchy level.
    pub parameters: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    /// Module attributes preserved as JSON values.
    pub attributes: BTreeMap<String, Value>,
}

/// Projection-only retained boundary for a transparent module instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphGroup {
    /// The original module-instance node ID.
    pub id: String,
    /// Instance name displayed for the retained boundary.
    pub name: String,
    /// Source-level module definition name.
    pub definition_name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    /// Concrete parameters applied to the instance.
    pub parameters: BTreeMap<String, Value>,
    #[serde(default)]
    /// Source ranges associated with the original instance.
    pub origins: Vec<SourceOrigin>,
    /// Projected child nodes contained by this boundary.
    pub child_node_ids: Vec<String>,
}

/// Public graph DTO shared verbatim with the TypeScript client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphSlice {
    /// Stable identity of the complete design snapshot.
    pub snapshot_id: String,
    /// Module identity and metadata.
    pub module: GraphModule,
    /// Nodes contained in the slice.
    pub nodes: Vec<GraphNode>,
    /// Directed connections contained in the slice.
    pub edges: Vec<GraphEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    /// Retained transparent-instance boundaries.
    pub groups: Vec<GraphGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Source files referenced by nodes and edges.
    pub files: Option<Vec<SourceFileRef>>,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
/// Failure encountered while composing transparent hierarchy projections.
pub enum GraphProjectionError {
    #[error(
        "transparent instance ID {instance_id:?} does not exist in module {module:?}; only IDs from the unexpanded one-level slice can be requested"
    )]
    /// A requested node ID does not exist in the base module.
    UnknownInstance {
        /// Requested instance node ID.
        instance_id: String,
        /// Base module name.
        module: String,
    },
    #[error("graph node {instance_id:?} is not a module instance and cannot be transparent")]
    /// A requested node exists but is not a module instance.
    NotModuleInstance {
        /// Requested node ID.
        instance_id: String,
    },
    #[error("module instance {instance_id:?} has no definition name")]
    /// A module-instance node lacks a referenced definition.
    MissingDefinitionName {
        /// Instance node ID.
        instance_id: String,
    },
    #[error(
        "cannot expand instance {instance_id:?}: definition slice {definition_name:?} is unavailable"
    )]
    /// The referenced child module graph is unavailable.
    DefinitionNotFound {
        /// Instance node ID.
        instance_id: String,
        /// Missing definition name.
        definition_name: String,
    },
    #[error(
        "cannot reconnect {side} edge {edge_id:?} for instance {instance_id:?}: instance port {port_id:?} is unavailable"
    )]
    /// An instance-side port referenced by an edge is unavailable.
    InstancePortNotFound {
        /// Instance node ID.
        instance_id: String,
        /// Edge that could not be reconnected.
        edge_id: String,
        /// Missing instance port ID.
        port_id: String,
        /// Source or target side of the edge.
        side: &'static str,
    },
    #[error(
        "cannot reconnect {side} edge for instance {instance_id:?}: definition {definition_name:?} has no matching {boundary_kind} boundary named {port_name:?}"
    )]
    /// No matching child boundary exists for an instance port.
    BoundaryPortNotFound {
        /// Instance node ID.
        instance_id: String,
        /// Child definition name.
        definition_name: String,
        /// Instance port name requiring a match.
        port_name: String,
        /// Expected input or output boundary category.
        boundary_kind: &'static str,
        /// Source or target side of the edge.
        side: &'static str,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Selects a module graph and optional hierarchy projection.
pub struct GraphSliceRequest {
    #[serde(default)]
    /// Optional snapshot identity guard.
    pub snapshot_id: Option<String>,
    #[serde(default)]
    /// Optional stable module ID selector.
    pub module_id: Option<String>,
    #[serde(default)]
    /// Optional module-name selector.
    pub module_name: Option<String>,
    #[serde(default)]
    /// Optional hierarchy-path selector.
    pub instance_path: Option<String>,
    #[serde(default)]
    /// Specific one-level instance IDs to make transparent.
    pub transparent_instance_ids: Vec<String>,
    /// Recursively make every module instance transparent to this depth.
    /// Zero preserves the unexpanded graph.
    #[serde(default)]
    pub flatten_depth: usize,
    #[serde(default)]
    /// Optional maximum visible-object budget.
    pub budget: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Lightweight navigation metadata for one module graph.
pub struct ModuleSummary {
    /// Stable graph identifier.
    pub id: String,
    /// Module navigation name.
    pub name: String,
    /// Source-level definition name.
    pub definition_name: String,
    /// Hierarchical instance path.
    pub instance_path: String,
    /// Number of graph nodes.
    pub node_count: usize,
    /// Number of graph edges.
    pub edge_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Top-level design metadata used by navigation and inspection clients.
pub struct ProjectSummary {
    /// JSON DTO schema version.
    pub schema_version: u32,
    /// Human-readable project status.
    pub status: String,
    /// Stable snapshot identity.
    pub snapshot_id: String,
    /// Project containment boundary.
    pub project_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional root filelist path.
    pub filelist: Option<String>,
    /// Selected top module.
    pub top: String,
    /// Available top modules.
    pub tops: Vec<String>,
    /// Module navigation summaries.
    pub modules: Vec<ModuleSummary>,
    #[serde(default)]
    /// Normalized compiler diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Compiler diagnostic normalized across tool-specific formats.
pub struct Diagnostic {
    /// Diagnostic severity.
    pub severity: DiagnosticSeverity,
    /// Human-readable diagnostic message.
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional source range.
    pub origin: Option<SourceOrigin>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// Severity assigned to a normalized compiler diagnostic.
pub enum DiagnosticSeverity {
    /// Informational message.
    Info,
    /// Non-fatal warning.
    Warning,
    /// Compilation or elaboration error.
    Error,
}

#[derive(Debug, Clone)]
/// Complete compiler-neutral design with independently addressable module graphs.
pub struct DesignSnapshot {
    /// Stable identity derived from normalized design content.
    pub snapshot_id: String,
    /// Selected top module key.
    pub top: String,
    /// Available top-module names.
    pub tops: Vec<String>,
    /// Module graphs keyed by their navigation name.
    pub modules: BTreeMap<String, GraphSlice>,
}

impl DesignSnapshot {
    /// Returns sorted lightweight summaries for all module graphs.
    pub fn module_summaries(&self) -> Vec<ModuleSummary> {
        self.modules
            .values()
            .map(|slice| ModuleSummary {
                id: slice.module.id.clone(),
                name: slice.module.name.clone(),
                definition_name: slice.module.definition_name.clone(),
                instance_path: slice.module.instance_path.clone(),
                node_count: slice.nodes.len(),
                edge_count: slice.edges.len(),
            })
            .collect()
    }

    /// Selects the unprojected module graph described by `request`.
    pub fn select_slice(&self, request: &GraphSliceRequest) -> Option<&GraphSlice> {
        if let Some(id) = request.module_id.as_deref() {
            return self.modules.values().find(|slice| slice.module.id == id);
        }
        if let Some(path) = request.instance_path.as_deref()
            && let Some(slice) = self
                .modules
                .values()
                .find(|slice| slice.module.instance_path == path)
        {
            return Some(slice);
        }
        if let Some(name) = request.module_name.as_deref() {
            return self.modules.get(name);
        }
        self.modules.get(&self.top)
    }

    /// Returns exact object counts for a one-level transparent projection
    /// without cloning graph bodies. Hosts can use this preflight check to
    /// reject an oversized request before composing the projection.
    pub fn projected_object_counts(
        &self,
        base: &GraphSlice,
        requested_ids: &[String],
    ) -> Result<(usize, usize, usize), GraphProjectionError> {
        let mut instance_ids = requested_ids.to_vec();
        instance_ids.sort();
        instance_ids.dedup();
        let mut node_count = base.nodes.len();
        let mut edge_count = base.edges.len();
        let mut group_count = base.groups.len();

        for instance_id in instance_ids {
            let instance = base
                .nodes
                .iter()
                .find(|node| node.id == instance_id)
                .ok_or_else(|| GraphProjectionError::UnknownInstance {
                    instance_id: instance_id.clone(),
                    module: base.module.name.clone(),
                })?;
            if instance.kind != NodeKind::ModuleInstance {
                return Err(GraphProjectionError::NotModuleInstance { instance_id });
            }
            let definition_name = instance.definition_name.as_deref().ok_or_else(|| {
                GraphProjectionError::MissingDefinitionName {
                    instance_id: instance.id.clone(),
                }
            })?;
            let child = self
                .modules
                .get(definition_name)
                .or_else(|| {
                    self.modules.values().find(|slice| {
                        slice.module.name == definition_name
                            || slice.module.definition_name == definition_name
                    })
                })
                .ok_or_else(|| GraphProjectionError::DefinitionNotFound {
                    instance_id: instance.id.clone(),
                    definition_name: definition_name.to_owned(),
                })?;
            node_count = node_count
                .saturating_sub(1)
                .saturating_add(child.nodes.len());
            edge_count = edge_count.saturating_add(child.edges.len());
            group_count = group_count.saturating_add(1);
        }
        Ok((node_count, edge_count, group_count))
    }

    /// Builds a one-level transparent-instance projection without changing the
    /// snapshot or recursively expanding child instances.
    pub fn project_transparent_instances(
        &self,
        base: &GraphSlice,
        requested_ids: &[String],
    ) -> Result<GraphSlice, GraphProjectionError> {
        if requested_ids.is_empty() {
            return Ok(base.clone());
        }

        let mut instance_ids = requested_ids.to_vec();
        instance_ids.sort();
        instance_ids.dedup();
        let mut projection = base.clone();

        for instance_id in instance_ids {
            let instance = base
                .nodes
                .iter()
                .find(|node| node.id == instance_id)
                .ok_or_else(|| GraphProjectionError::UnknownInstance {
                    instance_id: instance_id.clone(),
                    module: base.module.name.clone(),
                })?;
            if instance.kind != NodeKind::ModuleInstance {
                return Err(GraphProjectionError::NotModuleInstance { instance_id });
            }
            let definition_name = instance.definition_name.as_deref().ok_or_else(|| {
                GraphProjectionError::MissingDefinitionName {
                    instance_id: instance.id.clone(),
                }
            })?;
            let child = self
                .modules
                .get(definition_name)
                .or_else(|| {
                    self.modules.values().find(|slice| {
                        slice.module.name == definition_name
                            || slice.module.definition_name == definition_name
                    })
                })
                .ok_or_else(|| GraphProjectionError::DefinitionNotFound {
                    instance_id: instance.id.clone(),
                    definition_name: definition_name.to_owned(),
                })?;
            expand_instance(&mut projection, instance, child)?;
        }

        projection
            .nodes
            .sort_by(|left, right| left.id.cmp(&right.id));
        projection
            .edges
            .sort_by(|left, right| left.id.cmp(&right.id));
        projection
            .groups
            .sort_by(|left, right| left.id.cmp(&right.id));
        merge_files(&mut projection.files, None);
        Ok(projection)
    }

    /// Expands every available instance definition in `base` to the same
    /// hierarchy depth. Opaque and black-box instances remain leaves. Retained
    /// groups mark every expanded boundary, including nested boundaries, so the
    /// projection remains structurally legible.
    pub fn project_flatten_depth(
        &self,
        base: &GraphSlice,
        depth: usize,
    ) -> Result<GraphSlice, GraphProjectionError> {
        if depth == 0 {
            return Ok(base.clone());
        }

        let instances: Vec<GraphNode> = base
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::ModuleInstance)
            .cloned()
            .collect();
        let mut projection = base.clone();
        for instance in instances {
            let Some(definition_name) = instance.definition_name.as_deref() else {
                continue;
            };
            let Some(child) = self.definition_slice(definition_name) else {
                continue;
            };
            let child_projection = self.project_flatten_depth(child, depth - 1)?;
            expand_instance(&mut projection, &instance, &child_projection)?;
        }

        sort_projection(&mut projection);
        Ok(projection)
    }

    /// Returns recursive flattening counts without cloning graph bodies. The
    /// caller can enforce projection budgets before composing the graph.
    pub fn flattened_object_counts(
        &self,
        base: &GraphSlice,
        depth: usize,
    ) -> Result<(usize, usize, usize), GraphProjectionError> {
        if depth == 0 {
            return Ok((base.nodes.len(), base.edges.len(), base.groups.len()));
        }
        let mut counts = (base.nodes.len(), base.edges.len(), base.groups.len());
        for instance in base
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::ModuleInstance)
        {
            let Some(definition_name) = instance.definition_name.as_deref() else {
                continue;
            };
            let Some(child) = self.definition_slice(definition_name) else {
                continue;
            };
            let child_counts = self.flattened_object_counts(child, depth - 1)?;
            counts.0 = counts.0.saturating_sub(1).saturating_add(child_counts.0);
            counts.1 = counts.1.saturating_add(child_counts.1);
            counts.2 = counts.2.saturating_add(child_counts.2).saturating_add(1);
        }
        Ok(counts)
    }

    fn definition_slice(&self, definition_name: &str) -> Option<&GraphSlice> {
        self.modules.get(definition_name).or_else(|| {
            self.modules.values().find(|slice| {
                slice.module.name == definition_name
                    || slice.module.definition_name == definition_name
            })
        })
    }
}

fn sort_projection(projection: &mut GraphSlice) {
    projection
        .nodes
        .sort_by(|left, right| left.id.cmp(&right.id));
    projection
        .edges
        .sort_by(|left, right| left.id.cmp(&right.id));
    projection
        .groups
        .sort_by(|left, right| left.id.cmp(&right.id));
    merge_files(&mut projection.files, None);
}

fn expand_instance(
    projection: &mut GraphSlice,
    instance: &GraphNode,
    child: &GraphSlice,
) -> Result<(), GraphProjectionError> {
    let definition_name = instance
        .definition_name
        .as_deref()
        .expect("validated by project_transparent_instances");
    let mut rewired_edges = projection.edges.clone();
    for edge in &mut rewired_edges {
        if edge.target_node == instance.id {
            let parent_port =
                instance_port(instance, edge.target_port.as_deref(), edge, "incoming")?;
            let (boundary_node, boundary_port) = child_boundary(child, &parent_port.name, true)
                .ok_or_else(|| GraphProjectionError::BoundaryPortNotFound {
                    instance_id: instance.id.clone(),
                    definition_name: definition_name.to_owned(),
                    port_name: parent_port.name.clone(),
                    boundary_kind: "input",
                    side: "incoming",
                })?;
            edge.target_node = prefixed_id(&instance.id, &boundary_node.id);
            edge.target_port = Some(prefixed_id(&instance.id, &boundary_port.id));
        }
        if edge.source_node == instance.id {
            let parent_port =
                instance_port(instance, edge.source_port.as_deref(), edge, "outgoing")?;
            let (boundary_node, boundary_port) = child_boundary(child, &parent_port.name, false)
                .ok_or_else(|| GraphProjectionError::BoundaryPortNotFound {
                    instance_id: instance.id.clone(),
                    definition_name: definition_name.to_owned(),
                    port_name: parent_port.name.clone(),
                    boundary_kind: "output",
                    side: "outgoing",
                })?;
            edge.source_node = prefixed_id(&instance.id, &boundary_node.id);
            edge.source_port = Some(prefixed_id(&instance.id, &boundary_port.id));
        }
    }

    let mut child_nodes: Vec<GraphNode> = child
        .nodes
        .iter()
        .cloned()
        .map(|mut node| {
            node.id = prefixed_id(&instance.id, &node.id);
            for port in &mut node.ports {
                port.id = prefixed_id(&instance.id, &port.id);
            }
            node
        })
        .collect();
    let mut child_node_ids: Vec<String> = child_nodes.iter().map(|node| node.id.clone()).collect();
    child_node_ids.sort();
    let child_edges = child.edges.iter().cloned().map(|mut edge| {
        edge.id = prefixed_id(&instance.id, &edge.id);
        edge.source_node = prefixed_id(&instance.id, &edge.source_node);
        edge.source_port = edge
            .source_port
            .map(|port| prefixed_id(&instance.id, &port));
        edge.target_node = prefixed_id(&instance.id, &edge.target_node);
        edge.target_port = edge
            .target_port
            .map(|port| prefixed_id(&instance.id, &port));
        edge
    });
    let child_groups = child.groups.iter().cloned().map(|mut group| {
        group.id = prefixed_id(&instance.id, &group.id);
        group.child_node_ids = group
            .child_node_ids
            .into_iter()
            .map(|id| prefixed_id(&instance.id, &id))
            .collect();
        group
    });

    projection.nodes.retain(|node| node.id != instance.id);
    projection.nodes.append(&mut child_nodes);
    projection.edges = rewired_edges;
    projection.edges.extend(child_edges);
    projection.groups.extend(child_groups);
    projection.groups.push(GraphGroup {
        id: instance.id.clone(),
        name: instance.label.clone(),
        definition_name: definition_name.to_owned(),
        parameters: instance.parameters.clone(),
        origins: instance.origins.clone(),
        child_node_ids,
    });
    merge_files(&mut projection.files, child.files.as_ref());
    Ok(())
}

fn instance_port<'a>(
    instance: &'a GraphNode,
    edge_port: Option<&str>,
    edge: &GraphEdge,
    side: &'static str,
) -> Result<&'a GraphPort, GraphProjectionError> {
    let port_id = edge_port.unwrap_or("<missing>");
    instance
        .ports
        .iter()
        .find(|port| port.id == port_id || port.name == port_id)
        .ok_or_else(|| GraphProjectionError::InstancePortNotFound {
            instance_id: instance.id.clone(),
            edge_id: edge.id.clone(),
            port_id: port_id.to_owned(),
            side,
        })
}

fn child_boundary<'a>(
    child: &'a GraphSlice,
    port_name: &str,
    incoming: bool,
) -> Option<(&'a GraphNode, &'a GraphPort)> {
    child.nodes.iter().find_map(|node| {
        let compatible = if incoming {
            matches!(node.kind, NodeKind::Input | NodeKind::Inout)
        } else {
            matches!(node.kind, NodeKind::Output | NodeKind::Inout)
        };
        if !compatible {
            return None;
        }
        let port = node
            .ports
            .iter()
            .find(|port| port.name == port_name)
            .or_else(|| {
                (node.label == port_name)
                    .then(|| node.ports.first())
                    .flatten()
            })?;
        Some((node, port))
    })
}

fn prefixed_id(instance_id: &str, child_id: &str) -> String {
    format!("{instance_id}/{child_id}")
}

fn merge_files(target: &mut Option<Vec<SourceFileRef>>, additional: Option<&Vec<SourceFileRef>>) {
    if let Some(additional) = additional {
        target
            .get_or_insert_with(Vec::new)
            .extend(additional.clone());
    }
    if let Some(files) = target {
        files.sort_by(|left, right| {
            left.id
                .cmp(&right.id)
                .then_with(|| left.path.cmp(&right.path))
        });
        files.dedup_by(|left, right| left.id == right.id && left.path == right.path);
    }
}

/// Stable, dependency-free FNV-1a identifier. The namespace makes IDs readable
/// while the full semantic key makes recompiles deterministic.
pub fn stable_id(namespace: &str, key: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in namespace.bytes().chain([0xff]).chain(key.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{namespace}-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(id: &str, name: &str, direction: PortDirection) -> GraphPort {
        GraphPort {
            id: id.to_owned(),
            name: name.to_owned(),
            direction,
            index: None,
            role: None,
            width: Some(1),
        }
    }

    fn node(
        id: &str,
        kind: NodeKind,
        label: &str,
        definition_name: Option<&str>,
        ports: Vec<GraphPort>,
    ) -> GraphNode {
        GraphNode {
            id: id.to_owned(),
            kind,
            label: label.to_owned(),
            definition_name: definition_name.map(str::to_owned),
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            ports,
            origins: vec![],
        }
    }

    fn edge(
        id: &str,
        source_node: &str,
        source_port: &str,
        target_node: &str,
        target_port: &str,
    ) -> GraphEdge {
        GraphEdge {
            id: id.to_owned(),
            source_node: source_node.to_owned(),
            source_port: Some(source_port.to_owned()),
            target_node: target_node.to_owned(),
            target_port: Some(target_port.to_owned()),
            label: None,
            width: Some(1),
            signal_type: None,
            origins: vec![],
        }
    }

    fn module(id: &str, name: &str) -> GraphModule {
        GraphModule {
            id: id.to_owned(),
            name: name.to_owned(),
            instance_path: name.to_owned(),
            definition_name: name.to_owned(),
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
        }
    }

    fn hierarchy_snapshot() -> DesignSnapshot {
        let mut instance = node(
            "instance",
            NodeKind::ModuleInstance,
            "u_child",
            Some("child"),
            vec![
                port("instance-a", "a", PortDirection::Input),
                port("instance-y", "y", PortDirection::Output),
            ],
        );
        instance
            .parameters
            .insert("WIDTH".to_owned(), Value::from(8));
        instance.origins.push(SourceOrigin {
            file: "rtl/top.sv".to_owned(),
            start_line: 9,
            start_column: 3,
            end_line: 9,
            end_column: Some(28),
        });
        let parent = GraphSlice {
            snapshot_id: "snapshot".to_owned(),
            module: module("module-top", "top"),
            nodes: vec![
                node(
                    "parent-input",
                    NodeKind::Input,
                    "a",
                    None,
                    vec![port("parent-input-port", "a", PortDirection::Input)],
                ),
                instance,
                node(
                    "parent-output",
                    NodeKind::Output,
                    "y",
                    None,
                    vec![port("parent-output-port", "y", PortDirection::Output)],
                ),
            ],
            edges: vec![
                edge(
                    "parent-in-edge",
                    "parent-input",
                    "parent-input-port",
                    "instance",
                    "instance-a",
                ),
                edge(
                    "parent-out-edge",
                    "instance",
                    "instance-y",
                    "parent-output",
                    "parent-output-port",
                ),
            ],
            groups: vec![],
            files: None,
        };
        let child = GraphSlice {
            snapshot_id: "snapshot".to_owned(),
            module: module("module-child", "child"),
            nodes: vec![
                node(
                    "child-input",
                    NodeKind::Input,
                    "a",
                    None,
                    vec![port("child-input-port", "a", PortDirection::Input)],
                ),
                node(
                    "child-op",
                    NodeKind::Operator,
                    "¬",
                    None,
                    vec![
                        port("child-op-a", "A", PortDirection::Input),
                        port("child-op-y", "Y", PortDirection::Output),
                    ],
                ),
                node(
                    "child-output",
                    NodeKind::Output,
                    "y",
                    None,
                    vec![port("child-output-port", "y", PortDirection::Output)],
                ),
            ],
            edges: vec![
                edge(
                    "child-in-edge",
                    "child-input",
                    "child-input-port",
                    "child-op",
                    "child-op-a",
                ),
                edge(
                    "child-out-edge",
                    "child-op",
                    "child-op-y",
                    "child-output",
                    "child-output-port",
                ),
            ],
            groups: vec![],
            files: None,
        };
        DesignSnapshot {
            snapshot_id: "snapshot".to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([("child".to_owned(), child), ("top".to_owned(), parent)]),
        }
    }

    #[test]
    fn wire_shape_is_camel_case() {
        let slice = GraphSlice {
            snapshot_id: "snap".into(),
            module: GraphModule {
                id: "m".into(),
                name: "top".into(),
                instance_path: "top".into(),
                definition_name: "top".into(),
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
            },
            nodes: vec![],
            edges: vec![],
            groups: vec![],
            files: None,
        };
        let json = serde_json::to_value(slice).unwrap();
        assert_eq!(json["snapshotId"], "snap");
        assert_eq!(json["module"]["instancePath"], "top");
        assert!(json.get("snapshot_id").is_none());
    }

    #[test]
    fn ids_are_stable_and_namespaced() {
        assert_eq!(stable_id("node", "top/a"), stable_id("node", "top/a"));
        assert_ne!(stable_id("node", "top/a"), stable_id("port", "top/a"));
    }

    #[test]
    fn transparent_projection_prefixes_and_reconnects_child_graph() {
        let snapshot = hierarchy_snapshot();
        let base = &snapshot.modules["top"];
        let projected = snapshot
            .project_transparent_instances(base, &["instance".to_owned()])
            .unwrap();
        assert_eq!(
            snapshot
                .projected_object_counts(base, &["instance".to_owned()])
                .unwrap(),
            (
                projected.nodes.len(),
                projected.edges.len(),
                projected.groups.len()
            )
        );

        assert!(!projected.nodes.iter().any(|node| node.id == "instance"));
        assert!(
            projected
                .nodes
                .iter()
                .any(|node| node.id == "instance/child-op")
        );
        assert_eq!(projected.groups.len(), 1);
        assert_eq!(projected.groups[0].id, "instance");
        assert_eq!(projected.groups[0].name, "u_child");
        assert_eq!(projected.groups[0].definition_name, "child");
        assert_eq!(projected.groups[0].parameters["WIDTH"], 8);
        assert_eq!(projected.groups[0].origins[0].file, "rtl/top.sv");
        assert_eq!(
            projected.groups[0].child_node_ids,
            vec![
                "instance/child-input",
                "instance/child-op",
                "instance/child-output"
            ]
        );

        let incoming = projected
            .edges
            .iter()
            .find(|edge| edge.id == "parent-in-edge")
            .unwrap();
        assert_eq!(incoming.target_node, "instance/child-input");
        assert_eq!(
            incoming.target_port.as_deref(),
            Some("instance/child-input-port")
        );
        let outgoing = projected
            .edges
            .iter()
            .find(|edge| edge.id == "parent-out-edge")
            .unwrap();
        assert_eq!(outgoing.source_node, "instance/child-output");
        assert_eq!(
            outgoing.source_port.as_deref(),
            Some("instance/child-output-port")
        );
        let internal = projected
            .edges
            .iter()
            .find(|edge| edge.id == "instance/child-in-edge")
            .unwrap();
        assert_eq!(internal.source_node, "instance/child-input");
        assert_eq!(internal.target_node, "instance/child-op");

        // Projection must not alter the immutable stored module graph.
        assert!(base.nodes.iter().any(|node| node.id == "instance"));
        assert!(base.groups.is_empty());
    }

    #[test]
    fn flatten_depth_expands_all_levels_and_retains_nested_boundaries() {
        let mut snapshot = hierarchy_snapshot();
        let leaf = GraphSlice {
            snapshot_id: "snapshot".to_owned(),
            module: module("module-leaf", "leaf"),
            nodes: vec![
                node(
                    "leaf-input",
                    NodeKind::Input,
                    "a",
                    None,
                    vec![port("leaf-input-port", "a", PortDirection::Input)],
                ),
                node(
                    "leaf-output",
                    NodeKind::Output,
                    "y",
                    None,
                    vec![port("leaf-output-port", "y", PortDirection::Output)],
                ),
            ],
            edges: vec![edge(
                "leaf-edge",
                "leaf-input",
                "leaf-input-port",
                "leaf-output",
                "leaf-output-port",
            )],
            groups: vec![],
            files: None,
        };
        let grandchild = node(
            "grandchild",
            NodeKind::ModuleInstance,
            "u_leaf",
            Some("leaf"),
            vec![
                port("grandchild-a", "a", PortDirection::Input),
                port("grandchild-y", "y", PortDirection::Output),
            ],
        );
        let child = snapshot.modules.get_mut("child").unwrap();
        child.nodes = vec![child.nodes[0].clone(), grandchild, child.nodes[2].clone()];
        child.edges = vec![
            edge(
                "child-in-edge",
                "child-input",
                "child-input-port",
                "grandchild",
                "grandchild-a",
            ),
            edge(
                "child-out-edge",
                "grandchild",
                "grandchild-y",
                "child-output",
                "child-output-port",
            ),
        ];
        snapshot.modules.insert("leaf".to_owned(), leaf);

        let base = &snapshot.modules["top"];
        let depth_one = snapshot.project_flatten_depth(base, 1).unwrap();
        assert!(
            depth_one
                .nodes
                .iter()
                .any(|node| node.id == "instance/grandchild")
        );
        assert_eq!(depth_one.groups.len(), 1);

        let depth_two = snapshot.project_flatten_depth(base, 2).unwrap();
        assert_eq!(
            snapshot.flattened_object_counts(base, 2).unwrap(),
            (
                depth_two.nodes.len(),
                depth_two.edges.len(),
                depth_two.groups.len()
            )
        );
        assert!(
            !depth_two
                .nodes
                .iter()
                .any(|node| node.id == "instance/grandchild")
        );
        assert!(
            depth_two
                .nodes
                .iter()
                .any(|node| node.id == "instance/grandchild/leaf-input")
        );
        assert!(
            depth_two
                .groups
                .iter()
                .any(|group| group.id == "instance/grandchild")
        );
        let parent_group = depth_two
            .groups
            .iter()
            .find(|group| group.id == "instance")
            .unwrap();
        assert!(
            parent_group
                .child_node_ids
                .contains(&"instance/grandchild/leaf-input".to_owned())
        );
    }

    #[test]
    fn flatten_depth_retains_opaque_instances_instead_of_failing_the_projection() {
        let mut snapshot = hierarchy_snapshot();
        snapshot.modules.get_mut("top").unwrap().nodes.push(node(
            "opaque-instance",
            NodeKind::ModuleInstance,
            "u_vendor_ip",
            Some("vendor_ip"),
            vec![],
        ));

        let base = &snapshot.modules["top"];
        let projected = snapshot.project_flatten_depth(base, 1).unwrap();
        assert!(
            projected
                .nodes
                .iter()
                .any(|node| node.id == "opaque-instance")
        );
        assert!(!projected.nodes.iter().any(|node| node.id == "instance"));
        assert_eq!(
            snapshot.flattened_object_counts(base, 1).unwrap(),
            (
                projected.nodes.len(),
                projected.edges.len(),
                projected.groups.len()
            )
        );
    }

    #[test]
    fn transparent_projection_is_deterministic_and_rejects_unknown_ids() {
        let snapshot = hierarchy_snapshot();
        let base = &snapshot.modules["top"];
        let first = snapshot
            .project_transparent_instances(base, &["instance".to_owned(), "instance".to_owned()])
            .unwrap();
        let second = snapshot
            .project_transparent_instances(base, &["instance".to_owned()])
            .unwrap();
        assert_eq!(first, second);

        assert_eq!(
            snapshot
                .project_transparent_instances(base, &["missing".to_owned()])
                .unwrap_err(),
            GraphProjectionError::UnknownInstance {
                instance_id: "missing".to_owned(),
                module: "top".to_owned(),
            }
        );
    }
}
