// SPDX-License-Identifier: Apache-2.0

//! Converts yosys-slang JSON connectivity into deterministic Nettle IR.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::resource_limits::native::yosys_import::ENDPOINT_PAIRS as MAX_ENDPOINT_PAIRS;

use super::model::{
    DesignSnapshot, GraphEdge, GraphModule, GraphNode, GraphPort, GraphSlice, NodeKind,
    PortDirection, SourceFileRef, SourceOrigin, stable_id,
};

#[derive(Debug, Error)]
/// Failure encountered while importing yosys-slang JSON.
pub enum YosysImportError {
    /// Yosys output is not valid JSON.
    #[error("invalid Yosys JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// Yosys output contains no module definitions.
    #[error("Yosys JSON contains no modules")]
    NoModules,
    /// The explicitly requested top module is absent.
    #[error("requested top module {requested:?} is absent (available: {available})")]
    TopNotFound {
        /// Requested top name.
        requested: String,
        /// Comma-separated module names available in the input.
        available: String,
    },
    /// Expanding wire endpoints would require excessive Cartesian-product work.
    #[error("module {module:?} connectivity exceeds the supported endpoint-pair limit {limit}")]
    ConnectivityLimit {
        /// Module whose connectivity exceeded the limit.
        module: String,
        /// Maximum driver-to-sink pairs accepted per module.
        limit: usize,
    },
}

#[derive(Debug, Deserialize)]
struct YosysDesign {
    #[serde(default)]
    modules: BTreeMap<String, YosysModule>,
}

#[derive(Debug, Default, Deserialize)]
struct YosysModule {
    #[serde(default)]
    attributes: BTreeMap<String, Value>,
    #[serde(default)]
    parameter_default_values: BTreeMap<String, Value>,
    #[serde(default)]
    ports: BTreeMap<String, YosysModulePort>,
    #[serde(default)]
    cells: BTreeMap<String, YosysCell>,
    #[serde(default)]
    netnames: BTreeMap<String, YosysNet>,
}

#[derive(Debug, Deserialize)]
struct YosysModulePort {
    direction: String,
    #[serde(default)]
    bits: Vec<YosysBit>,
}

#[derive(Debug, Deserialize)]
struct YosysCell {
    #[serde(default)]
    hide_name: Value,
    #[serde(rename = "type")]
    cell_type: String,
    #[serde(default)]
    parameters: BTreeMap<String, Value>,
    #[serde(default)]
    attributes: BTreeMap<String, Value>,
    #[serde(default)]
    port_directions: BTreeMap<String, String>,
    #[serde(default)]
    connections: BTreeMap<String, Vec<YosysBit>>,
}

#[derive(Debug, Deserialize)]
struct YosysNet {
    #[serde(default)]
    hide_name: Value,
    #[serde(default)]
    bits: Vec<YosysBit>,
    #[serde(default)]
    attributes: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum YosysBit {
    Wire(i64),
    Constant(String),
}

#[derive(Debug, Clone)]
struct Endpoint {
    node: String,
    port: String,
}

#[derive(Debug, Default)]
struct BitEndpoints {
    drivers: Vec<Endpoint>,
    sinks: Vec<Endpoint>,
}

#[derive(Debug, Clone, Default)]
struct NetMetadata {
    label: Option<String>,
    label_priority: u8,
    origins: Vec<SourceOrigin>,
}

#[derive(Debug, Default)]
struct BitAliases {
    parent: HashMap<i64, i64>,
}

impl BitAliases {
    fn canonical(&self, bit: i64) -> i64 {
        let mut current = bit;
        while let Some(parent) = self.parent.get(&current) {
            if *parent == current {
                break;
            }
            current = *parent;
        }
        current
    }

    fn canonical_mut(&mut self, bit: i64) -> i64 {
        let root = self.canonical(bit);
        let mut current = bit;
        while let Some(parent) = self.parent.get(&current).copied() {
            if parent == root {
                break;
            }
            self.parent.insert(current, root);
            current = parent;
        }
        root
    }

    fn union(&mut self, left: i64, right: i64) {
        let left = self.canonical_mut(left);
        let right = self.canonical_mut(right);
        if left == right {
            return;
        }
        let (root, child) = if left < right {
            (left, right)
        } else {
            (right, left)
        };
        self.parent.insert(child, root);
    }

    fn flatten(&mut self) {
        let bits: Vec<i64> = self.parent.keys().copied().collect();
        for bit in bits {
            let root = self.canonical_mut(bit);
            self.parent.insert(bit, root);
        }
    }
}

#[derive(Debug, Default)]
struct BufferAliasPlan {
    aliases: BitAliases,
    elided_cells: BTreeSet<String>,
    preferred_label_bits: BTreeSet<i64>,
    constant_drivers: Vec<ConstantBufferDriver>,
}

#[derive(Debug)]
struct ConstantBufferDriver {
    cell_name: String,
    values: Vec<String>,
    output_bits: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeKey {
    source_node: String,
    source_port: String,
    target_node: String,
    target_port: String,
    label: Option<String>,
}

#[derive(Debug, Default)]
struct EdgeAccumulator {
    width: u32,
    origins: Vec<SourceOrigin>,
}

/// Parses yosys-slang JSON text into a deterministic design snapshot.
pub fn import_yosys_json(
    contents: &str,
    requested_top: Option<&str>,
) -> Result<DesignSnapshot, YosysImportError> {
    let value: Value = serde_json::from_str(contents)?;
    import_yosys_value(value, requested_top)
}

/// Imports an already parsed yosys-slang JSON value into a design snapshot.
pub fn import_yosys_value(
    value: Value,
    requested_top: Option<&str>,
) -> Result<DesignSnapshot, YosysImportError> {
    let snapshot_id = stable_id("snapshot", &value.to_string());
    let design: YosysDesign = serde_json::from_value(value)?;
    if design.modules.is_empty() {
        return Err(YosysImportError::NoModules);
    }

    let name_lookup: BTreeMap<String, String> = design
        .modules
        .keys()
        .map(|raw| (display_name(raw), raw.clone()))
        .collect();
    let mut tops = inferred_tops(&design);
    let top = if let Some(requested) = requested_top {
        if !name_lookup.contains_key(&display_name(requested)) {
            return Err(YosysImportError::TopNotFound {
                requested: requested.to_owned(),
                available: name_lookup.keys().cloned().collect::<Vec<_>>().join(", "),
            });
        }
        display_name(requested)
    } else {
        tops.first()
            .cloned()
            .expect("nonempty module map has an inferred top")
    };
    if !tops.contains(&top) {
        tops.push(top.clone());
        tops.sort();
        tops.dedup();
    }

    let mut modules = BTreeMap::new();
    for (raw_name, module) in &design.modules {
        let name = display_name(raw_name);
        let slice = import_module(&snapshot_id, &name, module)?;
        modules.insert(name, slice);
    }
    Ok(DesignSnapshot {
        snapshot_id,
        top,
        tops,
        modules,
    })
}

fn inferred_tops(design: &YosysDesign) -> Vec<String> {
    let explicit: Vec<String> = design
        .modules
        .iter()
        .filter(|(_, module)| module.attributes.get("top").is_some_and(value_is_true))
        .map(|(name, _)| display_name(name))
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }

    let instantiated: BTreeSet<String> = design
        .modules
        .values()
        .flat_map(|module| module.cells.values())
        .filter(|cell| !cell.cell_type.starts_with('$'))
        .map(|cell| display_name(&cell.cell_type))
        .collect();
    let mut roots: Vec<String> = design
        .modules
        .keys()
        .map(|name| display_name(name))
        .filter(|name| !instantiated.contains(name))
        .collect();
    if roots.is_empty() {
        roots = design
            .modules
            .keys()
            .map(|name| display_name(name))
            .collect();
    }
    roots.sort();
    roots
}

fn import_module(
    snapshot_id: &str,
    name: &str,
    module: &YosysModule,
) -> Result<GraphSlice, YosysImportError> {
    let module_id = stable_id("module", name);
    let module_origins = origins_from_attributes(&module.attributes);
    let mut nodes = Vec::with_capacity(module.ports.len() + module.cells.len());
    let mut bit_endpoints: HashMap<i64, BitEndpoints> = HashMap::new();

    let alias_plan = build_buffer_alias_plan(module);
    let net_metadata = build_net_metadata(
        module,
        &alias_plan.aliases,
        &alias_plan.preferred_label_bits,
    );
    let observed_sink_bits = observed_sink_bits(module);

    for (port_name, module_port) in &module.ports {
        let direction = port_direction(&module_port.direction);
        let node_id = stable_id("node", &format!("{name}/$port/{port_name}"));
        let port_id = stable_id("port", &format!("{node_id}/{port_name}"));
        let graph_port = GraphPort {
            id: port_id.clone(),
            name: display_name(port_name),
            direction,
            index: None,
            role: None,
            width: Some(module_port.bits.len() as u32),
        };
        for bit in &module_port.bits {
            let YosysBit::Wire(bit) = bit else {
                continue;
            };
            let endpoint = Endpoint {
                node: node_id.clone(),
                port: port_id.clone(),
            };
            let endpoints = bit_endpoints
                .entry(alias_plan.aliases.canonical(*bit))
                .or_default();
            match direction {
                PortDirection::Input => endpoints.drivers.push(endpoint),
                PortDirection::Output => endpoints.sinks.push(endpoint),
                PortDirection::Inout | PortDirection::Unknown => {
                    endpoints.drivers.push(endpoint.clone());
                    endpoints.sinks.push(endpoint);
                }
            }
        }
        nodes.push(GraphNode {
            id: node_id,
            kind: match direction {
                PortDirection::Input => NodeKind::Input,
                PortDirection::Output => NodeKind::Output,
                PortDirection::Inout | PortDirection::Unknown => NodeKind::Inout,
            },
            label: display_name(port_name),
            definition_name: None,
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            ports: vec![graph_port],
            origins: origins_for_bits(
                &module_port.bits,
                &alias_plan.aliases,
                &net_metadata,
                &module_origins,
            ),
        });
    }

    for constant in &alias_plan.constant_drivers {
        let node_id = stable_id(
            "node",
            &format!("{name}/{}", display_name(&constant.cell_name)),
        );
        let port_id = stable_id("port", &format!("{node_id}/Y"));
        for bit in &constant.output_bits {
            bit_endpoints
                .entry(alias_plan.aliases.canonical(*bit))
                .or_default()
                .drivers
                .push(Endpoint {
                    node: node_id.clone(),
                    port: port_id.clone(),
                });
        }
        nodes.push(GraphNode {
            id: node_id,
            kind: NodeKind::Constant,
            label: constant_label(&constant.values),
            definition_name: None,
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            ports: vec![GraphPort {
                id: port_id,
                name: "Y".to_owned(),
                direction: PortDirection::Output,
                index: None,
                role: Some("data".to_owned()),
                width: Some(constant.output_bits.len() as u32),
            }],
            origins: vec![],
        });
    }

    let mut constants = vec![];
    for (cell_name, cell) in &module.cells {
        if alias_plan.elided_cells.contains(cell_name)
            || is_unobservable_generated_logic_not(cell, &observed_sink_bits)
        {
            continue;
        }
        let (kind, label, definition_name) = classify_cell(cell_name, &cell.cell_type);
        let origins = origins_from_attributes(&cell.attributes);
        let stage_count = shift_register_stage_count(cell, &alias_plan.aliases);
        let cell_key = format!(
            "{name}/{}/$type/{}",
            display_name(cell_name),
            display_name(&cell.cell_type)
        );
        for stage in 0..stage_count.unwrap_or(1) {
            let node_key = match stage_count {
                Some(_) => format!("{cell_key}/$bit/{stage}"),
                None => cell_key.clone(),
            };
            let node_id = stable_id("node", &node_key);
            let mut ports = Vec::with_capacity(cell.connections.len());
            for (port_name, cell_bits) in &cell.connections {
                let bits = projected_register_bits(cell_bits, stage, stage_count);
                let direction = cell
                    .port_directions
                    .get(port_name)
                    .map(|direction| port_direction(direction))
                    .unwrap_or(PortDirection::Unknown);
                for logical_port in logical_cell_ports(cell, port_name, bits) {
                    let port_id = stable_id("port", &format!("{node_id}/{}", logical_port.name));
                    ports.push(GraphPort {
                        id: port_id.clone(),
                        name: logical_port.name,
                        direction,
                        index: logical_port.index,
                        role: port_role(&cell.cell_type, port_name).map(str::to_owned),
                        width: Some(logical_port.bits.len() as u32),
                    });
                    let accepts_constants = matches!(
                        direction,
                        PortDirection::Input | PortDirection::Inout | PortDirection::Unknown
                    );
                    let mut bit_index = 0;
                    while bit_index < logical_port.bits.len() {
                        match &logical_port.bits[bit_index] {
                            YosysBit::Wire(bit) => {
                                let endpoint = Endpoint {
                                    node: node_id.clone(),
                                    port: port_id.clone(),
                                };
                                let endpoints = bit_endpoints
                                    .entry(alias_plan.aliases.canonical(*bit))
                                    .or_default();
                                match direction {
                                    PortDirection::Input => endpoints.sinks.push(endpoint),
                                    PortDirection::Output => endpoints.drivers.push(endpoint),
                                    PortDirection::Inout | PortDirection::Unknown => {
                                        endpoints.drivers.push(endpoint.clone());
                                        endpoints.sinks.push(endpoint);
                                    }
                                }
                                bit_index += 1;
                            }
                            YosysBit::Constant(_) if accepts_constants => {
                                let start_ordinal = bit_index;
                                let mut values = vec![];
                                while let Some(YosysBit::Constant(value)) =
                                    logical_port.bits.get(bit_index)
                                {
                                    values.push(value.clone());
                                    bit_index += 1;
                                }
                                constants.push(ConstantConnection {
                                    values,
                                    target: Endpoint {
                                        node: node_id.clone(),
                                        port: port_id.clone(),
                                    },
                                    start_ordinal,
                                    origins: origins.clone(),
                                });
                            }
                            YosysBit::Constant(_) => bit_index += 1,
                        }
                    }
                }
            }
            let mut parameters = cell.parameters.clone();
            if let Some(stage_count) = stage_count {
                project_register_parameters(&mut parameters, stage, stage_count);
            }
            nodes.push(GraphNode {
                id: node_id,
                kind,
                label: label.clone(),
                definition_name: definition_name.clone(),
                parameters,
                attributes: cell.attributes.clone(),
                ports,
                origins: origins.clone(),
            });
        }
    }

    validate_endpoint_pair_budget(name, &bit_endpoints)?;
    let mut accumulated: BTreeMap<EdgeKey, EdgeAccumulator> = BTreeMap::new();
    let mut wire_ids: Vec<i64> = bit_endpoints.keys().copied().collect();
    wire_ids.sort_unstable();
    for bit in wire_ids {
        let endpoints = &bit_endpoints[&bit];
        let metadata = net_metadata.get(&bit).cloned().unwrap_or_default();
        for driver in &endpoints.drivers {
            for sink in &endpoints.sinks {
                if driver.node == sink.node && driver.port == sink.port {
                    continue;
                }
                accumulate_edge(
                    &mut accumulated,
                    driver,
                    sink,
                    metadata.label.clone(),
                    &metadata.origins,
                    1,
                );
            }
        }
    }

    for constant in constants {
        let pattern = constant.values.join("");
        let constant_key = format!(
            "{name}/$const/{}/{}/{}/{}",
            constant.target.node, constant.target.port, constant.start_ordinal, pattern
        );
        let node_id = stable_id("node", &constant_key);
        let port_id = stable_id("port", &format!("{node_id}/Y"));
        let width = constant.values.len() as u32;
        nodes.push(GraphNode {
            id: node_id.clone(),
            kind: NodeKind::Constant,
            label: constant_label(&constant.values),
            definition_name: None,
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            ports: vec![GraphPort {
                id: port_id.clone(),
                name: "Y".to_owned(),
                direction: PortDirection::Output,
                index: None,
                role: Some("data".to_owned()),
                width: Some(width),
            }],
            origins: constant.origins.clone(),
        });
        accumulate_edge(
            &mut accumulated,
            &Endpoint {
                node: node_id,
                port: port_id,
            },
            &constant.target,
            None,
            &constant.origins,
            width,
        );
    }

    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    let driver_origins: HashMap<_, _> = nodes
        .iter()
        .filter(|node| !node.origins.is_empty())
        .map(|node| (node.id.as_str(), node.origins.as_slice()))
        .collect();
    let mut edges: Vec<GraphEdge> = accumulated
        .into_iter()
        .map(|(key, accumulator)| {
            let semantic_key = format!(
                "{}/{}/{}/{}/{}",
                key.source_node,
                key.source_port,
                key.target_node,
                key.target_port,
                key.label.as_deref().unwrap_or("")
            );
            let origins = driver_origins
                .get(key.source_node.as_str())
                .copied()
                .unwrap_or(&accumulator.origins)
                .to_vec();
            GraphEdge {
                id: stable_id("edge", &semantic_key),
                source_node: key.source_node,
                source_port: Some(key.source_port),
                target_node: key.target_node,
                target_port: Some(key.target_port),
                label: key.label,
                width: Some(accumulator.width),
                signal_type: None,
                origins,
            }
        })
        .collect();
    edges.sort_by(|left, right| left.id.cmp(&right.id));

    let files: BTreeSet<String> = nodes
        .iter()
        .flat_map(|node| node.origins.iter())
        .chain(edges.iter().flat_map(|edge| edge.origins.iter()))
        .map(|origin| origin.file.clone())
        .collect();
    let files = files
        .into_iter()
        .map(|path| SourceFileRef {
            id: stable_id("file", &path),
            path,
        })
        .collect();

    Ok(GraphSlice {
        snapshot_id: snapshot_id.to_owned(),
        module: GraphModule {
            id: module_id,
            name: name.to_owned(),
            instance_path: name.to_owned(),
            definition_name: name.to_owned(),
            parameters: module.parameter_default_values.clone(),
            attributes: module.attributes.clone(),
        },
        nodes,
        edges,
        groups: vec![],
        files: Some(files),
        elaboration_ranges: vec![],
    })
}

fn validate_endpoint_pair_budget(
    module: &str,
    bit_endpoints: &HashMap<i64, BitEndpoints>,
) -> Result<(), YosysImportError> {
    let mut pairs = 0usize;
    for endpoints in bit_endpoints.values() {
        let bit_pairs = endpoints
            .drivers
            .len()
            .checked_mul(endpoints.sinks.len())
            .ok_or_else(|| YosysImportError::ConnectivityLimit {
                module: module.to_owned(),
                limit: MAX_ENDPOINT_PAIRS,
            })?;
        pairs = pairs
            .checked_add(bit_pairs)
            .filter(|total| *total <= MAX_ENDPOINT_PAIRS)
            .ok_or_else(|| YosysImportError::ConnectivityLimit {
                module: module.to_owned(),
                limit: MAX_ENDPOINT_PAIRS,
            })?;
    }
    Ok(())
}

#[derive(Debug)]
struct ConstantConnection {
    values: Vec<String>,
    target: Endpoint,
    start_ordinal: usize,
    origins: Vec<SourceOrigin>,
}

struct LogicalCellPort<'a> {
    name: String,
    bits: &'a [YosysBit],
    index: Option<u32>,
}

fn constant_label(values_lsb_first: &[String]) -> String {
    let width = values_lsb_first.len();
    let uniform_fill = ["0", "x", "z"].into_iter().find(|candidate| {
        values_lsb_first
            .iter()
            .all(|value| value.eq_ignore_ascii_case(candidate))
    });
    let digits = uniform_fill.map(str::to_owned).unwrap_or_else(|| {
        values_lsb_first
            .iter()
            .rev()
            .map(String::as_str)
            .collect::<String>()
    });
    format!("{width}'b{digits}")
}

fn build_buffer_alias_plan(module: &YosysModule) -> BufferAliasPlan {
    // `proc -noopt` represents simple continuous-assignment aliases as anonymous
    // `$buf` cells. Union wire aliases and replace constant-fed buffers with
    // constant drivers so named nets and origins survive without exposing an
    // implementation-only identity operator.
    let mut plan = BufferAliasPlan::default();
    for (cell_name, cell) in &module.cells {
        let Some((inputs, outputs)) = hidden_sourceless_buffer_connections(cell) else {
            continue;
        };
        if inputs.iter().zip(outputs).all(|(input, output)| {
            matches!((input, output), (YosysBit::Wire(_), YosysBit::Wire(_)))
        }) {
            plan.elided_cells.insert(cell_name.clone());
            for (input, output) in inputs.iter().zip(outputs) {
                let (YosysBit::Wire(input), YosysBit::Wire(output)) = (input, output) else {
                    unreachable!("wire buffer classification was checked above");
                };
                plan.aliases.union(*input, *output);
                plan.preferred_label_bits.insert(*output);
            }
        } else if inputs.iter().zip(outputs).all(|(input, output)| {
            matches!((input, output), (YosysBit::Constant(_), YosysBit::Wire(_)))
        }) {
            plan.elided_cells.insert(cell_name.clone());
            let values = inputs
                .iter()
                .map(|input| {
                    let YosysBit::Constant(value) = input else {
                        unreachable!("constant buffer classification was checked above");
                    };
                    value.clone()
                })
                .collect();
            let output_bits = outputs
                .iter()
                .map(|output| {
                    let YosysBit::Wire(bit) = output else {
                        unreachable!("constant buffer classification was checked above");
                    };
                    plan.preferred_label_bits.insert(*bit);
                    *bit
                })
                .collect();
            plan.constant_drivers.push(ConstantBufferDriver {
                cell_name: cell_name.clone(),
                values,
                output_bits,
            });
        }
    }
    plan.aliases.flatten();
    plan
}

fn hidden_sourceless_buffer_connections(cell: &YosysCell) -> Option<(&[YosysBit], &[YosysBit])> {
    if cell.cell_type != "$buf"
        || !value_is_true(&cell.hide_name)
        || !origins_from_attributes(&cell.attributes).is_empty()
        || cell.connections.len() != 2
    {
        return None;
    }
    let inputs = cell.connections.get("A")?;
    let outputs = cell.connections.get("Y")?;
    if inputs.is_empty()
        || inputs.len() != outputs.len()
        || cell
            .port_directions
            .get("A")
            .is_none_or(|direction| port_direction(direction) != PortDirection::Input)
        || cell
            .port_directions
            .get("Y")
            .is_none_or(|direction| port_direction(direction) != PortDirection::Output)
    {
        return None;
    }
    Some((inputs, outputs))
}

fn observed_sink_bits(module: &YosysModule) -> BTreeSet<i64> {
    let module_sinks = module.ports.values().filter(|port| {
        matches!(
            port_direction(&port.direction),
            PortDirection::Output | PortDirection::Inout | PortDirection::Unknown
        )
    });
    let cell_sinks = module.cells.values().flat_map(|cell| {
        cell.connections
            .iter()
            .filter(|(name, _)| {
                matches!(
                    cell.port_directions
                        .get(*name)
                        .map(|direction| port_direction(direction))
                        .unwrap_or(PortDirection::Unknown),
                    PortDirection::Input | PortDirection::Inout | PortDirection::Unknown
                )
            })
            .map(|(_, bits)| bits.as_slice())
    });
    module_sinks
        .map(|port| port.bits.as_slice())
        .chain(cell_sinks)
        .flatten()
        .filter_map(|bit| match bit {
            YosysBit::Wire(bit) => Some(*bit),
            YosysBit::Constant(_) => None,
        })
        .collect()
}

fn is_unobservable_generated_logic_not(
    cell: &YosysCell,
    observed_sink_bits: &BTreeSet<i64>,
) -> bool {
    // `proc_arst` records active-low reset semantics in *_POLARITY and can leave
    // the anonymous condition cell behind under `-noopt`. It is safe to omit
    // only when the generated output is genuinely unobserved and source-less.
    if cell.cell_type != "$logic_not"
        || !value_is_true(&cell.hide_name)
        || !origins_from_attributes(&cell.attributes).is_empty()
    {
        return false;
    }
    let output_bits: Vec<i64> = cell
        .connections
        .iter()
        .filter(|(name, _)| {
            cell.port_directions
                .get(*name)
                .is_some_and(|direction| port_direction(direction) == PortDirection::Output)
        })
        .flat_map(|(_, bits)| bits)
        .filter_map(|bit| match bit {
            YosysBit::Wire(bit) => Some(*bit),
            YosysBit::Constant(_) => None,
        })
        .collect();
    !output_bits.is_empty()
        && output_bits
            .iter()
            .all(|bit| !observed_sink_bits.contains(bit))
}

fn build_net_metadata(
    module: &YosysModule,
    aliases: &BitAliases,
    preferred_label_bits: &BTreeSet<i64>,
) -> HashMap<i64, NetMetadata> {
    let mut metadata = HashMap::<i64, NetMetadata>::new();
    for (name, net) in &module.netnames {
        let hidden = value_is_true(&net.hide_name);
        let origins = origins_from_attributes(&net.attributes);
        for bit in &net.bits {
            let YosysBit::Wire(bit) = bit else {
                continue;
            };
            let item = metadata.entry(aliases.canonical(*bit)).or_default();
            let priority = u8::from(preferred_label_bits.contains(bit));
            let display_name = display_name(name);
            if !hidden
                && (item.label.is_none()
                    || priority > item.label_priority
                    || (priority == item.label_priority
                        && item
                            .label
                            .as_ref()
                            .is_some_and(|label| display_name.as_str() < label.as_str())))
            {
                item.label = Some(display_name);
                item.label_priority = priority;
            }
            extend_unique_origins(&mut item.origins, &origins);
        }
    }
    metadata
}

fn origins_for_bits(
    bits: &[YosysBit],
    aliases: &BitAliases,
    metadata: &HashMap<i64, NetMetadata>,
    fallback: &[SourceOrigin],
) -> Vec<SourceOrigin> {
    let mut origins = vec![];
    for bit in bits {
        if let YosysBit::Wire(bit) = bit
            && let Some(net) = metadata.get(&aliases.canonical(*bit))
        {
            extend_unique_origins(&mut origins, &net.origins);
        }
    }
    if origins.is_empty() {
        origins.extend_from_slice(fallback);
    }
    origins
}

fn accumulate_edge(
    edges: &mut BTreeMap<EdgeKey, EdgeAccumulator>,
    driver: &Endpoint,
    sink: &Endpoint,
    label: Option<String>,
    origins: &[SourceOrigin],
    width: u32,
) {
    let entry = edges
        .entry(EdgeKey {
            source_node: driver.node.clone(),
            source_port: driver.port.clone(),
            target_node: sink.node.clone(),
            target_port: sink.port.clone(),
            label,
        })
        .or_default();
    entry.width += width;
    extend_unique_origins(&mut entry.origins, origins);
}

fn classify_cell(cell_name: &str, cell_type: &str) -> (NodeKind, String, Option<String>) {
    let kind_and_label = match cell_type {
        "$add" => Some((NodeKind::Operator, "+")),
        "$sub" => Some((NodeKind::Operator, "−")),
        "$xor" | "$reduce_xor" | "$_XOR_" => Some((NodeKind::Operator, "^")),
        "$xnor" | "$reduce_xnor" | "$_XNOR_" => Some((NodeKind::Operator, "~^")),
        "$and" | "$reduce_and" | "$_AND_" => Some((NodeKind::Operator, "&")),
        "$nand" | "$_NAND_" => Some((NodeKind::Operator, "NAND")),
        "$logic_and" => Some((NodeKind::Operator, "&&")),
        "$or" | "$_OR_" => Some((NodeKind::Operator, "|")),
        "$nor" | "$_NOR_" => Some((NodeKind::Operator, "NOR")),
        "$logic_or" => Some((NodeKind::Operator, "||")),
        "$reduce_or" => Some((NodeKind::Operator, "≥1")),
        "$reduce_bool" => Some((NodeKind::Operator, "≠0")),
        "$not" | "$_NOT_" => Some((NodeKind::Operator, "~")),
        "$logic_not" => Some((NodeKind::Operator, "!")),
        "$shl" | "$sshl" => Some((NodeKind::Operator, "≪")),
        "$shr" | "$sshr" => Some((NodeKind::Operator, "≫")),
        "$shift" | "$shiftx" => Some((NodeKind::Operator, "⇆")),
        "$mul" => Some((NodeKind::Operator, "×")),
        "$div" | "$divfloor" => Some((NodeKind::Operator, "÷")),
        "$mod" | "$modfloor" => Some((NodeKind::Operator, "%")),
        "$pow" => Some((NodeKind::Operator, "**")),
        "$eq" | "$eqx" => Some((NodeKind::Operator, "==")),
        "$ne" | "$nex" => Some((NodeKind::Operator, "!=")),
        "$lt" => Some((NodeKind::Operator, "<")),
        "$le" => Some((NodeKind::Operator, "≤")),
        "$gt" => Some((NodeKind::Operator, ">")),
        "$ge" => Some((NodeKind::Operator, "≥")),
        "$neg" => Some((NodeKind::Operator, "−")),
        "$buf" | "$_BUF_" => Some((NodeKind::Operator, "→")),
        "$pos" => Some((NodeKind::Operator, "+")),
        "$concat" => Some((NodeKind::Operator, "{}")),
        "$slice" => Some((NodeKind::Operator, "[]")),
        "$mux" | "$pmux" | "$bmux" | "$demux" => Some((NodeKind::Mux, "MUX")),
        "$dff" | "$dffe" | "$adff" | "$adffe" | "$aldff" | "$aldffe" | "$sdff" | "$sdffe"
        | "$sdffce" => Some((NodeKind::Register, "DFF")),
        "$dlatch" | "$adlatch" => Some((NodeKind::Latch, "LATCH")),
        other if other.starts_with("$mem") => Some((NodeKind::Memory, "MEM")),
        _ => None,
    };
    if let Some((kind, label)) = kind_and_label {
        return (kind, label.to_owned(), None);
    }
    if !cell_type.starts_with('$') {
        return (
            NodeKind::ModuleInstance,
            display_name(cell_name),
            Some(display_name(cell_type)),
        );
    }
    if cell_type.starts_with("$_") {
        return (NodeKind::Primitive, display_name(cell_type), None);
    }
    (NodeKind::Unknown, display_name(cell_type), None)
}

fn port_role(cell_type: &str, port_name: &str) -> Option<&'static str> {
    let port = port_name.trim_start_matches('\\').to_ascii_uppercase();
    match port.as_str() {
        "CLK" | "C" => Some("clock"),
        "ARST" | "SRST" | "ALOAD" | "CLR" | "RESET" | "RST" => Some("reset"),
        "EN" | "E" | "CE" => Some("enable"),
        "S" if matches!(cell_type, "$mux" | "$pmux" | "$bmux" | "$demux") => Some("select"),
        "D" | "AD" | "A" | "B" => Some("data"),
        "Q" | "Y" => Some("data"),
        "ADDR" | "RD_ADDR" | "WR_ADDR" => Some("address"),
        "DATA" | "RD_DATA" | "WR_DATA" => Some("data"),
        _ => None,
    }
}

fn shift_register_stage_count(cell: &YosysCell, aliases: &BitAliases) -> Option<usize> {
    let (NodeKind::Register, _, _) = classify_cell("", &cell.cell_type) else {
        return None;
    };
    let data = connection_bits(cell, "D")?;
    let output = connection_bits(cell, "Q")?;
    if data.len() <= 1 || data.len() != output.len() {
        return None;
    }

    let output_positions: HashMap<i64, usize> = output
        .iter()
        .enumerate()
        .filter_map(|(index, bit)| match bit {
            YosysBit::Wire(bit) => Some((aliases.canonical(*bit), index)),
            YosysBit::Constant(_) => None,
        })
        .collect();
    let crosses_stage_boundary = data.iter().enumerate().any(|(data_index, bit)| {
        let YosysBit::Wire(bit) = bit else {
            return false;
        };
        output_positions
            .get(&aliases.canonical(*bit))
            .is_some_and(|output_index| *output_index != data_index)
    });
    crosses_stage_boundary.then_some(data.len())
}

fn projected_register_bits(
    bits: &[YosysBit],
    stage: usize,
    stage_count: Option<usize>,
) -> &[YosysBit] {
    if stage_count.is_some_and(|width| bits.len() == width) {
        &bits[stage..=stage]
    } else {
        bits
    }
}

fn project_register_parameters(
    parameters: &mut BTreeMap<String, Value>,
    stage: usize,
    stage_count: usize,
) {
    if let Some(width) = parameters.get_mut("WIDTH") {
        *width = match width {
            Value::String(value)
                if value
                    .chars()
                    .all(|character| matches!(character, '0' | '1')) =>
            {
                Value::String(format!("{:0>width$}", "1", width = value.len()))
            }
            Value::String(_) => Value::String("1".to_owned()),
            _ => Value::from(1),
        };
    }

    for parameter_name in ["ARST_VALUE", "SRST_VALUE"] {
        let Some(Value::String(value)) = parameters.get_mut(parameter_name) else {
            continue;
        };
        if value.len() != stage_count
            || !value
                .chars()
                .all(|character| matches!(character.to_ascii_lowercase(), '0' | '1' | 'x' | 'z'))
        {
            continue;
        }
        let bit = char::from(value.as_bytes()[stage_count - stage - 1]);
        *value = bit.to_string();
    }
}

fn logical_cell_ports<'a>(
    cell: &'a YosysCell,
    port_name: &str,
    bits: &'a [YosysBit],
) -> Vec<LogicalCellPort<'a>> {
    let normalized_name = port_name.trim_start_matches('\\').to_ascii_uppercase();
    let split = match (cell.cell_type.as_str(), normalized_name.as_str()) {
        ("$pmux", "B") => connection_bits(cell, "A")
            .and_then(|choices| indexed_port_slices(bits, choices.len(), "B", 1)),
        ("$bmux", "A") => connection_bits(cell, "Y")
            .and_then(|output| indexed_port_slices(bits, output.len(), "A", 0)),
        _ => None,
    };
    split.unwrap_or_else(|| {
        let index = match (cell.cell_type.as_str(), normalized_name.as_str()) {
            ("$pmux", "A") => Some(0),
            ("$pmux", "B") => Some(1),
            _ => behavioral_port_index(&cell.cell_type, port_name),
        };
        vec![LogicalCellPort {
            name: display_name(port_name),
            bits,
            index,
        }]
    })
}

fn connection_bits<'a>(cell: &'a YosysCell, expected_name: &str) -> Option<&'a [YosysBit]> {
    cell.connections
        .iter()
        .find(|(name, _)| {
            name.trim_start_matches('\\')
                .eq_ignore_ascii_case(expected_name)
        })
        .map(|(_, bits)| bits.as_slice())
}

fn indexed_port_slices<'a>(
    bits: &'a [YosysBit],
    choice_width: usize,
    prefix: &str,
    index_base: u32,
) -> Option<Vec<LogicalCellPort<'a>>> {
    if choice_width == 0 || bits.is_empty() || !bits.len().is_multiple_of(choice_width) {
        return None;
    }
    bits.chunks_exact(choice_width)
        .enumerate()
        .map(|(choice, bits)| {
            let choice = u32::try_from(choice).ok()?;
            Some(LogicalCellPort {
                name: format!("{prefix}{choice}"),
                bits,
                index: index_base.checked_add(choice),
            })
        })
        .collect()
}

fn behavioral_port_index(cell_type: &str, port_name: &str) -> Option<u32> {
    let ordered = matches!(
        cell_type,
        "$mux"
            | "$sub"
            | "$shl"
            | "$sshl"
            | "$shr"
            | "$sshr"
            | "$shift"
            | "$shiftx"
            | "$div"
            | "$divfloor"
            | "$mod"
            | "$modfloor"
            | "$pow"
            | "$lt"
            | "$le"
            | "$gt"
            | "$ge"
    );
    if !ordered {
        return None;
    }
    match port_name
        .trim_start_matches('\\')
        .to_ascii_uppercase()
        .as_str()
    {
        "A" => Some(0),
        "B" => Some(1),
        _ => None,
    }
}

fn port_direction(direction: &str) -> PortDirection {
    match direction.to_ascii_lowercase().as_str() {
        "input" => PortDirection::Input,
        "output" => PortDirection::Output,
        "inout" => PortDirection::Inout,
        _ => PortDirection::Unknown,
    }
}

fn display_name(name: &str) -> String {
    name.trim_start_matches('\\').to_owned()
}

fn value_is_true(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().is_some_and(|value| value != 0),
        Value::String(value) => {
            let value = value.trim();
            value == "true"
                || value == "1"
                || (value.chars().all(|ch| matches!(ch, '0' | '1')) && value.contains('1'))
        }
        _ => false,
    }
}

fn origins_from_attributes(attributes: &BTreeMap<String, Value>) -> Vec<SourceOrigin> {
    attributes
        .get("src")
        .and_then(Value::as_str)
        .map(parse_source_attribute)
        .unwrap_or_default()
}

fn parse_source_attribute(source: &str) -> Vec<SourceOrigin> {
    source
        .split('|')
        .filter_map(|part| parse_source_range(part.trim()))
        .collect()
}

fn parse_source_range(source: &str) -> Option<SourceOrigin> {
    let (file, range) = source.rsplit_once(':')?;
    let (start, end) = range.split_once('-').unwrap_or((range, range));
    let (start_line, start_column) = parse_line_column(start)?;
    let (end_line, end_column) = parse_line_column(end).unwrap_or((start_line, start_column));
    Some(SourceOrigin {
        file: file.to_owned(),
        start_line,
        start_column,
        end_line,
        end_column: Some(end_column),
    })
}

fn parse_line_column(value: &str) -> Option<(u32, u32)> {
    let (line, column) = value.split_once('.')?;
    Some((line.parse().ok()?, column.parse().ok()?))
}

fn extend_unique_origins(target: &mut Vec<SourceOrigin>, sources: &[SourceOrigin]) {
    for source in sources {
        if !target.contains(source) {
            target.push(source.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;
    use std::time::Instant;

    const DESIGN: &str = r#"
    {
      "modules": {
        "child": {
          "ports": {"i": {"direction":"input", "bits":[20]}, "o":{"direction":"output","bits":[21]}},
          "cells": {}, "netnames": {}
        },
        "top": {
          "attributes": {"top":"0001", "src":"rtl/top.sv:1.1-20.10"},
          "parameter_default_values": {"WIDTH":"00001000"},
          "ports": {
            "a": {"direction":"input", "bits":[2,3]},
            "clk": {"direction":"input", "bits":[4]},
            "y": {"direction":"output", "bits":[8,9]}
          },
          "cells": {
            "$add$top.sv:4": {
              "type":"$add", "parameters":{"A_WIDTH":"00000010"},
              "attributes":{"src":"rtl/top.sv:4.12-4.17"},
              "port_directions":{"A":"input","B":"input","Y":"output"},
              "connections":{"A":[2,3],"B":["1","0"],"Y":[5,6]}
            },
            "$mux$top.sv:5": {
              "type":"$mux", "parameters":{}, "attributes":{"src":"rtl/top.sv:5.9-5.22"},
              "port_directions":{"A":"input","B":"input","S":"input","Y":"output"},
              "connections":{"A":[5,6],"B":[2,3],"S":[4],"Y":[7,10]}
            },
            "state_ff": {
              "type":"$adff", "parameters":{"WIDTH":"00000010"}, "attributes":{"src":"rtl/top.sv:8.3-10.6"},
              "port_directions":{"CLK":"input","ARST":"input","D":"input","Q":"output"},
              "connections":{"CLK":[4],"ARST":["0"],"D":[7,10],"Q":[8,9]}
            },
            "u_child": {
              "type":"child", "parameters":{"P":"1"}, "attributes":{"src":"rtl/top.sv:12.3-12.30"},
              "port_directions":{"i":"input","o":"output"},
              "connections":{"i":[2],"o":[11]}
            }
          },
          "netnames": {
            "a": {"hide_name":0,"bits":[2,3],"attributes":{"src":"rtl/top.sv:2.15-2.16"}},
            "sum": {"hide_name":0,"bits":[5,6],"attributes":{"src":"rtl/top.sv:4.3-4.6"}},
            "y": {"hide_name":0,"bits":[8,9],"attributes":{"src":"rtl/top.sv:3.16-3.17"}}
          }
        }
      }
    }"#;

    #[test]
    fn rejects_excessive_endpoint_cartesian_products() {
        let endpoint = Endpoint {
            node: "node".to_owned(),
            port: "port".to_owned(),
        };
        let endpoints = HashMap::from([(
            1,
            BitEndpoints {
                drivers: vec![endpoint.clone(); 1_001],
                sinks: vec![endpoint; 1_000],
            },
        )]);
        let error = validate_endpoint_pair_budget("top", &endpoints)
            .unwrap_err()
            .to_string();
        assert!(error.contains("endpoint-pair limit"), "{error}");
    }

    #[test]
    fn imports_common_cells_and_metadata() {
        let snapshot = import_yosys_json(DESIGN, None).unwrap();
        assert_eq!(snapshot.top, "top");
        let graph = &snapshot.modules["top"];
        assert_eq!(graph.module.parameters["WIDTH"], "00001000");
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.kind == NodeKind::Operator)
        );
        let mux = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Mux)
            .unwrap();
        assert_eq!(
            mux.ports
                .iter()
                .find(|port| port.name == "A")
                .unwrap()
                .index,
            Some(0)
        );
        assert_eq!(
            mux.ports
                .iter()
                .find(|port| port.name == "B")
                .unwrap()
                .index,
            Some(1)
        );
        let register = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Register)
            .unwrap();
        assert!(
            register
                .ports
                .iter()
                .any(|port| port.role.as_deref() == Some("clock"))
        );
        assert!(
            register
                .ports
                .iter()
                .any(|port| port.role.as_deref() == Some("reset"))
        );
        let instance = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::ModuleInstance)
            .unwrap();
        assert_eq!(instance.definition_name.as_deref(), Some("child"));
        assert_eq!(instance.parameters["P"], "1");
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.label.as_deref() == Some("sum"))
        );
        assert!(graph.edges.iter().any(|edge| edge.width == Some(2)));
        assert!(
            graph
                .files
                .as_ref()
                .unwrap()
                .iter()
                .any(|file| file.path == "rtl/top.sv")
        );
    }

    #[test]
    fn expands_packed_priority_mux_choices_into_ordered_ports() {
        let design = r#"{
          "modules": {"top": {
            "attributes": {"top": "1"},
            "ports": {
              "default_i": {"direction": "input", "bits": [2, 3]},
              "choice_0_i": {"direction": "input", "bits": [4, 5]},
              "choice_1_i": {"direction": "input", "bits": [6, 7]},
              "choice_2_i": {"direction": "input", "bits": [8, 9]},
              "select_i": {"direction": "input", "bits": [10, 11, 12]},
              "result_o": {"direction": "output", "bits": [13, 14]}
            },
            "cells": {"case_mux": {
              "type": "$pmux",
              "parameters": {"WIDTH": "2", "S_WIDTH": "3"},
              "attributes": {"src": "rtl/top.sv:8.3-14.10"},
              "port_directions": {"A": "input", "B": "input", "S": "input", "Y": "output"},
              "connections": {
                "A": [2, 3],
                "B": [4, 5, 6, 7, 8, 9],
                "S": [10, 11, 12],
                "Y": [13, 14]
              }
            }},
            "netnames": {}
          }}
        }"#;
        let snapshot = import_yosys_json(design, None).unwrap();
        let graph = &snapshot.modules["top"];
        let mux = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Mux)
            .unwrap();
        let data_inputs: Vec<_> = mux
            .ports
            .iter()
            .filter(|port| {
                port.direction == PortDirection::Input && port.role.as_deref() == Some("data")
            })
            .collect();

        assert_eq!(
            data_inputs
                .iter()
                .map(|port| (port.name.as_str(), port.index, port.width))
                .collect::<Vec<_>>(),
            vec![
                ("A", Some(0), Some(2)),
                ("B0", Some(1), Some(2)),
                ("B1", Some(2), Some(2)),
                ("B2", Some(3), Some(2)),
            ]
        );
        assert!(
            mux.ports
                .iter()
                .any(|port| port.name == "S" && port.role.as_deref() == Some("select"))
        );
        let target_ports: BTreeSet<_> = graph
            .edges
            .iter()
            .filter(|edge| edge.target_node == mux.id)
            .filter_map(|edge| edge.target_port.as_deref())
            .collect();
        assert_eq!(target_ports.len(), 5);
        assert!(
            data_inputs
                .iter()
                .all(|port| target_ports.contains(port.id.as_str()))
        );
    }

    #[test]
    fn import_is_deterministic() {
        let first = import_yosys_json(DESIGN, Some("top")).unwrap();
        let second = import_yosys_json(DESIGN, Some("top")).unwrap();
        assert_eq!(first.snapshot_id, second.snapshot_id);
        assert_eq!(first.modules["top"], second.modules["top"]);
    }

    #[test]
    fn cell_node_ids_include_cell_type() {
        let import_operator_id = |cell_type: &str| {
            let design = serde_json::json!({
                "modules": {
                    "top": {
                        "attributes": {"top": 1},
                        "ports": {
                            "a": {"direction": "input", "bits": [2]},
                            "b": {"direction": "input", "bits": [3]},
                            "y": {"direction": "output", "bits": [4]}
                        },
                        "cells": {
                            "same_cell": {
                                "type": cell_type,
                                "parameters": {},
                                "attributes": {"src": "rtl/top.sv:3.3-3.20"},
                                "port_directions": {
                                    "A": "input",
                                    "B": "input",
                                    "Y": "output"
                                },
                                "connections": {"A": [2], "B": [3], "Y": [4]}
                            }
                        },
                        "netnames": {}
                    }
                }
            });
            import_yosys_value(design, Some("top")).unwrap().modules["top"]
                .nodes
                .iter()
                .find(|node| node.kind == NodeKind::Operator)
                .unwrap()
                .id
                .clone()
        };

        let add_id = import_operator_id("$add");
        let subtract_id = import_operator_id("$sub");

        assert_ne!(add_id, subtract_id);
        assert_eq!(add_id, stable_id("node", "top/same_cell/$type/$add"));
        assert_eq!(subtract_id, stable_id("node", "top/same_cell/$type/$sub"));
    }

    #[test]
    fn indexes_only_order_dependent_binary_operands() {
        assert_eq!(behavioral_port_index("$sub", "A"), Some(0));
        assert_eq!(behavioral_port_index("$sub", "B"), Some(1));
        assert_eq!(behavioral_port_index("$mux", "A"), Some(0));
        assert_eq!(behavioral_port_index("$mux", "B"), Some(1));
        assert_eq!(behavioral_port_index("$pmux", "B"), None);
        assert_eq!(behavioral_port_index("$add", "A"), None);
        assert_eq!(behavioral_port_index("$sub", "Y"), None);
    }

    #[test]
    fn classifies_common_internal_boolean_gates_as_operators() {
        for (cell_type, glyph) in [
            ("$_AND_", "&"),
            ("$_OR_", "|"),
            ("$_XOR_", "^"),
            ("$_XNOR_", "~^"),
            ("$_NAND_", "NAND"),
            ("$_NOR_", "NOR"),
            ("$_NOT_", "~"),
            ("$_BUF_", "→"),
        ] {
            let (kind, label, definition) = classify_cell("gate", cell_type);
            assert_eq!(kind, NodeKind::Operator);
            assert_eq!(label, glyph);
            assert_eq!(definition, None);
        }
    }

    #[test]
    fn reports_missing_top() {
        let error = import_yosys_json(DESIGN, Some("missing")).unwrap_err();
        assert!(matches!(error, YosysImportError::TopNotFound { .. }));
    }

    #[test]
    fn parses_windows_source_paths_from_the_right() {
        assert_eq!(
            parse_source_range("C:/rtl/top.sv:12.3-14.9").unwrap(),
            SourceOrigin {
                file: "C:/rtl/top.sv".into(),
                start_line: 12,
                start_column: 3,
                end_line: 14,
                end_column: Some(9),
            }
        );
    }

    #[test]
    fn recognizes_yosys_slang_async_load_registers() {
        let (kind, label, _) = classify_cell("state", "$aldff");
        assert_eq!(kind, NodeKind::Register);
        assert_eq!(label, "DFF");
        assert_eq!(port_role("$aldff", "ALOAD"), Some("reset"));
        assert_eq!(port_role("$aldff", "AD"), Some("data"));
    }

    #[test]
    fn expands_vector_registers_with_internal_shift_connectivity() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
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
                            "attributes": {"src": "rtl/top.sv:10.3-15.6"},
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
                            "attributes": {"src": "rtl/top.sv:9.13-9.17"}
                        }
                    }
                }
            }
        });
        let graph = &import_yosys_value(design, Some("top")).unwrap().modules["top"];
        let registers: Vec<_> = graph
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Register)
            .collect();
        let register_ids: BTreeSet<_> = registers.iter().map(|node| node.id.as_str()).collect();
        let expected_register_ids: BTreeSet<_> = (0..4)
            .map(|stage| {
                stable_id(
                    "node",
                    &format!("top/$driver$pipe/$type/$aldff/$bit/{stage}"),
                )
            })
            .collect();
        let pipeline_edges: Vec<_> = graph
            .edges
            .iter()
            .filter(|edge| {
                register_ids.contains(edge.source_node.as_str())
                    && register_ids.contains(edge.target_node.as_str())
            })
            .collect();

        assert_eq!(registers.len(), 4);
        assert_eq!(
            registers
                .iter()
                .map(|node| node.id.clone())
                .collect::<BTreeSet<_>>(),
            expected_register_ids
        );
        assert!(registers.iter().all(|register| {
            register.parameters["WIDTH"] == "00000000000000000000000000000001"
                && register
                    .ports
                    .iter()
                    .filter(|port| matches!(port.name.as_str(), "D" | "Q" | "AD"))
                    .all(|port| port.width == Some(1))
        }));
        assert_eq!(pipeline_edges.len(), 3);
        assert!(pipeline_edges.iter().all(|edge| {
            edge.source_node != edge.target_node
                && edge.width == Some(1)
                && edge.label.as_deref() == Some("pipe")
        }));
        assert!(graph.edges.iter().any(|edge| {
            graph
                .nodes
                .iter()
                .find(|node| node.id == edge.source_node)
                .is_some_and(|node| node.label == "accept")
                && register_ids.contains(edge.target_node.as_str())
        }));
        assert!(graph.edges.iter().any(|edge| {
            register_ids.contains(edge.source_node.as_str())
                && graph
                    .nodes
                    .iter()
                    .find(|node| node.id == edge.target_node)
                    .is_some_and(|node| node.label == "ready")
        }));
    }

    #[test]
    fn keeps_wide_registers_grouped_without_internal_shift_connectivity() {
        let aliases = BitAliases::default();
        let cell: YosysCell = serde_json::from_value(serde_json::json!({
            "type": "$dff",
            "parameters": {"WIDTH": "00000100"},
            "port_directions": {"CLK": "input", "D": "input", "Q": "output"},
            "connections": {"CLK": [2], "D": [4, 5, 6, 7], "Q": [10, 11, 12, 13]}
        }))
        .unwrap();

        assert_eq!(shift_register_stage_count(&cell, &aliases), None);
    }

    #[test]
    fn projects_vector_reset_parameters_in_lsb_first_stage_order() {
        let original = BTreeMap::from([
            (
                "WIDTH".to_owned(),
                Value::String("00000000000000000000000000000100".to_owned()),
            ),
            ("ARST_VALUE".to_owned(), Value::String("1010".to_owned())),
            ("SRST_VALUE".to_owned(), Value::String("0x1z".to_owned())),
            ("CLK_POLARITY".to_owned(), Value::String("1".to_owned())),
        ]);
        let mut projected = vec![];
        for stage in 0..4 {
            let mut parameters = original.clone();
            project_register_parameters(&mut parameters, stage, 4);
            projected.push(parameters);
        }

        assert_eq!(
            projected
                .iter()
                .map(|parameters| parameters["ARST_VALUE"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["0", "1", "0", "1"]
        );
        assert_eq!(
            projected
                .iter()
                .map(|parameters| parameters["SRST_VALUE"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["z", "1", "x", "0"]
        );
        assert!(projected.iter().all(|parameters| {
            parameters["WIDTH"] == "00000000000000000000000000000001"
                && parameters["CLK_POLARITY"] == "1"
        }));
    }

    #[test]
    fn path_compresses_long_buffer_alias_chains() {
        let mut aliases = BitAliases::default();
        for bit in (3..=10_002).rev() {
            aliases.union(bit, bit - 1);
        }
        aliases.flatten();

        assert_eq!(aliases.canonical(10_002), 2);
        assert!(aliases.parent.values().all(|parent| *parent == 2));
    }

    #[test]
    fn collapses_generated_buffer_aliases_and_drops_the_dead_reset_condition() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {
                        "clk": {"direction": "input", "bits": [2]},
                        "rst_n": {"direction": "input", "bits": [3]},
                        "data": {"direction": "input", "bits": [4, 5]},
                        "select": {"direction": "input", "bits": [6]},
                        "q": {"direction": "output", "bits": [20, 21]},
                        "tap": {"direction": "output", "bits": [36, 37]}
                    },
                    "cells": {
                        "$0": {
                            "hide_name": 1,
                            "type": "$add",
                            "parameters": {"A_WIDTH": "2", "B_WIDTH": "2", "Y_WIDTH": "2"},
                            "attributes": {"src": "rtl/top.sv:16.16-16.21"},
                            "port_directions": {"A": "input", "B": "input", "Y": "output"},
                            "connections": {"A": [4, 5], "B": [4, 5], "Y": [30, 31]}
                        },
                        "$1": {
                            "hide_name": 1,
                            "type": "$buf",
                            "parameters": {"WIDTH": "2"},
                            "attributes": {},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [30, 31], "Y": [32, 33]}
                        },
                        "$2": {
                            "hide_name": 1,
                            "type": "$mux",
                            "parameters": {"WIDTH": "2"},
                            "attributes": {"src": "rtl/top.sv:17.21-17.37"},
                            "port_directions": {"A": "input", "B": "input", "S": "input", "Y": "output"},
                            "connections": {"A": [4, 5], "B": [32, 33], "S": [6], "Y": [34, 35]}
                        },
                        "$3": {
                            "hide_name": 1,
                            "type": "$buf",
                            "parameters": {"WIDTH": "2"},
                            "attributes": {},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [34, 35], "Y": [36, 37]}
                        },
                        "$5": {
                            "hide_name": 1,
                            "type": "$logic_not",
                            "parameters": {"A_WIDTH": "1", "Y_WIDTH": "1"},
                            "attributes": {},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [3], "Y": [40]}
                        },
                        "$driver$q": {
                            "hide_name": 1,
                            "type": "$aldff",
                            "parameters": {"ALOAD_POLARITY": "0", "CLK_POLARITY": "1", "WIDTH": "2"},
                            "attributes": {"src": "rtl/top.sv:19.3-24.6"},
                            "port_directions": {"AD": "input", "ALOAD": "input", "CLK": "input", "D": "input", "Q": "output"},
                            "connections": {"AD": ["0", "0"], "ALOAD": [3], "CLK": [2], "D": [36, 37], "Q": [20, 21]}
                        }
                    },
                    "netnames": {
                        "clk": {"hide_name": 0, "bits": [2], "attributes": {"src": "rtl/top.sv:6.27-6.30"}},
                        "rst_n": {"hide_name": 0, "bits": [3], "attributes": {"src": "rtl/top.sv:7.27-7.32"}},
                        "data": {"hide_name": 0, "bits": [4, 5], "attributes": {"src": "rtl/top.sv:8.27-8.31"}},
                        "select": {"hide_name": 0, "bits": [6], "attributes": {"src": "rtl/top.sv:10.27-10.33"}},
                        "sum": {"hide_name": 0, "bits": [32, 33], "attributes": {"src": "rtl/top.sv:16.3-16.6"}},
                        "selected": {"hide_name": 0, "bits": [36, 37], "attributes": {"src": "rtl/top.sv:17.3-17.11"}},
                        "q": {"hide_name": 0, "bits": [20, 21], "attributes": {"src": "rtl/top.sv:11.28-11.29"}}
                    }
                }
            }
        });
        let graph = &import_yosys_value(design, Some("top")).unwrap().modules["top"];

        assert!(
            graph
                .nodes
                .iter()
                .all(|node| node.label != "→" && node.label != "!")
        );
        let add = graph.nodes.iter().find(|node| node.label == "+").unwrap();
        let mux = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Mux)
            .unwrap();
        let tap = graph.nodes.iter().find(|node| node.label == "tap").unwrap();
        let reset = graph
            .nodes
            .iter()
            .find(|node| node.label == "rst_n")
            .unwrap();
        let register = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Register)
            .unwrap();
        let data_port = register.ports.iter().find(|port| port.name == "D").unwrap();
        let reset_port = register
            .ports
            .iter()
            .find(|port| port.role.as_deref() == Some("reset"))
            .unwrap();
        let sum_edge = graph
            .edges
            .iter()
            .find(|edge| edge.source_node == add.id && edge.target_node == mux.id)
            .unwrap();
        assert_eq!(sum_edge.width, Some(2));
        assert_eq!(sum_edge.label.as_deref(), Some("sum"));
        assert_eq!(sum_edge.origins[0].start_line, 16);
        assert_eq!(sum_edge.origins[0].start_column, 16);
        assert_eq!(sum_edge.origins[0].end_column, Some(21));
        let selected_edge = graph
            .edges
            .iter()
            .find(|edge| {
                edge.source_node == mux.id
                    && edge.target_node == register.id
                    && edge.target_port.as_deref() == Some(data_port.id.as_str())
            })
            .unwrap();
        assert_eq!(selected_edge.width, Some(2));
        assert_eq!(selected_edge.label.as_deref(), Some("selected"));
        assert_eq!(selected_edge.origins[0].start_line, 17);
        assert_eq!(selected_edge.origins[0].start_column, 21);
        assert_eq!(selected_edge.origins[0].end_column, Some(37));
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.source_node == mux.id && edge.target_node == tap.id)
        );
        assert!(graph.edges.iter().any(|edge| {
            edge.source_node == reset.id
                && edge.target_node == register.id
                && edge.target_port.as_deref() == Some(reset_port.id.as_str())
        }));
        assert_eq!(register.parameters["ALOAD_POLARITY"], "0");
        assert_eq!(
            graph
                .nodes
                .iter()
                .filter(|node| node.kind == NodeKind::Constant)
                .count(),
            1
        );
    }

    #[test]
    fn contracts_hidden_constant_buffers_into_named_constant_drivers() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {
                        "o": {"direction": "output", "bits": [2, 3, 4]}
                    },
                    "cells": {
                        "$constant_buf": {
                            "hide_name": 1,
                            "type": "$buf",
                            "parameters": {"WIDTH": "3"},
                            "attributes": {},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": ["0", "1", "x"], "Y": [2, 3, 4]}
                        }
                    },
                    "netnames": {
                        "tied_value": {
                            "hide_name": 0,
                            "bits": [2, 3, 4],
                            "attributes": {"src": "rtl/top.sv:2.15-2.25"}
                        }
                    }
                }
            }
        });
        let graph = &import_yosys_value(design, Some("top")).unwrap().modules["top"];
        assert!(graph.nodes.iter().all(|node| node.label != "→"));
        let constant = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Constant)
            .unwrap();
        assert_eq!(constant.label, "3'bx10");
        assert_eq!(constant.ports[0].width, Some(3));
        let edge = graph
            .edges
            .iter()
            .find(|edge| edge.source_node == constant.id)
            .unwrap();
        assert_eq!(edge.label.as_deref(), Some("tied_value"));
        assert_eq!(edge.width, Some(3));
        assert_eq!(edge.origins[0].start_line, 2);
    }

    #[test]
    fn retains_source_visible_buffers() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {
                        "i": {"direction": "input", "bits": [2]},
                        "o": {"direction": "output", "bits": [3]}
                    },
                    "cells": {
                        "$visible_buf": {
                            "hide_name": 1,
                            "type": "$buf",
                            "parameters": {"WIDTH": "1"},
                            "attributes": {"src": "rtl/top.sv:4.10-4.20"},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [3]}
                        }
                    },
                    "netnames": {}
                }
            }
        });
        let graph = &import_yosys_value(design, Some("top")).unwrap().modules["top"];
        let buffer = graph.nodes.iter().find(|node| node.label == "→").unwrap();
        assert_eq!(buffer.origins[0].file, "rtl/top.sv");
        assert!(graph.edges.iter().any(|edge| edge.target_node == buffer.id));
        assert!(graph.edges.iter().any(|edge| edge.source_node == buffer.id));
    }

    #[test]
    fn coalesces_a_wide_constant_cell_port_into_one_node_and_edge() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {},
                    "cells": {
                        "state": {
                            "type": "$aldff",
                            "parameters": {"WIDTH": "9"},
                            "attributes": {"src": "rtl/top.sv:4.3-4.30"},
                            "port_directions": {"AD": "input"},
                            "connections": {
                                "AD": ["0", "0", "0", "0", "0", "0", "0", "0", "0"]
                            }
                        }
                    },
                    "netnames": {}
                }
            }
        });
        let serialized = serde_json::to_string(&design).unwrap();
        let first = import_yosys_json(&serialized, Some("top")).unwrap();
        let second = import_yosys_json(&serialized, Some("top")).unwrap();
        let graph = &first.modules["top"];
        let constants: Vec<&GraphNode> = graph
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Constant)
            .collect();
        assert_eq!(constants.len(), 1);
        assert_eq!(constants[0].label, "9'b0");
        assert_eq!(constants[0].ports[0].width, Some(9));
        let edge = graph
            .edges
            .iter()
            .find(|edge| edge.source_node == constants[0].id)
            .unwrap();
        assert_eq!(edge.width, Some(9));
        assert_eq!(edge.origins[0].start_line, 4);
        assert_eq!(edge.origins[0].start_column, 3);
        let second_constant = second.modules["top"]
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Constant)
            .unwrap();
        assert_eq!(constants[0].id, second_constant.id);
    }

    #[test]
    fn keeps_noncontiguous_constant_runs_separate_and_preserves_xz() {
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {
                        "i": {"direction": "input", "bits": [2, 3]}
                    },
                    "cells": {
                        "probe": {
                            "type": "$probe",
                            "parameters": {},
                            "attributes": {},
                            "port_directions": {"A": "input"},
                            "connections": {
                                "A": [2, "0", "1", 3, "x", "z"]
                            }
                        }
                    },
                    "netnames": {}
                }
            }
        });
        let graph = &import_yosys_value(design, Some("top")).unwrap().modules["top"];
        let mut constants: Vec<&GraphNode> = graph
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Constant)
            .collect();
        constants.sort_by(|left, right| left.label.cmp(&right.label));
        assert_eq!(constants.len(), 2);
        assert_eq!(constants[0].label, "2'b10");
        assert_eq!(constants[1].label, "2'bzx");
        assert!(constants.iter().all(|node| node.ports[0].width == Some(2)));
        let mut widths: Vec<u32> = graph
            .edges
            .iter()
            .filter(|edge| constants.iter().any(|node| node.id == edge.source_node))
            .filter_map(|edge| edge.width)
            .collect();
        widths.sort_unstable();
        assert_eq!(widths, vec![2, 2]);
    }

    /// Manual backend throughput check. Run with:
    /// `cargo test --release benchmark_import -- --ignored --nocapture`
    #[test]
    #[ignore = "manual microbenchmark"]
    fn benchmark_imports_a_ten_thousand_cell_chain() {
        const CELL_COUNT: usize = 10_000;
        const ITERATIONS: usize = 5;

        let mut cells = serde_json::Map::new();
        for index in 0..CELL_COUNT {
            cells.insert(
                format!("not_{index}"),
                serde_json::json!({
                    "type": "$not",
                    "parameters": {"A_WIDTH": "1", "Y_WIDTH": "1"},
                    "attributes": {},
                    "port_directions": {"A": "input", "Y": "output"},
                    "connections": {"A": [index + 2], "Y": [index + 3]}
                }),
            );
        }
        let design = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1},
                    "ports": {
                        "i": {"direction": "input", "bits": [2]},
                        "o": {"direction": "output", "bits": [CELL_COUNT + 2]}
                    },
                    "cells": cells,
                    "netnames": {}
                }
            }
        });
        let serialized = serde_json::to_string(&design).unwrap();
        let warm = import_yosys_json(&serialized, Some("top")).unwrap();
        assert_eq!(warm.modules["top"].nodes.len(), CELL_COUNT + 2);
        assert_eq!(warm.modules["top"].edges.len(), CELL_COUNT + 1);

        let start = Instant::now();
        for _ in 0..ITERATIONS {
            black_box(import_yosys_json(&serialized, Some("top")).unwrap());
        }
        let elapsed = start.elapsed();
        let mean_ms = elapsed.as_secs_f64() * 1_000.0 / ITERATIONS as f64;
        println!(
            "imported {CELL_COUNT} cells and {} edges in {mean_ms:.2} ms mean ({ITERATIONS} iterations)",
            CELL_COUNT + 1
        );
    }
}
