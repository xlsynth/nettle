// SPDX-License-Identifier: Apache-2.0

//! Correlates Slang's elaborated AST with its lossless concrete syntax tree.
//!
//! Slang intentionally omits untaken generate branches from the AST, while its
//! CST preserves every source token. This module supports standalone Slang
//! v11+ output produced with `--ast-json-source-info` and
//! `--cst-json-mode simple-trivia`. In that mode syntax-node object members are
//! serialized in lexical order, but nodes do not carry source coordinates.
//! Coordinates must therefore be recovered by replaying each token's `trivia`
//! followed by its `text` in object-member order. Schema or ordering drift
//! fails closed: activity is emitted only when replay reconstructs exactly one
//! bundled source.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use serde::Deserialize;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use super::{
    AstAddressResolver, ResolvedSlangAst, SlangMetadataError, direct_child_instances,
    find_root_instance, resolve_module_key, source_range_origin,
};
use crate::ir::{DesignSnapshot, NodeKind, SourceElaborationRange};

#[derive(Debug)]
enum OrderedJson {
    Other,
    String(String),
    Array(Vec<OrderedJson>),
    Object(Vec<(String, OrderedJson)>),
}

impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct OrderedJsonVisitor;

        impl<'de> Visitor<'de> for OrderedJsonVisitor {
            type Value = OrderedJson;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(OrderedJson::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(OrderedJson::String(value))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Other)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                OrderedJson::deserialize(deserializer)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = vec![];
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(OrderedJson::Array(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = vec![];
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(OrderedJson::Object(entries))
            }
        }

        deserializer.deserialize_any(OrderedJsonVisitor)
    }
}

impl OrderedJson {
    fn field(&self, name: &str) -> Option<&Self> {
        let Self::Object(entries) = self else {
            return None;
        };
        entries
            .iter()
            .find_map(|(key, value)| (key == name).then_some(value))
    }

    fn string(&self) -> Option<&str> {
        let Self::String(value) = self else {
            return None;
        };
        Some(value)
    }

    fn array(&self) -> Option<&[Self]> {
        let Self::Array(values) = self else {
            return None;
        };
        Some(values)
    }

    fn take_field(self, name: &str) -> Option<Self> {
        let Self::Object(mut entries) = self else {
            return None;
        };
        let index = entries.iter().position(|(key, _)| key == name)?;
        Some(entries.swap_remove(index).1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourcePosition {
    line: u32,
    column: u32,
}

impl Default for SourcePosition {
    fn default() -> Self {
        Self { line: 1, column: 1 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CstRange {
    start: SourcePosition,
    end: SourcePosition,
}

#[derive(Debug)]
struct CstIfGenerate {
    module: String,
    condition: CstRange,
    then_branch: CstRange,
    else_branch: Option<CstRange>,
    construct: CstRange,
}

#[derive(Debug)]
struct CstLoopGenerate {
    module: String,
    initial: CstRange,
    block: CstRange,
    construct: CstRange,
}

#[derive(Debug)]
struct CstCaseItem {
    selector: Option<CstRange>,
    default: bool,
    range: CstRange,
}

#[derive(Debug)]
struct CstCaseGenerate {
    module: String,
    condition: CstRange,
    items: Vec<CstCaseItem>,
    construct: CstRange,
}

#[derive(Debug)]
struct CstSource {
    path: String,
    if_generates: Vec<CstIfGenerate>,
    loop_generates: Vec<CstLoopGenerate>,
    case_generates: Vec<CstCaseGenerate>,
}

#[derive(Default)]
struct CstRenderer {
    text: String,
    position: SourcePosition,
    if_generates: Vec<CstIfGenerate>,
    loop_generates: Vec<CstLoopGenerate>,
    case_generates: Vec<CstCaseGenerate>,
}

impl CstRenderer {
    fn append(&mut self, text: &str) {
        self.text.push_str(text);
        for character in text.chars() {
            if character == '\n' {
                self.position.line = self.position.line.saturating_add(1);
                self.position.column = 1;
            } else {
                self.position.column = self.position.column.saturating_add(1);
            }
        }
    }

    fn render(&mut self, value: &OrderedJson, enclosing_module: Option<&str>) -> Option<CstRange> {
        match value {
            OrderedJson::Other | OrderedJson::String(_) => None,
            OrderedJson::Array(values) => {
                let mut range = None;
                for value in values {
                    merge_rendered_range(&mut range, self.render(value, enclosing_module));
                }
                range
            }
            OrderedJson::Object(entries) => {
                if let Some(text) = value.field("text").and_then(OrderedJson::string) {
                    if let Some(trivia) = value.field("trivia").and_then(OrderedJson::string) {
                        self.append(trivia);
                    }
                    if text.is_empty() {
                        return None;
                    }
                    let start = self.position;
                    self.append(text);
                    return Some(CstRange {
                        start,
                        end: self.position,
                    });
                }

                let kind = value.field("kind").and_then(OrderedJson::string);
                let module = if kind == Some("ModuleDeclaration") {
                    value
                        .field("header")
                        .and_then(|header| header.field("name"))
                        .and_then(|name| name.field("text"))
                        .and_then(OrderedJson::string)
                        .or(enclosing_module)
                } else {
                    enclosing_module
                };
                let mut range = None;
                let mut condition = None;
                let mut then_branch = None;
                let mut else_branch = None;
                let mut loop_initial = None;
                let mut loop_block = None;
                let mut case_items = None;
                for (key, child) in entries {
                    if key == "kind" {
                        continue;
                    }
                    let child_range = if kind == Some("CaseGenerate") && key == "items" {
                        let (range, items) = self.render_case_items(child, module);
                        case_items = Some(items);
                        range
                    } else {
                        self.render(child, module)
                    };
                    match (kind, key.as_str()) {
                        (Some("IfGenerate" | "CaseGenerate"), "condition") => {
                            condition = child_range;
                        }
                        (Some("IfGenerate"), "block") => then_branch = child_range,
                        (Some("IfGenerate"), "elseClause") => else_branch = child_range,
                        (Some("LoopGenerate"), "initialExpr") => loop_initial = child_range,
                        (Some("LoopGenerate"), "block") => loop_block = child_range,
                        _ => {}
                    }
                    merge_rendered_range(&mut range, child_range);
                }
                if let Some(module) = module {
                    if kind == Some("IfGenerate")
                        && let (Some(condition), Some(then_branch), Some(construct)) =
                            (condition, then_branch, range)
                    {
                        self.if_generates.push(CstIfGenerate {
                            module: module.to_owned(),
                            condition,
                            then_branch,
                            else_branch,
                            construct,
                        });
                    } else if kind == Some("LoopGenerate")
                        && let (Some(initial), Some(block), Some(construct)) =
                            (loop_initial, loop_block, range)
                    {
                        self.loop_generates.push(CstLoopGenerate {
                            module: module.to_owned(),
                            initial,
                            block,
                            construct,
                        });
                    } else if kind == Some("CaseGenerate")
                        && let (Some(condition), Some(items), Some(construct)) =
                            (condition, case_items, range)
                    {
                        self.case_generates.push(CstCaseGenerate {
                            module: module.to_owned(),
                            condition,
                            items,
                            construct,
                        });
                    }
                }
                range
            }
        }
    }

    fn render_case_items(
        &mut self,
        value: &OrderedJson,
        module: Option<&str>,
    ) -> (Option<CstRange>, Vec<CstCaseItem>) {
        let Some(items) = value.array() else {
            return (self.render(value, module), vec![]);
        };
        let mut overall = None;
        let mut rendered = vec![];
        for item in items {
            let kind = item.field("kind").and_then(OrderedJson::string);
            let Some(entries) = (match item {
                OrderedJson::Object(entries) => Some(entries),
                _ => None,
            }) else {
                merge_rendered_range(&mut overall, self.render(item, module));
                continue;
            };
            let mut item_range = None;
            let mut selector = None;
            for (key, child) in entries {
                if key == "kind" {
                    continue;
                }
                let child_range = self.render(child, module);
                if key == "expressions" {
                    selector = child_range;
                }
                merge_rendered_range(&mut item_range, child_range);
            }
            merge_rendered_range(&mut overall, item_range);
            if let Some(range) = item_range {
                rendered.push(CstCaseItem {
                    selector,
                    default: kind == Some("DefaultCaseItem"),
                    range,
                });
            }
        }
        (overall, rendered)
    }
}

fn merge_rendered_range(target: &mut Option<CstRange>, source: Option<CstRange>) {
    let Some(source) = source else {
        return;
    };
    match target {
        Some(target) => target.end = source.end,
        None => *target = Some(source),
    }
}

struct SourceCatalog<'a> {
    by_contents: HashMap<&'a str, Vec<&'a str>>,
    suffix_aliases: HashMap<String, Option<&'a str>>,
}

impl<'a> SourceCatalog<'a> {
    fn new(sources: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut by_contents: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut suffix_aliases: HashMap<String, Option<&str>> = HashMap::new();
        for (path, contents) in sources {
            by_contents.entry(contents).or_default().push(path);
            let normalized = normalize_path(path);
            for suffix in path_suffixes(&normalized) {
                suffix_aliases
                    .entry(suffix.to_owned())
                    .and_modify(|existing| {
                        if existing.is_some_and(|existing| existing != path) {
                            *existing = None;
                        }
                    })
                    .or_insert(Some(path));
            }
        }
        Self {
            by_contents,
            suffix_aliases,
        }
    }

    fn unique_content_path(&self, contents: &str) -> Option<&'a str> {
        let paths = self.by_contents.get(contents)?;
        (paths.len() == 1).then_some(paths[0])
    }

    fn unique_ast_path(&self, path: &str) -> Option<&'a str> {
        let path = normalize_path(path);
        path_suffixes(&path).find_map(|suffix| {
            self.suffix_aliases
                .get(suffix)
                .and_then(|candidate| *candidate)
        })
    }
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn path_suffixes(path: &str) -> impl Iterator<Item = &str> {
    std::iter::once(path).chain(
        path.match_indices('/')
            .map(|(index, _)| &path[index.saturating_add(1)..]),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SourceKey {
    path: String,
    line: u32,
    column: u32,
}

#[derive(Default)]
struct IfActivity {
    true_branch: bool,
    false_branch: bool,
}

#[derive(Default)]
struct CaseActivity {
    selectors: BTreeSet<(u32, u32)>,
    default_selected: bool,
}

struct ModuleActivity {
    reliable: bool,
    source_definition: Option<String>,
    source_path: Option<String>,
    ifs: BTreeMap<SourceKey, IfActivity>,
    loops: BTreeMap<SourceKey, bool>,
    cases: BTreeMap<SourceKey, CaseActivity>,
}

impl Default for ModuleActivity {
    fn default() -> Self {
        Self {
            reliable: true,
            source_definition: None,
            source_path: None,
            ifs: BTreeMap::new(),
            loops: BTreeMap::new(),
            cases: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
struct InstanceCandidate {
    definition_name: Option<String>,
    origins: Vec<(String, u32)>,
}

#[derive(Default)]
struct ModuleInstanceIndex {
    scoped: HashMap<String, Option<InstanceCandidate>>,
    labels: HashMap<String, Vec<InstanceCandidate>>,
}

fn index_module_instances(snapshot: &DesignSnapshot) -> BTreeMap<String, ModuleInstanceIndex> {
    snapshot
        .modules
        .iter()
        .map(|(module_key, slice)| {
            let mut index = ModuleInstanceIndex::default();
            for node in slice
                .nodes
                .iter()
                .filter(|node| node.kind == NodeKind::ModuleInstance)
            {
                let candidate = InstanceCandidate {
                    definition_name: node.definition_name.clone(),
                    origins: node
                        .origins
                        .iter()
                        .map(|origin| (origin.file.clone(), origin.start_line))
                        .collect(),
                };
                index
                    .scoped
                    .entry(node.label.trim_start_matches('\\').to_owned())
                    .and_modify(|existing| *existing = None)
                    .or_insert_with(|| Some(candidate.clone()));
                index
                    .labels
                    .entry(node.label.clone())
                    .or_default()
                    .push(candidate);
            }
            (module_key.clone(), index)
        })
        .collect()
}

fn source_key(
    value: &Value,
    resolver: &AstAddressResolver<'_>,
    sources: &SourceCatalog<'_>,
) -> Result<Option<SourceKey>, SlangMetadataError> {
    let origin = resolver
        .resolve(value)?
        .as_object()
        .and_then(source_range_origin);
    Ok(origin.and_then(|origin| {
        sources.unique_ast_path(&origin.file).map(|path| SourceKey {
            path: path.to_owned(),
            line: origin.start_line,
            column: origin.start_column,
        })
    }))
}

fn collect_body_activity(
    value: &Value,
    resolver: &AstAddressResolver<'_>,
    sources: &SourceCatalog<'_>,
    activity: &mut ModuleActivity,
) -> Result<(), SlangMetadataError> {
    let value = resolver.resolve(value)?;
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("GenerateBlock") => {
            let branch_kind = object.get("branchKind").and_then(Value::as_str);
            if matches!(
                branch_kind,
                Some("IfTrue" | "IfFalse" | "CaseItem" | "CaseDefault")
            ) {
                let Some(condition) = object.get("conditionExpression") else {
                    activity.reliable = false;
                    return Ok(());
                };
                let Some(key) = source_key(condition, resolver, sources)? else {
                    activity.reliable = false;
                    return Ok(());
                };
                match branch_kind {
                    Some("IfTrue") => activity.ifs.entry(key).or_default().true_branch = true,
                    Some("IfFalse") => activity.ifs.entry(key).or_default().false_branch = true,
                    Some("CaseDefault") => {
                        activity.cases.entry(key).or_default().default_selected = true;
                    }
                    Some("CaseItem") => {
                        let selected = activity.cases.entry(key).or_default();
                        let Some(expressions) =
                            object.get("caseItemExpressions").and_then(Value::as_array)
                        else {
                            activity.reliable = false;
                            return Ok(());
                        };
                        for expression in expressions {
                            let Some(expression) = source_key(expression, resolver, sources)?
                            else {
                                activity.reliable = false;
                                return Ok(());
                            };
                            selected
                                .selectors
                                .insert((expression.line, expression.column));
                        }
                    }
                    _ => {}
                }
            } else if object.contains_key("conditionExpression") {
                // Loop iterations are GenerateBlocks too, but carry no
                // condition; their GenerateBlockArray records loop activity.
                activity.reliable = false;
                return Ok(());
            }
        }
        Some("GenerateBlockArray") => {
            let Some(initial) = object.get("initialExpression") else {
                activity.reliable = false;
                return Ok(());
            };
            let Some(key) = source_key(initial, resolver, sources)? else {
                activity.reliable = false;
                return Ok(());
            };
            let active = object
                .get("members")
                .and_then(Value::as_array)
                .is_some_and(|members| {
                    members.iter().any(|member| {
                        resolver
                            .resolve(member)
                            .ok()
                            .and_then(|member| member.get("kind"))
                            .and_then(Value::as_str)
                            == Some("GenerateBlock")
                    })
                });
            activity
                .loops
                .entry(key)
                .and_modify(|existing| *existing |= active)
                .or_insert(active);
        }
        Some("Instance") => return Ok(()),
        _ => {}
    }
    if let Some(members) = object.get("members").and_then(Value::as_array) {
        for member in members {
            collect_body_activity(member, resolver, sources, activity)?;
        }
    }
    Ok(())
}

fn matched_child_module_key(
    snapshot: &DesignSnapshot,
    instance_indexes: &BTreeMap<String, ModuleInstanceIndex>,
    parent_key: &str,
    child: &serde_json::Map<String, Value>,
    scoped_name: &str,
    resolver: &AstAddressResolver<'_>,
) -> Result<Option<String>, SlangMetadataError> {
    let Some(name) = child.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let source_file = child.get("source_file").and_then(Value::as_str);
    let source_line = child
        .get("source_line")
        .and_then(Value::as_u64)
        .and_then(|line| u32::try_from(line).ok());
    let Some(parent) = instance_indexes.get(parent_key) else {
        return Ok(None);
    };
    let matched = parent
        .scoped
        .get(scoped_name)
        .and_then(Option::as_ref)
        .or_else(|| {
            let candidates = parent.labels.get(name)?;
            if candidates.len() == 1 {
                return candidates.first();
            }
            candidates.iter().find(|candidate| {
                candidate.origins.iter().any(|(origin_file, origin_line)| {
                    source_line == Some(*origin_line)
                        && source_file
                            .is_none_or(|file| super::paths_match(file, origin_file.as_str()))
                })
            })
        });
    let Some(definition_name) = matched.and_then(|candidate| candidate.definition_name.as_deref())
    else {
        return Ok(None);
    };
    Ok(
        resolve_module_key(snapshot, definition_name, child, resolver)?.or_else(|| {
            snapshot
                .modules
                .contains_key(definition_name)
                .then(|| definition_name.to_owned())
        }),
    )
}

fn collect_module_activity(
    snapshot: &DesignSnapshot,
    instance_indexes: &BTreeMap<String, ModuleInstanceIndex>,
    instance: &serde_json::Map<String, Value>,
    module_key: &str,
    resolver: &AstAddressResolver<'_>,
    sources: &SourceCatalog<'_>,
    output: &mut BTreeMap<String, ModuleActivity>,
) -> Result<(), SlangMetadataError> {
    if let Some(body) = resolver.body(instance)? {
        {
            let activity = output.entry(module_key.to_owned()).or_default();
            let body_name = body.get("name").and_then(Value::as_str);
            let body_path = body
                .get("source_file")
                .and_then(Value::as_str)
                .and_then(|path| sources.unique_ast_path(path));
            match (&activity.source_definition, body_name) {
                (Some(existing), Some(name)) if existing != name => activity.reliable = false,
                (None, Some(name)) => activity.source_definition = Some(name.to_owned()),
                (_, None) => activity.reliable = false,
                _ => {}
            }
            match (&activity.source_path, body_path) {
                (Some(existing), Some(path)) if existing != path => activity.reliable = false,
                (None, Some(path)) => activity.source_path = Some(path.to_owned()),
                (_, None) => activity.reliable = false,
                _ => {}
            }
            collect_body_activity(body, resolver, sources, activity)?;
        }
        for child_match in direct_child_instances(body, resolver)? {
            let Some(child_key) = matched_child_module_key(
                snapshot,
                instance_indexes,
                module_key,
                child_match.instance,
                &child_match.scoped_name,
                resolver,
            )?
            else {
                continue;
            };
            collect_module_activity(
                snapshot,
                instance_indexes,
                child_match.instance,
                &child_key,
                resolver,
                sources,
                output,
            )?;
        }
    }
    Ok(())
}

fn ast_module_activity(
    snapshot: &DesignSnapshot,
    ast: &ResolvedSlangAst<'_>,
    sources: &SourceCatalog<'_>,
) -> Result<BTreeMap<String, ModuleActivity>, SlangMetadataError> {
    let resolver = &ast.resolver;
    let root = find_root_instance(&ast.ast.root, &snapshot.top, resolver)?
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
    let mut output = BTreeMap::new();
    let instance_indexes = index_module_instances(snapshot);
    collect_module_activity(
        snapshot,
        &instance_indexes,
        root,
        &root_key,
        resolver,
        sources,
        &mut output,
    )?;
    Ok(output)
}

struct CstDocumentSeed<'catalog, 'source> {
    sources: &'catalog SourceCatalog<'source>,
}

impl<'de> DeserializeSeed<'de> for CstDocumentSeed<'_, '_> {
    type Value = Vec<CstSource>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct CstDocumentVisitor<'catalog, 'source> {
            sources: &'catalog SourceCatalog<'source>,
        }

        impl<'de> Visitor<'de> for CstDocumentVisitor<'_, '_> {
            type Value = Vec<CstSource>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a Slang CST document")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut output = vec![];
                let mut found_syntax_trees = false;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "syntaxTrees" && !found_syntax_trees {
                        output = map.next_value_seed(CstSyntaxTreesSeed {
                            sources: self.sources,
                        })?;
                        found_syntax_trees = true;
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(output)
            }
        }

        deserializer.deserialize_map(CstDocumentVisitor {
            sources: self.sources,
        })
    }
}

struct CstSyntaxTreesSeed<'catalog, 'source> {
    sources: &'catalog SourceCatalog<'source>,
}

impl<'de> DeserializeSeed<'de> for CstSyntaxTreesSeed<'_, '_> {
    type Value = Vec<CstSource>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct CstSyntaxTreesVisitor<'catalog, 'source> {
            sources: &'catalog SourceCatalog<'source>,
        }

        impl<'de> Visitor<'de> for CstSyntaxTreesVisitor<'_, '_> {
            type Value = Vec<CstSource>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("Slang's syntaxTrees array")
            }

            fn visit_seq<S>(self, mut sequence: S) -> Result<Self::Value, S::Error>
            where
                S: SeqAccess<'de>,
            {
                let mut output = vec![];
                while let Some(syntax_tree) = sequence.next_element::<OrderedJson>()? {
                    let Some(root) = syntax_tree.take_field("root") else {
                        continue;
                    };
                    let mut renderer = CstRenderer::default();
                    renderer.render(&root, None);
                    let Some(path) = self.sources.unique_content_path(&renderer.text) else {
                        continue;
                    };
                    output.push(CstSource {
                        path: path.to_owned(),
                        if_generates: renderer.if_generates,
                        loop_generates: renderer.loop_generates,
                        case_generates: renderer.case_generates,
                    });
                }
                Ok(output)
            }
        }

        deserializer.deserialize_seq(CstSyntaxTreesVisitor {
            sources: self.sources,
        })
    }
}

fn parse_cst_sources(
    cst_json: &str,
    sources: &SourceCatalog<'_>,
) -> Result<Vec<CstSource>, SlangMetadataError> {
    // Keep only one ordered syntax tree resident at a time. The input string
    // remains borrowed, while each processed token tree and its reconstructed
    // source text are released before the next tree is deserialized.
    let mut deserializer = serde_json::Deserializer::from_str(cst_json);
    let output = CstDocumentSeed { sources }.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(output)
}

fn cst_key(path: &str, range: CstRange) -> SourceKey {
    SourceKey {
        path: path.to_owned(),
        line: range.start.line,
        column: range.start.column,
    }
}

fn insert_range(
    ranges: &mut BTreeMap<(String, u32, u32, u32, u32), bool>,
    path: &str,
    range: CstRange,
    active: bool,
) {
    ranges
        .entry((
            path.to_owned(),
            range.start.line,
            range.start.column,
            range.end.line,
            range.end.column,
        ))
        .and_modify(|existing| *existing |= active)
        .or_insert(active);
}

fn activity_keys_correlate(
    activity: &ModuleActivity,
    source: &CstSource,
    definition: &str,
) -> bool {
    let if_keys: BTreeSet<_> = source
        .if_generates
        .iter()
        .filter(|generate| generate.module == definition)
        .map(|generate| cst_key(&source.path, generate.condition))
        .collect();
    let loop_keys: BTreeSet<_> = source
        .loop_generates
        .iter()
        .filter(|generate| generate.module == definition)
        .map(|generate| cst_key(&source.path, generate.initial))
        .collect();
    let case_keys: BTreeSet<_> = source
        .case_generates
        .iter()
        .filter(|generate| generate.module == definition)
        .map(|generate| cst_key(&source.path, generate.condition))
        .collect();

    activity.ifs.keys().all(|key| if_keys.contains(key))
        && activity.loops.keys().all(|key| loop_keys.contains(key))
        && activity.cases.keys().all(|key| case_keys.contains(key))
}

/// Returns generate activity keyed by the Nettle module graph that owns it.
///
/// Source text and AST paths must each resolve to exactly one bundled file.
/// Ambiguous identical-content files or basename-only paths are skipped rather
/// than assigning activity to the wrong source. Every AST condition key must
/// also correlate with the reconstructed CST before missing branches can be
/// interpreted as inactive.
pub fn extract_slang_elaboration_ranges<'a>(
    snapshot: &DesignSnapshot,
    ast: &ResolvedSlangAst<'_>,
    cst_json: &str,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<BTreeMap<String, Vec<SourceElaborationRange>>, SlangMetadataError> {
    let sources = SourceCatalog::new(sources);
    let activities = ast_module_activity(snapshot, ast, &sources)?;
    let cst_sources = parse_cst_sources(cst_json, &sources)?;
    let mut modules: BTreeMap<(&str, &str), Vec<&CstSource>> = BTreeMap::new();
    for source in &cst_sources {
        for module in source
            .if_generates
            .iter()
            .map(|generate| generate.module.as_str())
            .chain(
                source
                    .loop_generates
                    .iter()
                    .map(|generate| generate.module.as_str()),
            )
            .chain(
                source
                    .case_generates
                    .iter()
                    .map(|generate| generate.module.as_str()),
            )
        {
            let entry = modules.entry((source.path.as_str(), module)).or_default();
            if !entry.iter().any(|existing| std::ptr::eq(*existing, source)) {
                entry.push(source);
            }
        }
    }

    let mut output = BTreeMap::new();
    for (module_key, activity) in activities {
        if !activity.reliable {
            continue;
        }
        let Some(_slice) = snapshot.modules.get(&module_key) else {
            continue;
        };
        let (Some(source_path), Some(definition)) = (
            activity.source_path.as_deref(),
            activity.source_definition.as_deref(),
        ) else {
            continue;
        };
        let Some(matching_sources) = modules.get(&(source_path, definition)) else {
            continue;
        };
        let [source] = matching_sources.as_slice() else {
            continue;
        };
        if !activity_keys_correlate(&activity, source, definition) {
            continue;
        }
        let mut ranges = BTreeMap::new();
        for generate in source
            .if_generates
            .iter()
            .filter(|generate| generate.module == definition)
        {
            let key = cst_key(&source.path, generate.condition);
            let selected = activity.ifs.get(&key);
            if selected.is_none() && generate.else_branch.is_some() {
                continue;
            }
            let true_branch = selected.is_some_and(|selected| selected.true_branch);
            let false_branch = selected.is_some_and(|selected| selected.false_branch);
            insert_range(&mut ranges, &source.path, generate.construct, true);
            insert_range(&mut ranges, &source.path, generate.then_branch, true_branch);
            if let Some(else_branch) = generate.else_branch {
                insert_range(&mut ranges, &source.path, else_branch, false_branch);
            }
        }
        for generate in source
            .loop_generates
            .iter()
            .filter(|generate| generate.module == definition)
        {
            let Some(active) = activity.loops.get(&cst_key(&source.path, generate.initial)) else {
                continue;
            };
            insert_range(&mut ranges, &source.path, generate.construct, true);
            insert_range(&mut ranges, &source.path, generate.block, *active);
        }
        for generate in source
            .case_generates
            .iter()
            .filter(|generate| generate.module == definition)
        {
            let selected = activity
                .cases
                .get(&cst_key(&source.path, generate.condition));
            if selected.is_none() && generate.items.iter().any(|item| item.default) {
                continue;
            }
            insert_range(&mut ranges, &source.path, generate.construct, true);
            for item in &generate.items {
                let active = selected.is_some_and(|selected| {
                    if item.default {
                        selected.default_selected
                    } else {
                        item.selector.is_some_and(|selector| {
                            selected
                                .selectors
                                .contains(&(selector.start.line, selector.start.column))
                        })
                    }
                });
                insert_range(&mut ranges, &source.path, item.range, active);
            }
        }
        output.insert(
            module_key,
            ranges
                .into_iter()
                .map(
                    |((file, start_line, start_column, end_line, end_column), active)| {
                        SourceElaborationRange {
                            file,
                            start_line,
                            start_column,
                            end_line,
                            end_column,
                            active,
                        }
                    },
                )
                .collect(),
        );
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        GraphModule, GraphNode, GraphSlice, NodeKind, ParsedSlangAst, SourceFileRef, stable_id,
    };

    const SOURCE: &str = "module leaf;\n  if (ENABLE) begin : yes\n    wire y;\n  end\n  case (MODE)\n    0: begin : zero\n      wire z;\n    end\n    default: begin : other\n      wire q;\n    end\n  endcase\nendmodule\n";

    const CST: &str = r#"{
      "syntaxTrees": [{
        "kind": "SyntaxTree",
        "root": {
          "kind": "CompilationUnit",
          "module": {
            "kind": "ModuleDeclaration",
            "header": {
              "kind": "ModuleHeader",
              "moduleKeyword": {"kind": "ModuleKeyword", "text": "module"},
              "name": {"kind": "Identifier", "text": "leaf", "trivia": " "},
              "semi": {"kind": "Semicolon", "text": ";"}
            },
            "members": [{
              "kind": "IfGenerate",
              "keyword": {"kind": "IfKeyword", "text": "if", "trivia": "\n  "},
              "openParen": {"kind": "OpenParenthesis", "text": "(", "trivia": " "},
              "condition": {"kind": "IdentifierName", "identifier": {"kind": "Identifier", "text": "ENABLE"}},
              "closeParen": {"kind": "CloseParenthesis", "text": ")"},
              "block": {
                "kind": "GenerateBlock",
                "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                "beginName": {
                  "kind": "NamedBlockClause",
                  "colon": {"kind": "Colon", "text": ":", "trivia": " "},
                  "name": {"kind": "Identifier", "text": "yes", "trivia": " "}
                },
                "members": [{
                  "kind": "NetDeclaration",
                  "netType": {"kind": "WireKeyword", "text": "wire", "trivia": "\n    "},
                  "declarators": [{"kind": "Declarator", "name": {"kind": "Identifier", "text": "y", "trivia": " "}}],
                  "semi": {"kind": "Semicolon", "text": ";"}
                }],
                "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n  "}
              }
            }, {
              "kind": "CaseGenerate",
              "keyword": {"kind": "CaseKeyword", "text": "case", "trivia": "\n  "},
              "openParen": {"kind": "OpenParenthesis", "text": "(", "trivia": " "},
              "condition": {"kind": "IdentifierName", "identifier": {"kind": "Identifier", "text": "MODE"}},
              "closeParen": {"kind": "CloseParenthesis", "text": ")"},
              "items": [{
                "kind": "StandardCaseItem",
                "expressions": [{"kind": "IntegerLiteralExpression", "literal": {"kind": "IntegerLiteral", "text": "0", "trivia": "\n    "}}],
                "colon": {"kind": "Colon", "text": ":"},
                "clause": {
                  "kind": "GenerateBlock",
                  "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                  "beginName": {
                    "kind": "NamedBlockClause",
                    "colon": {"kind": "Colon", "text": ":", "trivia": " "},
                    "name": {"kind": "Identifier", "text": "zero", "trivia": " "}
                  },
                  "members": [{
                    "kind": "NetDeclaration",
                    "netType": {"kind": "WireKeyword", "text": "wire", "trivia": "\n      "},
                    "declarators": [{"kind": "Declarator", "name": {"kind": "Identifier", "text": "z", "trivia": " "}}],
                    "semi": {"kind": "Semicolon", "text": ";"}
                  }],
                  "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n    "}
                }
              }, {
                "kind": "DefaultCaseItem",
                "defaultKeyword": {"kind": "DefaultKeyword", "text": "default", "trivia": "\n    "},
                "colon": {"kind": "Colon", "text": ":"},
                "clause": {
                  "kind": "GenerateBlock",
                  "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                  "beginName": {
                    "kind": "NamedBlockClause",
                    "colon": {"kind": "Colon", "text": ":", "trivia": " "},
                    "name": {"kind": "Identifier", "text": "other", "trivia": " "}
                  },
                  "members": [{
                    "kind": "NetDeclaration",
                    "netType": {"kind": "WireKeyword", "text": "wire", "trivia": "\n      "},
                    "declarators": [{"kind": "Declarator", "name": {"kind": "Identifier", "text": "q", "trivia": " "}}],
                    "semi": {"kind": "Semicolon", "text": ";"}
                  }],
                  "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n    "}
                }
              }],
              "endCase": {"kind": "EndCaseKeyword", "text": "endcase", "trivia": "\n  "}
            }],
            "endmodule": {"kind": "EndModuleKeyword", "text": "endmodule", "trivia": "\n"}
          },
          "endOfFile": {"kind": "EndOfFile", "text": "", "trivia": "\n"}
        }
      }]
    }"#;

    const BASIC_SOURCE: &str = "module top;\n  for (genvar i=0;i<1;i++) begin : g\n    if (USE_XOR) begin : yes\n      wire y;\n    end else begin : no\n      wire z;\n    end\n  end\nendmodule\n";

    const BASIC_CST: &str = r#"{
      "syntaxTrees": [{
        "kind": "SyntaxTree",
        "root": {
          "kind": "CompilationUnit",
          "module": {
            "kind": "ModuleDeclaration",
            "header": {
              "kind": "ModuleHeader",
              "moduleKeyword": {"kind": "ModuleKeyword", "text": "module"},
              "name": {"kind": "Identifier", "text": "top", "trivia": " "},
              "semi": {"kind": "Semicolon", "text": ";"}
            },
            "members": [{
              "kind": "LoopGenerate",
              "keyword": {"kind": "ForKeyword", "text": "for", "trivia": "\n  "},
              "openAndGenvar": {"kind": "Token", "text": "(genvar i=", "trivia": " "},
              "initialExpr": {"kind": "IntegerLiteralExpression", "literal": {"kind": "IntegerLiteral", "text": "0"}},
              "rest": {"kind": "Token", "text": ";i<1;i++)"},
              "block": {
                "kind": "GenerateBlock",
                "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                "name": {"kind": "Identifier", "text": "g", "trivia": " : "},
                "members": [{
                  "kind": "IfGenerate",
                  "keyword": {"kind": "IfKeyword", "text": "if", "trivia": "\n    "},
                  "openParen": {"kind": "OpenParenthesis", "text": "(", "trivia": " "},
                  "condition": {"kind": "IdentifierName", "identifier": {"kind": "Identifier", "text": "USE_XOR"}},
                  "closeParen": {"kind": "CloseParenthesis", "text": ")"},
                  "block": {
                    "kind": "GenerateBlock",
                    "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                    "name": {"kind": "Identifier", "text": "yes", "trivia": " : "},
                    "member": {"kind": "Token", "text": "wire y;", "trivia": "\n      "},
                    "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n    "}
                  },
                  "elseClause": {
                    "kind": "ElseClause",
                    "elseKeyword": {"kind": "ElseKeyword", "text": "else", "trivia": " "},
                    "clause": {
                      "kind": "GenerateBlock",
                      "begin": {"kind": "BeginKeyword", "text": "begin", "trivia": " "},
                      "name": {"kind": "Identifier", "text": "no", "trivia": " : "},
                      "member": {"kind": "Token", "text": "wire z;", "trivia": "\n      "},
                      "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n    "}
                    }
                  }
                }],
                "end": {"kind": "EndKeyword", "text": "end", "trivia": "\n  "}
              }
            }],
            "endmodule": {"kind": "EndModuleKeyword", "text": "endmodule", "trivia": "\n"}
          },
          "endOfFile": {"kind": "EndOfFile", "text": "", "trivia": "\n"}
        }
      }]
    }"#;

    fn module_slice(name: &str, definition_name: &str, nodes: Vec<GraphNode>) -> GraphSlice {
        GraphSlice {
            snapshot_id: "snapshot".to_owned(),
            module: GraphModule {
                id: stable_id("module", name),
                name: name.to_owned(),
                instance_path: name.to_owned(),
                definition_name: definition_name.to_owned(),
                parameters: BTreeMap::new(),
                attributes: BTreeMap::new(),
            },
            nodes,
            edges: vec![],
            groups: vec![],
            files: Some(vec![SourceFileRef {
                id: stable_id("file", "rtl/leaf.sv"),
                path: "rtl/leaf.sv".to_owned(),
            }]),
            elaboration_ranges: vec![],
        }
    }

    fn instance(name: &str, definition_name: &str) -> GraphNode {
        GraphNode {
            id: stable_id("node", name),
            kind: NodeKind::ModuleInstance,
            label: name.to_owned(),
            definition_name: Some(definition_name.to_owned()),
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            ports: vec![],
            origins: vec![],
        }
    }

    fn snapshot() -> DesignSnapshot {
        DesignSnapshot {
            snapshot_id: "snapshot".to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([
                (
                    "leaf$top.u_zero".to_owned(),
                    module_slice("leaf$top.u_zero", "leaf$top.u_zero", vec![]),
                ),
                (
                    "leaf$top.u_one".to_owned(),
                    module_slice("leaf$top.u_one", "leaf$top.u_one", vec![]),
                ),
                (
                    "top".to_owned(),
                    module_slice(
                        "top",
                        "top",
                        vec![
                            instance("u_zero", "leaf$top.u_zero"),
                            instance("u_one", "leaf$top.u_one"),
                        ],
                    ),
                ),
            ]),
        }
    }

    fn generate_block(branch: &str, case: &str) -> String {
        let if_block = (branch == "IfTrue").then_some({
            r#"{
              "kind": "GenerateBlock",
              "branchKind": "IfTrue",
              "conditionExpression": {
                "source_file_start": "rtl/leaf.sv",
                "source_line_start": 2,
                "source_column_start": 7
              },
              "members": []
            }"#
        });
        let case_block = if case == "default" {
            r#"{
              "kind": "GenerateBlock",
              "branchKind": "CaseDefault",
              "conditionExpression": {
                "source_file_start": "rtl/leaf.sv",
                "source_line_start": 5,
                "source_column_start": 9
              },
              "members": []
            }"#
            .to_owned()
        } else {
            r#"{
              "kind": "GenerateBlock",
              "branchKind": "CaseItem",
              "conditionExpression": {
                "source_file_start": "rtl/leaf.sv",
                "source_line_start": 5,
                "source_column_start": 9
              },
              "caseItemExpressions": [{
                "source_file_start": "rtl/leaf.sv",
                "source_line_start": 6,
                "source_column_start": 5
              }],
              "members": []
            }"#
            .to_owned()
        };
        [if_block.map(str::to_owned), Some(case_block)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(",")
    }

    fn ast() -> ParsedSlangAst {
        let zero = generate_block("IfFalse", "item");
        let one = generate_block("IfTrue", "default");
        ParsedSlangAst::parse(&format!(
            r#"{{
              "design": {{"members": [{{
                "kind": "Instance",
                "name": "top",
                "body": {{
                  "kind": "InstanceBody",
                  "name": "top",
                  "source_file": "rtl/leaf.sv",
                  "members": [{{
                    "kind": "Instance",
                    "name": "u_zero",
                    "body": {{
                      "kind": "InstanceBody",
                      "name": "leaf",
                      "source_file": "rtl/leaf.sv",
                      "members": [{zero}]
                    }}
                  }}, {{
                    "kind": "Instance",
                    "name": "u_one",
                    "body": {{
                      "kind": "InstanceBody",
                      "name": "leaf",
                      "source_file": "rtl/leaf.sv",
                      "members": [{one}]
                    }}
                  }}]
                }}
              }}]}}
            }}"#
        ))
        .unwrap()
    }

    fn ast_with_one_condition_lines(
        if_condition_line: u32,
        case_condition_line: u32,
    ) -> ParsedSlangAst {
        let mut ast = ast();
        *ast.root
            .pointer_mut(
                "/design/members/0/body/members/1/body/members/0/conditionExpression/source_line_start",
            )
            .unwrap() = Value::from(if_condition_line);
        *ast.root
            .pointer_mut(
                "/design/members/0/body/members/1/body/members/1/conditionExpression/source_line_start",
            )
            .unwrap() = Value::from(case_condition_line);
        ast
    }

    fn ranges() -> BTreeMap<String, Vec<SourceElaborationRange>> {
        let snapshot = snapshot();
        let ast = ast();
        let resolved = ast.resolve().unwrap();
        extract_slang_elaboration_ranges(&snapshot, &resolved, CST, [("rtl/leaf.sv", SOURCE)])
            .unwrap()
    }

    fn basic_ranges(
        branch: Option<&str>,
        loop_active: bool,
        source: &str,
    ) -> BTreeMap<String, Vec<SourceElaborationRange>> {
        let branch = branch.map_or_else(String::new, |branch| {
            format!(
                r#"{{
                  "kind": "GenerateBlock",
                  "branchKind": "{branch}",
                  "conditionExpression": {{
                    "source_file_start": "rtl/top.sv",
                    "source_line_start": 3,
                    "source_column_start": 9
                  }},
                  "members": []
                }}"#
            )
        });
        let loop_member = if loop_active {
            format!(
                r#", {{
                  "kind": "GenerateBlock",
                  "branchKind": "LoopIteration",
                  "members": [{branch}]
                }}"#
            )
        } else {
            String::new()
        };
        let ast = ParsedSlangAst::parse(&format!(
            r#"{{
              "design": {{"members": [{{
                "kind": "Instance",
                "name": "top",
                "body": {{
                  "kind": "InstanceBody",
                  "name": "top",
                  "source_file": "rtl/top.sv",
                  "members": [{{
                    "kind": "GenerateBlockArray",
                    "initialExpression": {{
                      "source_file_start": "rtl/top.sv",
                      "source_line_start": 2,
                      "source_column_start": 17
                    }},
                    "members": [{{"kind": "Genvar"}}{loop_member}]
                  }}]
                }}
              }}]}}
            }}"#
        ))
        .unwrap();
        let snapshot = DesignSnapshot {
            snapshot_id: "snapshot".to_owned(),
            top: "top".to_owned(),
            tops: vec!["top".to_owned()],
            modules: BTreeMap::from([("top".to_owned(), module_slice("top", "top", vec![]))]),
        };
        let resolved = ast.resolve().unwrap();
        extract_slang_elaboration_ranges(&snapshot, &resolved, BASIC_CST, [("rtl/top.sv", source)])
            .unwrap()
    }

    #[test]
    fn scopes_opposite_parameterized_instances_to_their_specialized_modules() {
        let ranges = ranges();
        let zero = &ranges["leaf$top.u_zero"];
        let one = &ranges["leaf$top.u_one"];
        assert!(
            zero.iter()
                .any(|range| range.start_line == 2 && !range.active)
        );
        assert!(
            one.iter()
                .any(|range| range.start_line == 2 && range.active)
        );
    }

    #[test]
    fn infers_a_false_if_without_an_else_from_the_missing_ast_block() {
        let ranges = ranges();
        assert!(
            ranges["leaf$top.u_zero"]
                .iter()
                .any(|range| range.start_line == 2 && !range.active)
        );
    }

    #[test]
    fn correlates_standard_and_default_case_generate_items() {
        let ranges = ranges();
        let zero = &ranges["leaf$top.u_zero"];
        assert!(
            zero.iter()
                .any(|range| range.start_line == 6 && range.active)
        );
        assert!(
            zero.iter()
                .any(|range| range.start_line == 9 && !range.active)
        );
        let one = &ranges["leaf$top.u_one"];
        assert!(
            one.iter()
                .any(|range| range.start_line == 6 && !range.active)
        );
        assert!(
            one.iter()
                .any(|range| range.start_line == 9 && range.active)
        );
    }

    #[test]
    fn unmatched_ast_if_condition_omits_module_activity() {
        let snapshot = snapshot();
        let ast = ast_with_one_condition_lines(3, 5);
        let resolved = ast.resolve().unwrap();
        let ranges =
            extract_slang_elaboration_ranges(&snapshot, &resolved, CST, [("rtl/leaf.sv", SOURCE)])
                .unwrap();

        assert!(!ranges.contains_key("leaf$top.u_one"));
    }

    #[test]
    fn unmatched_ast_case_condition_omits_module_activity() {
        let snapshot = snapshot();
        let ast = ast_with_one_condition_lines(2, 4);
        let resolved = ast.resolve().unwrap();
        let ranges =
            extract_slang_elaboration_ranges(&snapshot, &resolved, CST, [("rtl/leaf.sv", SOURCE)])
                .unwrap();

        assert!(!ranges.contains_key("leaf$top.u_one"));
    }

    #[test]
    fn ignores_cst_text_shared_by_multiple_source_paths() {
        let snapshot = snapshot();
        let ast = ast();
        let resolved = ast.resolve().unwrap();
        let ranges = extract_slang_elaboration_ranges(
            &snapshot,
            &resolved,
            CST,
            [("rtl/leaf.sv", SOURCE), ("copy/leaf.sv", SOURCE)],
        )
        .unwrap();
        assert!(ranges.is_empty());
    }

    #[test]
    fn resolves_the_longest_unique_path_suffix_without_scanning_sources() {
        let catalog = SourceCatalog::new([
            ("rtl/top.sv", "one"),
            ("sub/rtl/top.sv", "two"),
            ("other.sv", "three"),
        ]);
        assert_eq!(
            catalog.unique_ast_path("/workspace/sub/rtl/top.sv"),
            Some("sub/rtl/top.sv")
        );
        assert_eq!(catalog.unique_ast_path("rtl/top.sv"), None);
    }

    #[test]
    fn preserves_if_else_branch_polarity() {
        let true_ranges = basic_ranges(Some("IfTrue"), true, BASIC_SOURCE);
        let false_ranges = basic_ranges(Some("IfFalse"), true, BASIC_SOURCE);
        let true_inactive: Vec<_> = true_ranges["top"]
            .iter()
            .filter(|range| !range.active)
            .collect();
        let false_inactive: Vec<_> = false_ranges["top"]
            .iter()
            .filter(|range| !range.active)
            .collect();
        assert_eq!(true_inactive.len(), 1);
        assert_eq!(true_inactive[0].start_line, 5);
        assert_eq!(false_inactive.len(), 1);
        assert_eq!(false_inactive[0].start_line, 3);
    }

    #[test]
    fn marks_a_zero_iteration_loop_body_inactive() {
        let ranges = basic_ranges(None, false, BASIC_SOURCE);
        assert!(
            ranges["top"]
                .iter()
                .any(|range| range.start_line == 2 && !range.active)
        );
    }

    #[test]
    fn exact_reconstructed_source_mismatch_fails_closed() {
        let ranges = basic_ranges(Some("IfTrue"), true, "module different; endmodule\n");
        assert!(ranges.is_empty());
    }

    #[test]
    fn unknown_ast_generate_branch_kind_fails_closed() {
        let ranges = basic_ranges(Some("FutureBranch"), true, BASIC_SOURCE);
        assert!(ranges.is_empty());
    }

    #[test]
    fn condition_bearing_ast_block_without_branch_kind_fails_closed() {
        let block = serde_json::json!({
            "kind": "GenerateBlock",
            "conditionExpression": {}
        });
        let resolver = AstAddressResolver::new(&block).unwrap();
        let sources = SourceCatalog::new([("rtl/top.sv", BASIC_SOURCE)]);
        let mut activity = ModuleActivity::default();

        collect_body_activity(&block, &resolver, &sources, &mut activity).unwrap();

        assert!(!activity.reliable);
    }
}
