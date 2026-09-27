use anyhow::Result;
use colored::Colorize;

use crate::config::Config;
use crate::fs_utils::collapse_tilde;

pub fn run(force: bool) -> Result<()> {
    let path = Config::config_path();
    if path.exists() && !force {
        println!(
            "{} Configuration already exists at {}",
            "Notice:".yellow().bold(),
            collapse_tilde(&path).cyan()
        );
        println!("Use {} to overwrite.", "--force".bold());
        return Ok(());
    }

    let detected_agents = Config::detect_known_agents();
    let config = Config {
        skills: Vec::new(),
        agents: detected_agents.clone(),
    };

    config.save()?;

    println!(
        "{} Initialized configuration at {}",
        "✓".green().bold(),
        collapse_tilde(&path).cyan()
    );

    if detected_agents.is_empty() {
        println!("No existing agent directories detected. You can add agents using:");
        println!("  manage-skills agent add <NAME> <PATH>");
    } else {
        println!("Detected {} agent harness(es):", detected_agents.len());
        for (name, target) in detected_agents {
            println!("  • {:<12} -> {}", name.bold(), target.dimmed());
        }
    }

    println!("\nNext steps:");
    println!("  1. Add skills:  {} add <PATH> [-r]", "manage-skills".bold());
    println!("  2. Sync skills: {} sync", "manage-skills".bold());

    Ok(())
}
