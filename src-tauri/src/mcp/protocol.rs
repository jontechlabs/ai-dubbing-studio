use serde_json::{json, Value};
use std::sync::LazyLock;

pub const MAX_BYTES: u64 = 32 * 1024 * 1024;
pub static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/mcp/catalog.json"))
        .expect("Generated MCP catalog")
});
pub fn tools() -> Vec<Value> {
    CATALOG["commands"]
        .as_array()
        .unwrap()
        .iter()
        .chain(CATALOG["builtins"].as_array().unwrap())
        .map(|entry| {
            let mut entry = entry.clone();
            entry.as_object_mut().unwrap().remove("command");
            entry
        })
        .collect()
}
pub fn tool(name: &str) -> Option<&'static Value> {
    CATALOG["commands"]
        .as_array()?
        .iter()
        .chain(CATALOG["builtins"].as_array()?)
        .find(|entry| entry["name"] == name)
}
pub fn validate(schema: &Value, value: &Value) -> bool {
    fn check(root: &Value, schema: &Value, value: &Value, depth: usize) -> bool {
        if depth > 128 {
            return false;
        }
        if let Some(reference) = schema["$ref"].as_str() {
            return reference
                .strip_prefix('#')
                .and_then(|path| root.pointer(path))
                .is_some_and(|schema| check(root, schema, value, depth + 1));
        }
        if let Some(choices) = schema["anyOf"].as_array() {
            return choices.iter().any(|s| check(root, s, value, depth + 1));
        }
        if schema.get("const").is_some_and(|c| c != value) {
            return false;
        }
        if schema["enum"]
            .as_array()
            .is_some_and(|choices| !choices.contains(value))
        {
            return false;
        }
        let typed = match schema["type"].as_str() {
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("null") => value.is_null(),
            Some("number") => value.is_number(),
            Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
            None => true,
            _ => false,
        };
        if !typed {
            return false;
        }
        if let Some(number) = value.as_f64() {
            if schema["minimum"].as_f64().is_some_and(|n| number < n)
                || schema["maximum"].as_f64().is_some_and(|n| number > n)
            {
                return false;
            }
        }
        if let Some(items) = value.as_array() {
            if schema["minItems"]
                .as_u64()
                .is_some_and(|n| items.len() < n as usize)
                || schema["maxItems"]
                    .as_u64()
                    .is_some_and(|n| items.len() > n as usize)
            {
                return false;
            }
            if let Some(item_schema) = schema.get("items") {
                if !items
                    .iter()
                    .all(|item| check(root, item_schema, item, depth + 1))
                {
                    return false;
                }
            }
        }
        if let Some(object) = value.as_object() {
            if schema["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|key| !object.contains_key(key.as_str().unwrap_or("")))
            }) {
                return false;
            }
            for (key, value) in object {
                if let Some(child) = schema["properties"].get(key) {
                    if !check(root, child, value, depth + 1) {
                        return false;
                    }
                } else if schema["additionalProperties"] == false
                    || (schema["additionalProperties"].is_object()
                        && !check(root, &schema["additionalProperties"], value, depth + 1))
                {
                    return false;
                }
            }
        }
        true
    }
    check(schema, schema, value, 0)
}
pub fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
#[derive(Clone, Default)]
pub struct Session {
    initialized: bool,
    ready: bool,
}
impl Session {
    pub fn handle(
        &mut self,
        request: Value,
        execute: impl Fn(&str, Value) -> Result<Value, String>,
    ) -> Option<Value> {
        let id = request.get("id").cloned();
        if request["jsonrpc"] != "2.0"
            || !request["method"].is_string()
            || id
                .as_ref()
                .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        {
            return Some(error(Value::Null, -32600, "Invalid JSON-RPC request"));
        }
        let method = request["method"].as_str().unwrap();
        let params = &request["params"];
        if id.is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let id = id.unwrap();
        let ok = |result| Some(json!({"jsonrpc":"2.0","id":id,"result":result}));
        if method == "initialize" {
            if self.initialized
                || !params["protocolVersion"].is_string()
                || !params["clientInfo"].is_object()
                || !params["capabilities"].is_object()
            {
                return Some(error(id, -32602, "Invalid initialization"));
            }
            self.initialized = true;
            let requested = params["protocolVersion"].as_str().unwrap();
            let version = if ["2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) {
                requested
            } else {
                "2025-11-25"
            };
            return ok(
                json!({"protocolVersion":version,"capabilities":{"tools":{},"resources":{}},
                "serverInfo":{"name":"ai-dubbing-studio","version":env!("CARGO_PKG_VERSION")},
                "instructions":"Controls the open local desktop after MCP is enabled in Settings. Start with studio_get_state and studio://guide. Saved mutations require the current context. Heavy operations return job IDs: poll studio_list_jobs; use studio_cancel_job to cancel. No remote service, shell or code evaluation."}),
            );
        }
        if method == "ping" {
            return ok(json!({}));
        }
        if !self.ready {
            return Some(error(id, -32002, "Initialize the MCP session first"));
        }
        match method {
            "tools/list" => {
                if params.get("cursor").is_some_and(|v| !v.is_null()) {
                    return Some(error(id, -32602, "Invalid cursor"));
                }
                ok(json!({"tools":tools()}))
            }
            "tools/call" => {
                let Some(name) = params["name"].as_str() else {
                    return Some(error(id, -32602, "Missing tool name"));
                };
                let Some(tool) = tool(name) else {
                    return Some(error(id, -32602, "Unknown tool"));
                };
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                if !validate(&tool["inputSchema"], &arguments) {
                    return Some(error(id, -32602, "Arguments do not match the tool schema"));
                }
                match execute(name, arguments) {
                    Ok(value) => ok(
                        json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":{"value":value},"isError":false}),
                    ),
                    Err(message) => {
                        ok(json!({"content":[{"type":"text","text":message}],"isError":true}))
                    }
                }
            }
            "resources/list" => {
                let mut resources = vec![
                    json!({"uri":"studio://guide","name":"Desktop automation guide","mimeType":"text/markdown"}),
                    json!({"uri":"studio://project","name":"Current project","mimeType":"application/json"}),
                    json!({"uri":"studio://state","name":"Current desktop state","mimeType":"application/json"}),
                ];
                for name in CATALOG["schemas"].as_object().unwrap().keys() {
                    resources.push(json!({"uri":format!("studio://schemas/{name}"),"name":format!("{name} JSON schema"),"mimeType":"application/schema+json"}));
                }
                ok(json!({"resources":resources}))
            }
            "resources/read" => {
                let uri = params["uri"].as_str().unwrap_or("");
                let result = match uri {
                    "studio://guide" => Ok((
                        "text/markdown",
                        include_str!("../../../docs/MCP.md").to_owned(),
                    )),
                    "studio://project" => execute("studio_get_project", json!({}))
                        .map(|v| ("application/json", v.to_string())),
                    "studio://state" => execute("studio_get_state", json!({}))
                        .map(|v| ("application/json", v.to_string())),
                    _ => uri
                        .strip_prefix("studio://schemas/")
                        .and_then(|name| CATALOG["schemas"].get(name))
                        .map(|v| ("application/schema+json", v.to_string()))
                        .ok_or("MCP_RESOURCE_NOT_FOUND".into()),
                };
                match result {
                    Ok((mime, text)) => {
                        ok(json!({"contents":[{"uri":uri,"mimeType":mime,"text":text}]}))
                    }
                    Err(message) => Some(error(id, -32002, &message)),
                }
            }
            _ => Some(error(id, -32601, "Method not found")),
        }
    }
}
