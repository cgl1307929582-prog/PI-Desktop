use super::{rpc_err, JsonRpcError};
use crate::db::Database;
use serde_json::{json, Value};

pub(super) fn error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let (number, code) = if message.starts_with("NOT_FOUND:") {
        (1007, "NOT_FOUND")
    } else if message.starts_with("PLAN_CONFIGURATION_BLOCKED:") {
        (1008, "PLAN_CONFIGURATION_BLOCKED")
    } else if message.starts_with("INVALID_ARGUMENT:") {
        (1002, "INVALID_PARAMS")
    } else {
        (1000, "INTERNAL")
    };
    rpc_err(number, message, code)
}

pub(super) fn handle(db: &Database, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let settings = match method {
        "session.workflow.get" => crate::session_workflow::get(db, id),
        "session.workflow.set" => {
            let value = params
                .get("settings")
                .ok_or_else(|| rpc_err(1002, "settings required", "INVALID_PARAMS"))?;
            crate::session_workflow::set(db, id, value)
        }
        _ => return Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
    .map_err(error)?;
    Ok(json!({ "settings": settings }))
}
