use serde_json::Value;

/// Optional settings preserve the existing behavior of old installations.
pub fn validate_settings(settings: &Value) -> Result<(), &'static str> {
    let Some(value) = settings.get("collaboration") else {
        return Ok(());
    };
    let valid = || -> Option<bool> {
        let mode = value.get("mode")?.as_str()?;
        let execution = value.get("executionModel")?.as_str()?;
        let review = value.get("reviewModel")?.as_str()?;
        let concurrency = value.get("maxConcurrency")?.as_u64()?;
        let model_key = |key: &str| {
            key.is_empty()
                || (key.encode_utf16().count() <= 512
                    && key.trim() == key
                    && key
                        .split_once('/')
                        .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty()))
        };
        Some(
            matches!(mode, "off" | "auto" | "deep")
                && value.get("workflow").is_none_or(|preset| {
                    preset.as_str().is_some_and(|preset| {
                        matches!(
                            preset,
                            "auto" | "adaptive" | "quick" | "standard" | "deep" | "review"
                        )
                    })
                })
                && value.get("codingMode").is_none_or(|assignment| {
                    assignment.as_str().is_some_and(|assignment| {
                        matches!(assignment, "auto" | "primary" | "split")
                    })
                })
                && model_key(execution)
                && model_key(review)
                && (mode == "off"
                    || (!execution.is_empty() && !review.is_empty() && execution != review))
                && (1..=10).contains(&concurrency),
        )
    };
    if valid() == Some(true) {
        Ok(())
    } else {
        Err("collaboration settings are invalid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_modes_bindings_and_concurrency() {
        assert!(validate_settings(&json!({})).is_ok());
        let mut settings = json!({"collaboration": {"mode":"auto", "executionModel":"claude/model", "reviewModel":"pro/gpt", "maxConcurrency":8}});
        assert!(validate_settings(&settings).is_ok());
        settings["collaboration"]["workflow"] = json!("standard");
        settings["collaboration"]["codingMode"] = json!("split");
        assert!(validate_settings(&settings).is_ok());
        for invalid in [json!("unknown"), json!(null), json!(8)] {
            settings["collaboration"]["workflow"] = invalid;
            assert!(validate_settings(&settings).is_err());
        }
        settings["collaboration"]["workflow"] = json!("deep");
        settings["collaboration"]["codingMode"] = json!("other");
        assert!(validate_settings(&settings).is_err());
        settings["collaboration"]["codingMode"] = json!("split");
        for invalid in [json!(0), json!(11), json!(1.5), json!("8")] {
            settings["collaboration"]["maxConcurrency"] = invalid;
            assert!(validate_settings(&settings).is_err());
        }
        settings["collaboration"]["maxConcurrency"] = json!(8);
        settings["collaboration"]["reviewModel"] = json!("claude/model");
        assert!(validate_settings(&settings).is_err());
        settings["collaboration"]["mode"] = json!("off");
        settings["collaboration"]["reviewModel"] = json!("");
        assert!(validate_settings(&settings).is_ok());
        settings["collaboration"]["mode"] = json!("always");
        assert!(validate_settings(&settings).is_err());
    }
}
