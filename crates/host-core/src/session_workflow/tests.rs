use super::*;
use crate::sessions;

fn session(db: &Database) -> String {
    sessions::create_session(db, None, Some("agent".into()), None, None, None)
        .unwrap()
        .id
}

fn configured() -> Value {
    json!({ "mode": "auto", "workflow": "quick", "codingMode": "split",
        "executionModel": "claude/opus", "reviewModel": "pro/gpt", "maxConcurrency": 8 })
}

#[test]
fn session_choices_are_independent_durable_and_preserve_legacy_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let legacy = json!({"collaboration": configured(), "language": "zh-CN", "theme": "dark"});
    db.set_setting("app", &legacy).unwrap();
    let a = session(&db);
    let b = session(&db);
    let automatic = get(&db, &a).unwrap();
    assert_eq!(automatic["workflow"], "quick");
    assert_eq!(automatic["codingMode"], "split");
    assert_eq!(automatic["reviewModel"], "pro/gpt");
    let mut locked = automatic.clone();
    locked["workflow"] = json!("deep");
    set(&db, &a, &locked).unwrap();
    assert_eq!(get(&db, &b).unwrap(), automatic);
    assert_eq!(db.get_setting("app").unwrap(), Some(legacy.clone()));
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, &a).unwrap(), locked);
    assert_eq!(get(&db, &b).unwrap(), automatic);
    set(&db, &a, &automatic).unwrap();
    assert_eq!(get(&db, &a).unwrap(), automatic);
    assert_eq!(db.get_setting("app").unwrap(), Some(legacy));
}

#[test]
fn validates_owner_and_choices_before_writing_and_refuses_running_turns() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let id = session(&db);
    let before = get(&db, &id).unwrap();
    let mut invalid = configured();
    invalid["workflow"] = json!("arbitrary");
    assert!(set(&db, &id, &invalid).is_err());
    assert!(set(&db, "missing", &configured()).is_err());
    assert!(get(&db, "native-pi:test").is_err());
    let turn = sessions::begin_turn(&db, &id, None, None).unwrap();
    assert!(set(&db, &id, &configured())
        .unwrap_err()
        .to_string()
        .contains("PLAN_CONFIGURATION_BLOCKED"));
    assert_eq!(get(&db, &id).unwrap(), before);
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    set(&db, &id, &configured()).unwrap();
    assert_eq!(get(&db, &id).unwrap(), configured());
}

#[test]
fn copying_and_deleting_preserve_other_conversations() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let a = session(&db);
    let b = session(&db);
    set(&db, &a, &configured()).unwrap();
    copy(&db, &a, &b).unwrap();
    assert_eq!(get(&db, &b).unwrap(), configured());
    sessions::delete_session(&db, &a).unwrap();
    assert!(db.kv_get(NAMESPACE, &a).unwrap().is_none());
    assert_eq!(get(&db, &b).unwrap(), configured());
}

#[test]
fn existing_read_only_and_single_writer_preferences_survive_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let mut readonly = configured();
    readonly["workflow"] = json!("review");
    readonly["codingMode"] = json!("primary");
    db.set_setting("app", &json!({"collaboration": readonly}))
        .unwrap();
    let id = session(&db);
    assert_eq!(get(&db, &id).unwrap(), readonly);
    let mut automatic = readonly.clone();
    automatic["workflow"] = json!("auto");
    automatic["codingMode"] = json!("auto");
    set(&db, &id, &automatic).unwrap();
    assert_eq!(get(&db, &id).unwrap(), automatic);
}
