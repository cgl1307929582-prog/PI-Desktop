//! Per-conversation collaboration preferences use the existing host-owned KV
//! extension boundary. No transcript or database schema is rewritten.
use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};

use crate::db::Database;

pub const NAMESPACE: &str = "session-workflow-v1";

pub fn validate(value: &Value) -> Result<()> {
    crate::collaboration::validate_settings(&json!({ "collaboration": value }))
        .map_err(|message| anyhow!("INVALID_ARGUMENT: {message}"))
}

fn require_session(db: &Database, id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.trim() != id || id.starts_with("native-pi:") {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a Desktop session id is required"
        ));
    }
    if crate::sessions::session_mode(db, id)?.is_none() {
        return Err(anyhow!("NOT_FOUND: session not found"));
    }
    Ok(())
}

/// Snapshot model/channel preferences once. Choosing a workflow later never
/// changes another conversation or the installation's original settings.
pub fn get(db: &Database, id: &str) -> Result<Value> {
    require_session(db, id)?;
    if let Some(value) = db.kv_get(NAMESPACE, id)? {
        validate(&value)?;
        return Ok(value);
    }
    let app = db.get_setting("app")?.unwrap_or_else(|| json!({}));
    let mut value = app.get("collaboration").cloned().unwrap_or_else(|| {
        json!({
            "mode": "off", "executionModel": "", "reviewModel": "", "maxConcurrency": 8
        })
    });
    validate(&value)?;
    if value.get("workflow").is_none() {
        value["workflow"] = json!("auto");
    }
    if value.get("codingMode").is_none() {
        value["codingMode"] = json!("auto");
    }
    db.kv_set(NAMESPACE, id, &value)?;
    Ok(value)
}

pub fn set(db: &Database, id: &str, value: &Value) -> Result<Value> {
    require_session(db, id)?;
    validate(value)?;
    let busy: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id = ?1 AND status = 'running')
         OR EXISTS(SELECT 1 FROM plan_approvals WHERE session_id = ?1
                   AND (status = 'pending' OR execution_state IN ('queued', 'running')))",
        params![id],
        |row| row.get(0),
    )?;
    if busy {
        return Err(anyhow!(
            "PLAN_CONFIGURATION_BLOCKED: wait for the current turn to finish"
        ));
    }
    db.kv_set(NAMESPACE, id, value)?;
    Ok(value.clone())
}

pub fn copy(db: &Database, source: &str, target: &str) -> Result<()> {
    let value = get(db, source)?;
    db.kv_set(NAMESPACE, target, &value)
}

#[cfg(test)]
mod tests;
