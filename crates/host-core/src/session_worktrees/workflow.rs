//! Bind a workflow to an existing checkout without creating, committing,
//! merging or deleting user-owned worktrees. Tools revalidate this binding.
use std::path::{Path, PathBuf};

use super::{git::GitRunner, WorktreeError};

fn blocked(message: impl Into<String>) -> WorktreeError {
    WorktreeError::new("WORKTREE_WORKFLOW_BLOCKED", message)
}

fn canonical(path: &Path) -> Result<PathBuf, WorktreeError> {
    let root = crate::workspace::simple_canonicalize(path).map_err(|_| {
        blocked(format!(
            "Workflow directory is missing or inaccessible: {}",
            path.display()
        ))
    })?;
    if !root.is_dir() {
        return Err(blocked("Workflow workspace must be a directory"));
    }
    Ok(root)
}

async fn identity(git: &GitRunner, path: &Path) -> Result<(PathBuf, PathBuf), WorktreeError> {
    let top = git.run(path, &["rev-parse", "--show-toplevel"]).await?;
    let common = git.run(path, &["rev-parse", "--git-common-dir"]).await?;
    Ok((
        canonical(Path::new(top.trim()))?,
        canonical(&path.join(common.trim()))?,
    ))
}

async fn roots(git: &GitRunner, path: &Path) -> Result<Vec<PathBuf>, WorktreeError> {
    let listed = git
        .run(path, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    Ok(listed
        .split('\0')
        .filter_map(|field| field.strip_prefix("worktree "))
        .map(|path| canonical(Path::new(path)).unwrap_or_else(|_| PathBuf::from(path)))
        .collect())
}

/// Explicit selection wins. Automatic selection only recognizes an execution
/// directory declaration on its own line. Merely referencing another checkout
/// (including a read-only comparison) must never redirect writes there.
pub async fn resolve(
    git: &GitRunner,
    primary: &Path,
    requested: Option<&str>,
    request: &str,
    isolated: bool,
) -> Result<PathBuf, WorktreeError> {
    let primary = canonical(primary)?;
    let declaration = regex::Regex::new(r"(?mi)^\s*(?:W|workspace|worktree|工作目录|工作区|执行目录|目标目录)\s*[:=：]\s*([^\r\n]+)\s*$").expect("static declaration pattern");
    let mut declarations: Vec<_> = declaration
        .captures_iter(request)
        .map(|capture| {
            capture[1]
                .trim()
                .trim_matches(['`', '\"', '\''])
                .to_string()
        })
        .collect();
    declarations.sort();
    declarations.dedup();
    let selected = match requested {
        Some(path) => path,
        None => match declarations.as_slice() {
            [] => return Ok(primary),
            [path] => path,
            _ => return Err(blocked("Multiple workspace declarations found. Select the intended workspace explicitly before starting collaboration.")),
        },
    };
    if !Path::new(selected).is_absolute() {
        return Err(blocked("Use an absolute workflow worktree path"));
    }
    let selected = canonical(Path::new(selected))?;
    if selected == primary {
        return Ok(primary);
    }
    if isolated {
        return Err(blocked("An isolated session cannot switch to another worktree. Start the workflow in a session bound to the intended project."));
    }
    let (primary_top, primary_common) = identity(git, &primary).await?;
    let (selected_top, selected_common) = identity(git, &selected).await?;
    if primary_common != selected_common
        || !roots(git, &primary).await?.contains(&selected_top)
        || primary.strip_prefix(primary_top).ok() != selected.strip_prefix(selected_top).ok()
    {
        return Err(blocked(format!("{} is not a registered worktree of this project at the same project-relative directory", selected.display())));
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::test_support::{git_cmd, init_repo};

    #[tokio::test]
    async fn binds_only_registered_siblings_and_rejects_missing_or_unrelated_roots() {
        let temp = tempfile::tempdir().unwrap();
        let main = init_repo(&temp.path().join("main"));
        let sibling = temp.path().join("target");
        git_cmd(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "target",
                sibling.to_str().unwrap(),
            ],
        );
        let sibling = canonical(&sibling).unwrap();
        let git = GitRunner::default();
        let request = format!("Implement this task.\nW={}", sibling.display());
        assert_eq!(
            resolve(&git, &main, None, &request, false).await.unwrap(),
            sibling
        );
        assert_eq!(
            resolve(&git, &main, Some(sibling.to_str().unwrap()), "", false)
                .await
                .unwrap(),
            sibling
        );
        assert!(
            resolve(&git, &main, Some(sibling.to_str().unwrap()), "", true)
                .await
                .is_err()
        );
        let other = init_repo(&temp.path().join("other"));
        assert!(
            resolve(&git, &main, Some(other.to_str().unwrap()), "", false)
                .await
                .is_err()
        );
        assert!(resolve(&git, &main, Some("relative"), "", false)
            .await
            .is_err());
        git_cmd(&main, &["worktree", "remove", sibling.to_str().unwrap()]);
        assert!(
            resolve(&git, &main, Some(sibling.to_str().unwrap()), "", false)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_ambiguous_references_and_preserves_project_subdirectory() {
        let temp = tempfile::tempdir().unwrap();
        let main = init_repo(&temp.path().join("main"));
        std::fs::create_dir(main.join("src")).unwrap();
        std::fs::write(main.join("src/keep"), "same").unwrap();
        git_cmd(&main, &["add", "src/keep"]);
        git_cmd(&main, &["commit", "-qm", "subdir"]);
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        for (name, root) in [("a", &a), ("b", &b)] {
            git_cmd(
                &main,
                &["worktree", "add", "-q", "-b", name, root.to_str().unwrap()],
            );
        }
        let a = canonical(&a).unwrap();
        let b = canonical(&b).unwrap();
        let git = GitRunner::default();
        assert!(resolve(
            &git,
            &main,
            None,
            &format!("W={}\nworkspace={}", a.display(), b.display()),
            false
        )
        .await
        .is_err());
        for request in [
            format!("{}-different", a.display()),
            format!(
                "Change the current project; only read {} for reference. Do not edit it.",
                a.display()
            ),
            format!("Compare /backup{}", a.display()),
        ] {
            assert_eq!(
                resolve(&git, &main, None, &request, false).await.unwrap(),
                canonical(&main).unwrap()
            );
        }
        assert!(resolve(&git, &main, None, "W=/missing/worktree", false)
            .await
            .is_err());
        assert_eq!(
            resolve(
                &git,
                &main.join("src"),
                Some(a.join("src").to_str().unwrap()),
                "",
                false
            )
            .await
            .unwrap(),
            a.join("src")
        );
        assert!(resolve(
            &git,
            &main.join("src"),
            Some(a.to_str().unwrap()),
            "",
            false
        )
        .await
        .is_err());
        #[cfg(unix)]
        {
            let link = temp.path().join("escape");
            std::os::unix::fs::symlink(temp.path(), &link).unwrap();
            assert!(
                resolve(&git, &main, Some(link.to_str().unwrap()), "", false)
                    .await
                    .is_err()
            );
        }
    }
}
