use anyhow::{bail, Context, Result};
use colored::Colorize;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::fs_utils::{collapse_tilde, expand_tilde, find_skills_recursive, is_skill_dir};

pub fn run(path_str: &str, recursive: bool, do_sync: bool) -> Result<()> {
    let mut config = Config::load_or_default()?;
    let input_path = expand_tilde(Path::new(path_str));

    if !input_path.exists() {
        bail!("Path '{}' does not exist.", path_str);
    }

    let mut added_skills: Vec<PathBuf> = Vec::new();
    let mut already_existing: Vec<PathBuf> = Vec::new();

    if recursive {
        println!(
            "Searching recursively for skills containing {} in '{}'...",
            "SKILL.md".bold(),
            collapse_tilde(&input_path).cyan()
        );
        let found = find_skills_recursive(&input_path);
        if found.is_empty() {
            println!(
                "{} No directories containing {} found under '{}'.",
                "!".yellow().bold(),
                "SKILL.md".bold(),
                path_str
            );
            return Ok(());
        }

        for skill_path in found {
            if config.add_skill(skill_path.clone()) {
                added_skills.push(skill_path);
            } else {
                already_existing.push(skill_path);
            }
        }
    } else {
        if !input_path.is_dir() {
            bail!("Path '{}' is not a directory.", path_str);
        }

        if !is_skill_dir(&input_path) {
            println!(
                "{} Note: No {} found in '{}'. Adding anyway.",
                "i".cyan().bold(),
                "SKILL.md".bold(),
                path_str
            );
        }

        let canonical = input_path
            .canonicalize()
            .with_context(|| format!("Failed to canonicalize path '{}'", input_path.display()))?;

        if config.add_skill(canonical.clone()) {
            added_skills.push(canonical);
        } else {
            already_existing.push(canonical);
        }
    }

    if !added_skills.is_empty() {
        config.save()?;
        println!("\n{} Added {} skill(s) to config:", "✓".green().bold(), added_skills.len());
        for p in &added_skills {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
            println!("  • {:<20} ({})", name.bold(), collapse_tilde(p).dimmed());
        }
    }

    if !already_existing.is_empty() {
        println!(
            "\n{} {} skill(s) already in config:",
            "•".dimmed(),
            already_existing.len()
        );
        for p in &already_existing {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
            println!("  - {:<20} ({})", name, collapse_tilde(p).dimmed());
        }
    }

    if do_sync {
        println!();
        crate::commands::sync::run(None, false)?;
    } else if !added_skills.is_empty() {
        println!("\nRun {} to synchronize skills across your agents.", "manage-skills sync".bold());
    }

    Ok(())
}
