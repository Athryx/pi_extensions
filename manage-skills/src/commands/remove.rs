use anyhow::{bail, Result};
use colored::Colorize;

use crate::config::Config;
use crate::fs_utils::collapse_tilde;

pub fn run(query: &str, do_sync: bool) -> Result<()> {
    let mut config = Config::load_or_default()?;
    
    match config.remove_skill(query) {
        Some(removed_path) => {
            config.save()?;
            println!(
                "{} Removed skill '{}' ({}) from configuration.",
                "✓".green().bold(),
                query.bold(),
                collapse_tilde(&removed_path).dimmed()
            );

            if do_sync {
                println!();
                crate::commands::sync::run(None, false)?;
            } else {
                println!(
                    "\nRun {} to remove obsolete symlinks from agent directories.",
                    "manage-skills sync".bold()
                );
            }
        }
        None => {
            bail!("Skill '{}' not found in configuration.", query);
        }
    }

    Ok(())
}
