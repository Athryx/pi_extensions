use anyhow::{bail, Result};
use colored::Colorize;

use crate::config::Config;
use crate::fs_utils::collapse_tilde;

pub fn run(query: &str, do_sync: bool, agent: Option<&str>) -> Result<()> {
    let mut config = Config::load_or_default()?;

    if let Some(agent) = agent {
        config.ensure_agent(agent)?;
        let Some(name) = config.remove_agent_skill(agent, query) else {
            bail!("Skill '{}' is not active for agent '{}'.", query, agent);
        };
        config.save()?;
        println!(
            "{} Removed skill '{}' for agent '{}'.",
            "✓".green().bold(),
            name.bold(),
            agent.bold()
        );
    } else {
        let Some(removed_path) = config.remove_skill(query) else {
            bail!("Skill '{}' not found in configuration.", query);
        };
        config.save()?;
        println!(
            "{} Removed skill '{}' ({}) from configuration.",
            "✓".green().bold(),
            query.bold(),
            collapse_tilde(&removed_path).dimmed()
        );
    }

    if do_sync {
        println!();
        crate::commands::sync::run(agent, false)?;
    } else {
        println!(
            "\nRun {} to remove obsolete symlinks from agent directories.",
            "manage-skills sync".bold()
        );
    }

    Ok(())
}
