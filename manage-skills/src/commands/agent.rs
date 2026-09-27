use anyhow::{bail, Result};
use colored::Colorize;
use std::path::Path;

use crate::config::Config;
use crate::fs_utils::{collapse_tilde, expand_tilde};

pub fn add(name: &str, path_str: &str) -> Result<()> {
    let mut config = Config::load_or_default()?;
    let expanded = expand_tilde(Path::new(path_str));

    config.agents.insert(name.to_string(), path_str.to_string());
    config.save()?;

    println!(
        "{} Registered agent '{}' -> {}",
        "✓".green().bold(),
        name.bold(),
        collapse_tilde(&expanded).dimmed()
    );
    println!("Run {} to sync skills to this agent.", "manage-skills sync".bold());
    Ok(())
}

pub fn remove(name: &str) -> Result<()> {
    let mut config = Config::load_or_default()?;
    if config.agents.remove(name).is_some() {
        config.save()?;
        println!(
            "{} Removed agent '{}' from configuration.",
            "✓".green().bold(),
            name.bold()
        );
    } else {
        bail!("Agent '{}' not found in configuration.", name);
    }
    Ok(())
}

pub fn list() -> Result<()> {
    let config = Config::load_or_default()?;
    println!("{}", "--- CONFIGURED AGENT HARNESSES ---".bold().underline());
    if config.agents.is_empty() {
        println!("  No agents configured. Run 'manage-skills init' or 'manage-skills agent add <NAME> <PATH>'.");
    } else {
        for (name, path_str) in &config.agents {
            let expanded = expand_tilde(Path::new(path_str));
            let exists_str = if expanded.exists() {
                "active".green()
            } else {
                "missing on disk".yellow()
            };
            println!("  • {:<15} -> {:<35} ({})", name.bold(), path_str.cyan(), exists_str);
        }
    }
    Ok(())
}
