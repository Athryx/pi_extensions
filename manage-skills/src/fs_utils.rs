use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Expands leading `~` or `$HOME` in paths to the user's home directory.
pub fn expand_tilde(path: &Path) -> PathBuf {
    let path_str = path.to_string_lossy();
    if path_str == "~" || path_str.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            if path_str == "~" {
                return home;
            }
            return home.join(path_str.trim_start_matches("~/"));
        }
    } else if path_str.starts_with("$HOME/") || path_str == "$HOME" {
        if let Ok(home) = std::env::var("HOME") {
            if path_str == "$HOME" {
                return PathBuf::from(home);
            }
            return PathBuf::from(home).join(path_str.trim_start_matches("$HOME/"));
        }
    }
    path.to_path_buf()
}

/// Collapses the home directory in an absolute path to `~/...` for compact display.
pub fn collapse_tilde(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rel) = path.strip_prefix(&home) {
            return format!("~/{}", rel.display());
        }
    }
    path.display().to_string()
}

/// Checks if a directory contains a SKILL.md file (case-insensitive).
pub fn is_skill_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.eq_ignore_ascii_case("skill.md") {
                return true;
            }
        }
    }
    false
}

/// Recursively traverses a directory looking for skills (directories containing SKILL.md).
/// Skips hidden directories (starting with `.`), `target`, and `node_modules`.
/// When a skill directory is found, it does not recurse deeper into that skill.
pub fn find_skills_recursive(root: &Path) -> Vec<PathBuf> {
    let mut skills = Vec::new();
    let mut it = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let file_name = e.file_name().to_string_lossy();
            if e.depth() > 0 && file_name.starts_with('.') {
                return false;
            }
            if file_name == "node_modules" || file_name == "target" {
                return false;
            }
            true
        });

    while let Some(Ok(entry)) = it.next() {
        let path = entry.path();
        if entry.file_type().is_dir() && is_skill_dir(path) {
            if let Ok(canonical) = path.canonicalize() {
                skills.push(canonical);
            } else {
                skills.push(path.to_path_buf());
            }
            it.skip_current_dir();
        }
    }

    skills.sort();
    skills.dedup();
    skills
}

/// Returns the target of a symlink if `path` is a symlink, otherwise None.
pub fn read_symlink(path: &Path) -> Result<Option<PathBuf>> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = std::fs::read_link(path)
                .with_context(|| format!("Failed to read symlink: {}", path.display()))?;
            Ok(Some(target))
        }
        _ => Ok(None),
    }
}

/// Creates or safely replaces a symlink.
/// Errors if a non-symlink file or directory already exists at `link_path`.
pub fn create_or_replace_symlink(source: &Path, link_path: &Path) -> Result<()> {
    if let Ok(meta) = link_path.symlink_metadata() {
        if meta.file_type().is_symlink() {
            std::fs::remove_file(link_path)
                .with_context(|| format!("Failed to remove existing symlink: {}", link_path.display()))?;
        } else {
            anyhow::bail!(
                "Cannot create symlink at '{}': a regular file or directory already exists.",
                link_path.display()
            );
        }
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(source, link_path)
        .with_context(|| format!("Failed to symlink '{}' -> '{}'", link_path.display(), source.display()))?;

    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(source, link_path)
        .with_context(|| format!("Failed to symlink '{}' -> '{}'", link_path.display(), source.display()))?;

    Ok(())
}
