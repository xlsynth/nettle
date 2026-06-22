// SPDX-License-Identifier: Apache-2.0

//! Adds Slang parameters, types, and source provenance to Nettle IR.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use thiserror::Error;

use super::{DesignSnapshot, GraphSlice, NodeKind, SourceFileRef, SourceOrigin, stable_id};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
/// Counts metadata merged from one elaborated Slang AST.
pub struct SlangParameterMergeReport {
    /// Module definitions whose concrete parameters were updated.
    pub modules_updated: usize,
    /// Instance nodes whose concrete parameters were updated.
    pub instances_updated: usize,
    /// Slang instances that could not be matched to the Yosys graph.
    pub instances_unmatched: usize,
    /// Design boundary nodes whose source origins were updated.
    pub ports_updated: usize,
    /// Signal edges whose type or source origin was updated.
    pub net_edges_updated: usize,
}

#[derive(Debug, Error)]
/// Failure encountered while reading Slang semantic metadata.
pub enum SlangMetadataError {
    /// Slang AST output is not valid JSON.
    #[error("invalid Slang AST JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// The AST lacks an elaborated instance matching the selected top.
    #[error("Slang AST JSON does not contain an elaborated design instance")]
    MissingDesignInstance,
    /// Conflicting serialized nodes claim the same process-local Slang address.
    #[error("Slang AST JSON contains conflicting definitions for node address {0}")]
    DuplicateNodeAddress(u64),
    /// A serialized node link refers to an address absent from the document.
    #[error("Slang AST JSON contains a dangling node address link {0}")]
    DanglingNodeAddress(u64),
}

/// Resolves process-local node links from Slang v10 and newer.
///
/// Slang serializes an AST node once with an integer `addr` field. Later
/// references can be strings such as `"123456 child"`. These addresses mean
/// nothing outside that JSON document, so the resolver indexes the whole
/// document and resolves every link before traversing metadata. Inline objects
/// from older Slang releases pass through unchanged.
///
/// This follows the compatibility approach independently discovered in
/// [xlsynth/slang-rs#39](https://github.com/xlsynth/slang-rs/pull/39), without
/// taking a runtime or build dependency on `slang-rs`.
///
/// TODO: Revisit sharing this compatibility layer with `slang-rs` once its AST
/// JSON API and Slang-version policy are a suitable dependency boundary.
struct AstAddressResolver<'a> {
    by_address: BTreeMap<u64, &'a Value>,
}

impl<'a> AstAddressResolver<'a> {
    fn new(root: &'a Value) -> Result<Self, SlangMetadataError> {
        let mut by_address = BTreeMap::new();
        Self::index(root, &mut by_address)?;
        Ok(Self { by_address })
    }

    fn index(
        value: &'a Value,
        by_address: &mut BTreeMap<u64, &'a Value>,
    ) -> Result<(), SlangMetadataError> {
        match value {
            Value::Object(object) => {
                if let Some(address) = object.get("addr").and_then(Value::as_u64) {
                    if let Some(existing) = by_address.get(&address) {
                        if *existing != value {
                            return Err(SlangMetadataError::DuplicateNodeAddress(address));
                        }
                    } else {
                        by_address.insert(address, value);
                    }
                }
                for child in object.values() {
                    Self::index(child, by_address)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    Self::index(child, by_address)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn resolve(&self, value: &'a Value) -> Result<&'a Value, SlangMetadataError> {
        let Some(address) = value.as_str().and_then(address_link) else {
            return Ok(value);
        };
        self.by_address
            .get(&address)
            .copied()
            .ok_or(SlangMetadataError::DanglingNodeAddress(address))
    }

    fn body(
        &self,
        instance: &'a serde_json::Map<String, Value>,
    ) -> Result<Option<&'a Value>, SlangMetadataError> {
        instance
            .get("body")
            .map(|body| self.resolve(body))
            .transpose()
    }
}

fn address_link(text: &str) -> Option<u64> {
    let split = text.find(char::is_whitespace)?;
    let (address, display_name) = text.split_at(split);
    if address.is_empty()
        || !address.bytes().all(|byte| byte.is_ascii_digit())
        || display_name.trim().is_empty()
    {
        return None;
    }
    address.parse().ok()
}

/// Merges elaborated parameters and precise source ranges from Slang's AST JSON
/// into a graph imported from yosys-slang.
///
/// Yosys remains authoritative for connectivity. Slang supplies source-level
/// parameter values because yosys-slang can emit empty parameter maps for
/// hierarchy-specialized instances. Slang also supplies declarations and
/// assignment right-hand-side ranges when Yosys omits source data from module
/// port netnames. Exact Slang driver ranges take priority over Yosys cell
/// ranges; declarations are the final fallback. Unmatched instances are
/// counted, not rejected, because Slang also emits non-synthesized hierarchy.
pub fn merge_slang_instance_parameters(
    snapshot: &mut DesignSnapshot,
    ast_json: &str,
) -> Result<SlangParameterMergeReport, SlangMetadataError> {
    let ast: Value = serde_json::from_str(ast_json)?;
    let resolver = AstAddressResolver::new(&ast)?;
    let root = find_root_instance(&ast, &snapshot.top, &resolver)?
        .ok_or(SlangMetadataError::MissingDesignInstance)?;
    let root_key = snapshot
        .modules
        .contains_key(&snapshot.top)
        .then(|| snapshot.top.clone())
        .or_else(|| {
            root.get("name")
                .and_then(Value::as_str)
                .filter(|name| snapshot.modules.contains_key(*name))
                .map(str::to_owned)
        })
        .ok_or(SlangMetadataError::MissingDesignInstance)?;

    let mut report = SlangParameterMergeReport::default();
    merge_instance(snapshot, root, &root_key, &resolver, &mut report)?;
    Ok(report)
}

fn find_root_instance<'a>(
    ast: &'a Value,
    preferred_top: &str,
    resolver: &AstAddressResolver<'a>,
) -> Result<Option<&'a serde_json::Map<String, Value>>, SlangMetadataError> {
    let Some(members) = ast
        .get("design")
        .and_then(|design| design.get("members"))
        .and_then(Value::as_array)
    else {
        return Ok(None);
    };
    let instances: Vec<_> = members
        .iter()
        .map(|member| resolver.resolve(member))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(Value::as_object)
        .filter(|member| member.get("kind").and_then(Value::as_str) == Some("Instance"))
        .collect();
    Ok(instances
        .iter()
        .copied()
        .find(|member| member.get("name").and_then(Value::as_str) == Some(preferred_top))
        .or_else(|| instances.first().copied()))
}

fn merge_instance(
    snapshot: &mut DesignSnapshot,
    instance: &serde_json::Map<String, Value>,
    module_key: &str,
    resolver: &AstAddressResolver<'_>,
    report: &mut SlangParameterMergeReport,
) -> Result<(), SlangMetadataError> {
    let parameters = instance_parameters(instance, resolver)?;
    if let Some(module) = snapshot.modules.get_mut(module_key) {
        let ports_updated = merge_module_port_origins(module, instance, resolver)?;
        let net_edges_updated = merge_module_net_origins(module, instance, resolver)?;
        report.ports_updated += ports_updated;
        report.net_edges_updated += net_edges_updated;
        if ports_updated > 0 || net_edges_updated > 0 {
            refresh_module_files(module);
        }
        if !parameters.is_empty() {
            module.module.parameters = parameters;
            report.modules_updated += 1;
        }
    }

    let Some(body) = resolver.body(instance)? else {
        return Ok(());
    };
    for child_match in direct_child_instances(body, resolver)? {
        let child = child_match.instance;
        let Some(name) = child.get("name").and_then(Value::as_str) else {
            report.instances_unmatched += 1;
            continue;
        };
        let source_file = child.get("source_file").and_then(Value::as_str);
        let source_line = child
            .get("source_line")
            .and_then(Value::as_u64)
            .and_then(|line| u32::try_from(line).ok());
        let child_parameters = instance_parameters(child, resolver)?;

        let matched = snapshot.modules.get(module_key).and_then(|module| {
            let scoped_match = module.nodes.iter().enumerate().find(|(_, node)| {
                node.kind == NodeKind::ModuleInstance
                    && node.label.trim_start_matches('\\') == child_match.scoped_name
            });
            if let Some((index, _)) = scoped_match {
                return Some(index);
            }
            let candidates: Vec<_> = module
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| node.kind == NodeKind::ModuleInstance && node.label == name)
                .collect();
            if candidates.len() == 1 {
                return Some(candidates[0].0);
            }
            candidates
                .into_iter()
                .find(|(_, node)| {
                    node.origins.iter().any(|origin| {
                        source_line == Some(origin.start_line)
                            && source_file.is_none_or(|file| paths_match(file, &origin.file))
                    })
                })
                .map(|(index, _)| index)
        });
        let Some(node_index) = matched else {
            report.instances_unmatched += 1;
            continue;
        };

        let child_module_key = {
            let module = snapshot
                .modules
                .get_mut(module_key)
                .expect("module key was resolved before traversing children");
            let node = &mut module.nodes[node_index];
            if node.origins.is_empty()
                && let Some((_, origin)) = named_member_origin(child)
            {
                node.origins = vec![origin];
            }
            if !child_parameters.is_empty() {
                node.parameters = child_parameters;
                report.instances_updated += 1;
            }
            node.definition_name.clone()
        };
        let Some(child_module_key) = child_module_key else {
            report.instances_unmatched += 1;
            continue;
        };
        let child_module_key = resolve_module_key(snapshot, &child_module_key, child, resolver)?
            .unwrap_or(child_module_key);
        if snapshot.modules.contains_key(&child_module_key) {
            merge_instance(snapshot, child, &child_module_key, resolver, report)?;
        } else {
            report.instances_unmatched += 1;
        }
    }
    Ok(())
}

fn merge_module_port_origins(
    module: &mut GraphSlice,
    instance: &serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'_>,
) -> Result<usize, SlangMetadataError> {
    let origins = instance_port_origins(instance, resolver)?;
    let mut updated = 0;
    for node in &mut module.nodes {
        if !matches!(
            node.kind,
            NodeKind::Input | NodeKind::Output | NodeKind::Inout
        ) {
            continue;
        }
        let Some(origin) = origins.get(node.label.trim_start_matches('\\')) else {
            continue;
        };
        if node.origins.as_slice() != std::slice::from_ref(origin) {
            node.origins = vec![origin.clone()];
            updated += 1;
        }
    }
    Ok(updated)
}

fn instance_port_origins<'a>(
    instance: &'a serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'a>,
) -> Result<BTreeMap<String, SourceOrigin>, SlangMetadataError> {
    Ok(resolved_members(resolver.body(instance)?, resolver)?
        .into_iter()
        .filter(|member| member.get("kind").and_then(Value::as_str) == Some("Port"))
        .filter_map(named_member_origin)
        .collect())
}

fn merge_module_net_origins(
    module: &mut GraphSlice,
    instance: &serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'_>,
) -> Result<usize, SlangMetadataError> {
    let metadata = instance_variable_metadata(instance, resolver)?;
    let mut updated = 0;
    for edge in &mut module.edges {
        let Some(label) = edge.label.as_deref() else {
            continue;
        };
        let Some(metadata) = metadata.get(label.trim_start_matches('\\')) else {
            continue;
        };
        let mut changed = false;
        if !metadata.driver_origins.is_empty() {
            if edge.origins != metadata.driver_origins {
                edge.origins.clone_from(&metadata.driver_origins);
                changed = true;
            }
        } else if edge.origins.is_empty()
            && let Some(origin) = &metadata.declaration_origin
        {
            edge.origins = vec![origin.clone()];
            changed = true;
        }
        if edge.signal_type.is_none() {
            edge.signal_type.clone_from(&metadata.signal_type);
            changed = metadata.signal_type.is_some() || changed;
        }
        updated += usize::from(changed);
    }
    Ok(updated)
}

#[derive(Default)]
struct VariableMetadata {
    declaration_origin: Option<SourceOrigin>,
    driver_origins: Vec<SourceOrigin>,
    signal_type: Option<String>,
}

fn instance_variable_metadata<'a>(
    instance: &'a serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'a>,
) -> Result<BTreeMap<String, VariableMetadata>, SlangMetadataError> {
    let mut metadata: BTreeMap<_, _> = resolved_members(resolver.body(instance)?, resolver)?
        .into_iter()
        .filter(|member| member.get("kind").and_then(Value::as_str) == Some("Variable"))
        .filter_map(|member| {
            let (name, origin) = named_member_origin(member)?;
            let signal_type = member
                .get("type")
                .and_then(Value::as_str)
                .map(canonical_signal_type);
            Some((
                name,
                VariableMetadata {
                    declaration_origin: Some(origin),
                    driver_origins: vec![],
                    signal_type,
                },
            ))
        })
        .collect();
    for (name, origins) in instance_driver_origins(instance, resolver)? {
        metadata.entry(name).or_default().driver_origins = origins;
    }
    Ok(metadata)
}

fn instance_driver_origins<'a>(
    instance: &'a serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'a>,
) -> Result<BTreeMap<String, Vec<SourceOrigin>>, SlangMetadataError> {
    let mut drivers = BTreeMap::new();
    if let Some(body) = resolver.body(instance)? {
        collect_assignment_drivers(body, resolver, None, &mut drivers)?;
    }
    Ok(drivers)
}

fn collect_assignment_drivers<'a>(
    value: &'a Value,
    resolver: &AstAddressResolver<'a>,
    enclosing_origin: Option<&SourceOrigin>,
    drivers: &mut BTreeMap<String, Vec<SourceOrigin>>,
) -> Result<(), SlangMetadataError> {
    match value {
        Value::Object(object) => {
            if object.get("kind").and_then(Value::as_str) == Some("Instance") {
                return Ok(());
            }
            let object_origin = source_range_origin(object);
            let next_enclosing = if matches!(
                object.get("kind").and_then(Value::as_str),
                Some("ContinuousAssign" | "ProceduralBlock")
            ) {
                object_origin.as_ref().or(enclosing_origin)
            } else {
                enclosing_origin
            };
            if object.get("kind").and_then(Value::as_str) == Some("Assignment") {
                let mut names = BTreeSet::new();
                if let Some(left) = object.get("left") {
                    assigned_names(left, resolver, &mut names)?;
                }
                let origin = object
                    .get("right")
                    .and_then(Value::as_object)
                    .and_then(source_range_origin)
                    .or_else(|| source_range_origin(object))
                    .or_else(|| next_enclosing.cloned());
                if let Some(origin) = origin {
                    for name in names {
                        let origins = drivers.entry(name).or_default();
                        if !origins.contains(&origin) {
                            origins.push(origin.clone());
                        }
                    }
                }
            }
            for child in object.values() {
                collect_assignment_drivers(child, resolver, next_enclosing, drivers)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_assignment_drivers(child, resolver, enclosing_origin, drivers)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn assigned_names<'a>(
    value: &'a Value,
    resolver: &AstAddressResolver<'a>,
    names: &mut BTreeSet<String>,
) -> Result<(), SlangMetadataError> {
    match value {
        Value::Object(object) => {
            if let Some(symbol) = object.get("symbol") {
                if let Some(name) = resolver
                    .resolve(symbol)?
                    .get("name")
                    .and_then(Value::as_str)
                {
                    names.insert(name.to_owned());
                }
                return Ok(());
            }
            match object.get("kind").and_then(Value::as_str) {
                // Select bounds can themselves reference signals, but those
                // signals are read to choose an lvalue and are not driven.
                Some("ElementSelect" | "RangeSelect" | "MemberAccess") => {
                    if let Some(base) = object.get("value") {
                        assigned_names(base, resolver, names)?;
                    }
                    return Ok(());
                }
                Some("Concatenation") => {
                    if let Some(operands) = object.get("operands") {
                        assigned_names(operands, resolver, names)?;
                    }
                    return Ok(());
                }
                _ => {}
            }
            for (key, child) in object {
                if key != "symbol" {
                    assigned_names(child, resolver, names)?;
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                assigned_names(child, resolver, names)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn source_range_origin(object: &serde_json::Map<String, Value>) -> Option<SourceOrigin> {
    let file = object
        .get("source_file_start")
        .or_else(|| object.get("source_file"))?
        .as_str()?
        .to_owned();
    let start_line = u32::try_from(
        object
            .get("source_line_start")
            .or_else(|| object.get("source_line"))?
            .as_u64()?,
    )
    .ok()?;
    let start_column = u32::try_from(
        object
            .get("source_column_start")
            .or_else(|| object.get("source_column"))?
            .as_u64()?,
    )
    .ok()?;
    let end_line = object
        .get("source_line_end")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(start_line);
    let end_column = object
        .get("source_column_end")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .or(Some(start_column.saturating_add(1)));
    Some(SourceOrigin {
        file,
        start_line,
        start_column,
        end_line,
        end_column,
    })
}

fn canonical_signal_type(raw: &str) -> String {
    let raw = raw.trim();
    if let Some((identity, source_type)) = raw.split_once(' ')
        && !identity.is_empty()
        && identity.bytes().all(|byte| byte.is_ascii_digit())
        && !source_type.is_empty()
    {
        return source_type.to_owned();
    }
    raw.to_owned()
}

fn named_member_origin(member: &serde_json::Map<String, Value>) -> Option<(String, SourceOrigin)> {
    let name = member.get("name")?.as_str()?.to_owned();
    let file = member.get("source_file")?.as_str()?.to_owned();
    let line = u32::try_from(member.get("source_line")?.as_u64()?).ok()?;
    let column = u32::try_from(member.get("source_column")?.as_u64()?).ok()?;
    let width = u32::try_from(name.chars().count()).unwrap_or(u32::MAX);
    Some((
        name,
        SourceOrigin {
            file,
            start_line: line,
            start_column: column,
            end_line: line,
            end_column: Some(column.saturating_add(width)),
        },
    ))
}

fn refresh_module_files(module: &mut GraphSlice) {
    let paths: BTreeSet<_> = module
        .nodes
        .iter()
        .flat_map(|node| &node.origins)
        .chain(module.edges.iter().flat_map(|edge| &edge.origins))
        .map(|origin| origin.file.clone())
        .collect();
    module.files = Some(
        paths
            .into_iter()
            .map(|path| SourceFileRef {
                id: stable_id("file", &path),
                path,
            })
            .collect(),
    );
}

fn instance_parameters<'a>(
    instance: &'a serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'a>,
) -> Result<BTreeMap<String, Value>, SlangMetadataError> {
    Ok(resolved_members(resolver.body(instance)?, resolver)?
        .into_iter()
        .filter(|member| member.get("kind").and_then(Value::as_str) == Some("Parameter"))
        .filter(|member| {
            !member
                .get("isLocal")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|member| {
            let name = member.get("name")?.as_str()?.to_owned();
            let value = member.get("value")?.clone();
            Some((name, value))
        })
        .collect())
}

fn resolved_members<'a>(
    container: Option<&'a Value>,
    resolver: &AstAddressResolver<'a>,
) -> Result<Vec<&'a serde_json::Map<String, Value>>, SlangMetadataError> {
    let Some(members) = container
        .and_then(|container| container.get("members"))
        .and_then(Value::as_array)
    else {
        return Ok(vec![]);
    };
    members
        .iter()
        .map(|member| resolver.resolve(member).map(Value::as_object))
        .filter_map(Result::transpose)
        .collect()
}

struct ChildInstance<'a> {
    instance: &'a serde_json::Map<String, Value>,
    scoped_name: String,
}

fn direct_child_instances<'a>(
    value: &'a Value,
    resolver: &AstAddressResolver<'a>,
) -> Result<Vec<ChildInstance<'a>>, SlangMetadataError> {
    fn visit<'a>(
        value: &'a Value,
        scope: &[String],
        resolver: &AstAddressResolver<'a>,
        instances: &mut Vec<ChildInstance<'a>>,
    ) -> Result<(), SlangMetadataError> {
        let value = resolver.resolve(value)?;
        match value {
            Value::Object(object) => {
                match object.get("kind").and_then(Value::as_str) {
                    Some("Instance") => {
                        if let Some(name) = object.get("name").and_then(Value::as_str) {
                            let mut path = scope.to_vec();
                            path.push(name.to_owned());
                            let scoped_name = path.join(".");
                            instances.push(ChildInstance {
                                instance: object,
                                scoped_name,
                            });
                        }
                        return Ok(());
                    }
                    Some("GenerateBlockArray") => {
                        let Some(name) = object.get("name").and_then(Value::as_str) else {
                            return Ok(());
                        };
                        for member in object
                            .get("members")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                        {
                            let index = member
                                .get("constructIndex")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            let mut nested_scope = scope.to_vec();
                            nested_scope.push(format!("{name}[{index}]"));
                            visit(member, &nested_scope, resolver, instances)?;
                        }
                        return Ok(());
                    }
                    Some("GenerateBlock") => {
                        let mut nested_scope = scope.to_vec();
                        if let Some(name) = object
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|name| !name.is_empty())
                        {
                            nested_scope.push(name.to_owned());
                        }
                        if let Some(members) = object.get("members") {
                            visit(members, &nested_scope, resolver, instances)?;
                        }
                        return Ok(());
                    }
                    _ => {}
                }
                // Only AST containment fields can introduce a child instance.
                // Avoid following type/address strings in arbitrary metadata,
                // which could otherwise create irrelevant reference cycles.
                for field in ["members", "body"] {
                    if let Some(child) = object.get(field) {
                        visit(child, scope, resolver, instances)?;
                    }
                }
            }
            Value::Array(values) => {
                for child in values {
                    visit(child, scope, resolver, instances)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    let mut instances = vec![];
    visit(value, &[], resolver, &mut instances)?;
    Ok(instances)
}

fn resolve_module_key(
    snapshot: &DesignSnapshot,
    definition_name: &str,
    instance: &serde_json::Map<String, Value>,
    resolver: &AstAddressResolver<'_>,
) -> Result<Option<String>, SlangMetadataError> {
    if snapshot.modules.contains_key(definition_name) {
        return Ok(Some(definition_name.to_owned()));
    }
    let Some(body_name) = resolver
        .body(instance)?
        .and_then(|body| body.get("name"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let mut matching = snapshot
        .modules
        .keys()
        .filter(|name| name.as_str() == body_name || name.starts_with(&format!("{body_name}$")));
    let Some(first) = matching.next().cloned() else {
        return Ok(None);
    };
    Ok(matching.next().is_none().then_some(first))
}

fn paths_match(left: &str, right: &str) -> bool {
    let normalize = |path: &str| path.replace('\\', "/");
    let left = normalize(left);
    let right = normalize(right);
    left == right || left.ends_with(&format!("/{right}")) || right.ends_with(&format!("/{left}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_slang_process_local_type_identity() {
        assert_eq!(
            canonical_signal_type("6338776398000 ibex_pkg::alu_op_e"),
            "ibex_pkg::alu_op_e"
        );
        assert_eq!(canonical_signal_type("logic[31:0]"), "logic[31:0]");
    }
    use crate::ir::import_yosys_json;

    const YOSYS: &str = r#"{
      "modules": {
        "child$top.u_child": {
          "ports": {}, "cells": {}, "netnames": {}
        },
        "top": {
          "attributes": {"top": 1, "src": "rtl/top.sv:1.8"},
          "ports": {"clk": {"direction": "input", "bits": [2]}},
          "cells": {
            "u_child": {
              "type": "child$top.u_child",
              "parameters": {},
              "attributes": {"src": "rtl/top.sv:12.7"},
              "port_directions": {}, "connections": {}
            }
          },
          "netnames": {"clk": {"bits": [2], "attributes": {"hdlname": "clk"}}}
        }
      }
    }"#;

    const SLANG: &str = r#"{
      "design": {"members": [
        {"kind": "Instance", "name": "top", "body": {
          "name": "top", "members": [
            {"kind": "Parameter", "name": "WIDTH", "value": "8", "isLocal": false},
            {"kind": "Parameter", "name": "LOCAL", "value": "9", "isLocal": true},
            {"kind": "Port", "name": "clk", "source_file": "rtl/top.sv",
             "source_line": 6, "source_column": 28},
            {"kind": "Instance", "name": "u_child", "source_file": "rtl/top.sv",
             "source_line": 12, "body": {"name": "child", "members": [
               {"kind": "Parameter", "name": "WIDTH", "value": "16", "isLocal": false}
             ]}}
          ]
        }}
      ]}
    }"#;

    #[test]
    fn selects_the_requested_top_from_multiple_elaborated_roots() {
        let ast: Value = serde_json::from_str(
            r#"{"design":{"members":[
              {"kind":"Instance","name":"filelist_top","body":{"members":[]}},
              {"kind":"Instance","name":"requested_top","body":{"members":[]}}
            ]}}"#,
        )
        .unwrap();
        let resolver = AstAddressResolver::new(&ast).unwrap();

        assert_eq!(
            find_root_instance(&ast, "requested_top", &resolver)
                .unwrap()
                .and_then(|root| root.get("name"))
                .and_then(Value::as_str),
            Some("requested_top")
        );
    }

    #[test]
    fn resolves_shared_slang_v11_instance_bodies() {
        let yosys = serde_json::json!({
            "modules": {
                "child": {"ports": {}, "cells": {}, "netnames": {}},
                "top": {
                    "attributes": {"top": 1},
                    "ports": {},
                    "cells": {
                        "first": {
                            "type": "child", "parameters": {}, "attributes": {},
                            "port_directions": {}, "connections": {}
                        },
                        "second": {
                            "type": "child", "parameters": {}, "attributes": {},
                            "port_directions": {}, "connections": {}
                        }
                    },
                    "netnames": {}
                }
            }
        });
        let slang = r#"{
          "symbols": [
            {"kind": "Parameter", "name": "WIDTH", "value": "8", "isLocal": false, "addr": 300}
          ],
          "design": {"members": [{"kind": "Instance", "name": "top", "body": {
            "kind": "InstanceBody", "name": "top", "addr": 100, "members": [
              {"kind": "Instance", "name": "first", "body": {
                "kind": "InstanceBody", "name": "child", "addr": 200, "members": [
                  "300 WIDTH"
                ]
              }},
              {"kind": "Instance", "name": "second", "body": "200 child"}
            ]
          }}]}
        }"#;

        let mut snapshot = import_yosys_json(&yosys.to_string(), Some("top")).unwrap();
        let report = merge_slang_instance_parameters(&mut snapshot, slang).unwrap();

        assert_eq!(report.instances_unmatched, 0);
        assert_eq!(report.instances_updated, 2);
        for label in ["first", "second"] {
            let instance = snapshot.modules["top"]
                .nodes
                .iter()
                .find(|node| node.label == label)
                .unwrap();
            assert_eq!(instance.parameters["WIDTH"], "8");
        }
    }

    #[test]
    fn rejects_ambiguous_or_dangling_slang_addresses() {
        let mut snapshot = import_yosys_json(YOSYS, Some("top")).unwrap();
        let duplicate = r#"{"design":{"members":[
          {"kind":"Instance","name":"top","addr":1,"body":{"addr":1,"members":[]}}
        ]}}"#;
        assert!(matches!(
            merge_slang_instance_parameters(&mut snapshot, duplicate),
            Err(SlangMetadataError::DuplicateNodeAddress(1))
        ));

        let dangling = r#"{"design":{"members":[
          {"kind":"Instance","name":"top","body":"999 top"}
        ]}}"#;
        assert!(matches!(
            merge_slang_instance_parameters(&mut snapshot, dangling),
            Err(SlangMetadataError::DanglingNodeAddress(999))
        ));
    }

    #[test]
    fn accepts_equivalent_repeated_address_definitions() {
        let ast = serde_json::json!({
            "definitions": [
                {"kind": "InstanceBody", "name": "child", "addr": 42, "members": []},
                {"kind": "InstanceBody", "name": "child", "addr": 42, "members": []}
            ],
            "link": "42 child"
        });
        let resolver = AstAddressResolver::new(&ast).unwrap();

        assert_eq!(
            resolver
                .resolve(ast.get("link").unwrap())
                .unwrap()
                .get("name")
                .and_then(Value::as_str),
            Some("child")
        );
    }

    #[test]
    fn recognizes_only_complete_address_links() {
        assert_eq!(address_link("123 child"), Some(123));
        assert_eq!(address_link("123\tchild"), Some(123));
        assert_eq!(address_link("123"), None);
        assert_eq!(address_link("123   "), None);
        assert_eq!(address_link("12x child"), None);
        assert_eq!(address_link("logic[7:0]"), None);
    }

    #[test]
    fn merges_top_and_specialized_instance_parameters() {
        let mut snapshot = import_yosys_json(YOSYS, Some("top")).unwrap();
        let report = merge_slang_instance_parameters(&mut snapshot, SLANG).unwrap();

        assert_eq!(report.modules_updated, 2);
        assert_eq!(report.instances_updated, 1);
        assert_eq!(report.instances_unmatched, 0);
        assert_eq!(report.ports_updated, 1);
        assert_eq!(snapshot.modules["top"].module.parameters["WIDTH"], "8");
        assert!(
            !snapshot.modules["top"]
                .module
                .parameters
                .contains_key("LOCAL")
        );
        let child = snapshot.modules["top"]
            .nodes
            .iter()
            .find(|node| node.label == "u_child")
            .unwrap();
        assert_eq!(child.parameters["WIDTH"], "16");
        assert_eq!(
            snapshot.modules["child$top.u_child"].module.parameters["WIDTH"],
            "16"
        );
        let clk = snapshot.modules["top"]
            .nodes
            .iter()
            .find(|node| node.label == "clk")
            .unwrap();
        assert_eq!(
            clk.origins,
            vec![SourceOrigin {
                file: "rtl/top.sv".to_owned(),
                start_line: 6,
                start_column: 28,
                end_line: 6,
                end_column: Some(31),
            }]
        );
    }

    #[test]
    fn matches_generated_instance_scopes_and_fills_their_source_origins() {
        let yosys = serde_json::json!({
            "modules": {
                "leaf": {"ports": {}, "cells": {}, "netnames": {}},
                "top": {
                    "attributes": {"top": 1},
                    "ports": {},
                    "cells": {
                        "lanes[0].u_leaf": {
                            "type": "leaf", "parameters": {}, "attributes": {},
                            "port_directions": {}, "connections": {}
                        },
                        "lanes[1].u_leaf": {
                            "type": "leaf", "parameters": {}, "attributes": {},
                            "port_directions": {}, "connections": {}
                        },
                        "optional.u_extra": {
                            "type": "leaf", "parameters": {}, "attributes": {},
                            "port_directions": {}, "connections": {}
                        }
                    },
                    "netnames": {}
                }
            }
        });
        let slang = r#"{
          "design": {"members": [{"kind": "Instance", "name": "top", "body": {
            "name": "top", "members": [
              {"kind": "GenerateBlockArray", "name": "lanes", "members": [
                {"kind": "GenerateBlock", "name": "", "constructIndex": 0, "members": [
                  {"kind": "Instance", "name": "u_leaf", "source_file": "rtl/top.sv", "source_line": 4, "source_column": 10, "body": {"name": "leaf", "members": []}}
                ]},
                {"kind": "GenerateBlock", "name": "", "constructIndex": 1, "members": [
                  {"kind": "Instance", "name": "u_leaf", "source_file": "rtl/top.sv", "source_line": 4, "source_column": 10, "body": {"name": "leaf", "members": []}}
                ]}
              ]},
              {"kind": "GenerateBlock", "name": "optional", "members": [
                {"kind": "Instance", "name": "u_extra", "source_file": "rtl/top.sv", "source_line": 7, "source_column": 10, "body": {"name": "leaf", "members": []}}
              ]}
            ]
          }}]}
        }"#;

        let mut snapshot = import_yosys_json(&yosys.to_string(), Some("top")).unwrap();
        let report = merge_slang_instance_parameters(&mut snapshot, slang).unwrap();
        assert_eq!(report.instances_unmatched, 0);

        let top = &snapshot.modules["top"];
        for label in ["lanes[0].u_leaf", "lanes[1].u_leaf"] {
            let node = top.nodes.iter().find(|node| node.label == label).unwrap();
            assert_eq!(node.origins[0].start_line, 4);
            assert_eq!(node.origins[0].start_column, 10);
        }
        let extra = top
            .nodes
            .iter()
            .find(|node| node.label == "optional.u_extra")
            .unwrap();
        assert_eq!(extra.origins[0].start_line, 7);
    }

    #[test]
    fn prefers_assignment_drivers_and_uses_declarations_as_last_resort() {
        let yosys = serde_json::json!({
            "modules": {
                "top": {
                    "attributes": {"top": 1, "src": "rtl/top.sv:1.8"},
                    "ports": {
                        "i": {"direction": "input", "bits": [2]},
                        "o": {"direction": "output", "bits": [3]}
                    },
                    "cells": {
                        "invert": {
                            "type": "$not",
                            "parameters": {},
                            "attributes": {"src": "rtl/top.sv:10.10"},
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [3]}
                        }
                    },
                    "netnames": {
                        "i": {"bits": [2], "attributes": {"src": "rtl/top.sv:9.3-9.4"}},
                        "o": {"bits": [3], "attributes": {"hdlname": "o"}}
                    }
                }
            }
        });
        let slang = r#"{
          "design": {"members": [{"kind": "Instance", "name": "top", "body": {
            "name": "top", "members": [
              {"kind": "Port", "name": "i", "source_file": "rtl/top.sv", "source_line": 3, "source_column": 15},
              {"kind": "Variable", "name": "i", "type": "logic[7:0]", "source_file": "rtl/top.sv", "source_line": 3, "source_column": 15},
              {"kind": "Port", "name": "o", "source_file": "rtl/top.sv", "source_line": 4, "source_column": 16},
              {"kind": "Variable", "name": "o", "addr": 44, "type": "packet_t", "source_file": "rtl/top.sv", "source_line": 4, "source_column": 16},
              {"kind": "ContinuousAssign", "source_file": "rtl/top.sv", "source_line": 12, "source_column": 3,
               "assignment": {"kind": "Assignment",
                 "left": {"kind": "NamedValue", "symbol": "44 o"},
                 "right": {"kind": "UnaryOp", "source_file_start": "rtl/top.sv", "source_file_end": "rtl/top.sv", "source_line_start": 12, "source_line_end": 12, "source_column_start": 14, "source_column_end": 16}}}
            ]
          }}]}
        }"#;
        let mut snapshot = import_yosys_json(&yosys.to_string(), Some("top")).unwrap();
        let report = merge_slang_instance_parameters(&mut snapshot, slang).unwrap();

        assert_eq!(report.net_edges_updated, 2);
        let graph = &snapshot.modules["top"];
        let input_edge = graph
            .edges
            .iter()
            .find(|edge| edge.label.as_deref() == Some("i"))
            .unwrap();
        assert_eq!(input_edge.origins[0].start_line, 9);
        assert_eq!(input_edge.signal_type.as_deref(), Some("logic[7:0]"));
        let output_edge = graph
            .edges
            .iter()
            .find(|edge| edge.label.as_deref() == Some("o"))
            .unwrap();
        assert_eq!(output_edge.origins[0].start_line, 12);
        assert_eq!(output_edge.origins[0].start_column, 14);
        assert_eq!(output_edge.origins[0].end_column, Some(16));
        assert_eq!(output_edge.signal_type.as_deref(), Some("packet_t"));
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
    fn extracts_continuous_procedural_and_block_fallback_driver_origins() {
        let ast = serde_json::json!({
          "design": {"members": [{"kind": "Instance", "name": "top", "body": {
            "kind": "InstanceBody", "members": [
              {"kind": "Variable", "name": "comb", "addr": 101,
               "source_file": "rtl/top.sv", "source_line": 2, "source_column": 9},
              {"kind": "Variable", "name": "y", "addr": 102,
               "source_file": "rtl/top.sv", "source_line": 3, "source_column": 9},
              {"kind": "Variable", "name": "q", "addr": 103,
               "source_file": "rtl/top.sv", "source_line": 4, "source_column": 9},
              {"kind": "Variable", "name": "idx", "addr": 105,
               "source_file": "rtl/top.sv", "source_line": 5, "source_column": 9},
              {"kind": "ContinuousAssign", "source_file": "rtl/top.sv",
               "source_line": 10, "source_column": 3, "assignment": {
                 "kind": "Assignment",
                 "left": {"kind": "NamedValue", "symbol": "101 comb"},
                 "right": {"kind": "BinaryOp", "source_file_start": "rtl/top.sv",
                   "source_line_start": 10, "source_column_start": 17,
                   "source_line_end": 10, "source_column_end": 22}}},
              {"kind": "ProceduralBlock", "procedureKind": "AlwaysComb",
               "source_file": "rtl/top.sv", "source_line": 13, "source_column": 3,
               "body": {"kind": "Block", "body": {"kind": "ExpressionStatement", "expr": {
                 "kind": "Assignment",
                 "left": {"kind": "NamedValue", "symbol": "102 y"},
                 "right": {"kind": "BinaryOp", "source_file_start": "rtl/top.sv",
                   "source_line_start": 14, "source_column_start": 9,
                   "source_line_end": 14, "source_column_end": 17}}}}},
              {"kind": "ProceduralBlock", "procedureKind": "AlwaysComb",
               "source_file": "rtl/top.sv", "source_line": 15, "source_column": 3,
               "body": {"kind": "ExpressionStatement", "expr": {
                 "kind": "Assignment",
                 "left": {"kind": "ElementSelect",
                   "value": {"kind": "NamedValue", "symbol": "102 y"},
                   "selector": {"kind": "NamedValue", "symbol": "105 idx"}},
                 "right": {"kind": "NamedValue", "source_file_start": "rtl/top.sv",
                   "source_line_start": 15, "source_column_start": 14,
                   "source_line_end": 15, "source_column_end": 15}}}},
              {"kind": "ProceduralBlock", "procedureKind": "AlwaysFF",
               "source_file": "rtl/top.sv", "source_line": 20, "source_column": 3,
               "body": {"kind": "ExpressionStatement", "expr": {
                 "kind": "Assignment",
                 "left": {"kind": "NamedValue", "symbol": "103 q"},
                 "right": {"kind": "NamedValue", "symbol": "102 y"}}}},
              {"kind": "Instance", "name": "u_child", "body": {"kind": "InstanceBody",
               "members": [{"kind": "Variable", "name": "q", "addr": 104},
                 {"kind": "ContinuousAssign", "assignment": {"kind": "Assignment",
                   "left": {"kind": "NamedValue", "symbol": "104 q"},
                   "right": {"kind": "NamedValue", "source_file_start": "rtl/child.sv",
                     "source_line_start": 99, "source_column_start": 1,
                     "source_line_end": 99, "source_column_end": 2}}}]}}
            ]
          }}]}
        });
        let resolver = AstAddressResolver::new(&ast).unwrap();
        let instance = ast["design"]["members"][0].as_object().unwrap();
        let drivers = instance_driver_origins(instance, &resolver).unwrap();

        assert_eq!(drivers["comb"][0].start_line, 10);
        assert_eq!(drivers["comb"][0].start_column, 17);
        assert_eq!(drivers["comb"][0].end_column, Some(22));
        assert_eq!(drivers["y"][0].start_line, 14);
        assert_eq!(drivers["y"][0].start_column, 9);
        assert_eq!(drivers["y"][0].end_column, Some(17));
        assert_eq!(drivers["y"][1].start_line, 15);
        assert!(!drivers.contains_key("idx"));
        assert_eq!(drivers["q"][0].start_line, 20);
        assert_eq!(drivers["q"][0].start_column, 3);
        assert_eq!(drivers["q"][0].end_column, Some(4));
    }

    #[test]
    fn rejects_ast_without_an_elaborated_root() {
        let mut snapshot = import_yosys_json(YOSYS, Some("top")).unwrap();
        assert!(matches!(
            merge_slang_instance_parameters(&mut snapshot, r#"{"design":{"members":[]}}"#),
            Err(SlangMetadataError::MissingDesignInstance)
        ));
    }
}
