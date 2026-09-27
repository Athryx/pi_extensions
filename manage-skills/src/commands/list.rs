use anyhow::Result;
use colored::Colorize;
use std::collections::BTreeSet;

use crate::config::Config;
use crate::fs_utils::{collapse_tilde, is_skill_dir, read_symlink};
use crate::state::State;

pub fn run() -> Result<()> {
    let config = Config::load_or_default()?;
    let state = State::load()?;
    let config_path = Config::config_path();

    println!("{}", "==================================================".dimmed());
    println!("{}", "               MANAGE-SKILLS STATUS               ".bold());
    println!("{}", "==================================================".dimmed());
    println!("Config file: {}", collapse_tilde(&config_path).cyan());
    println!("State file:  {}", collapse_tilde(&State::state_path()).cyan());
    println!("Configured skills: {}", config.skills.len().to_string().bold());
    println!("Configured agents: {}", config.agents.len().to_string().bold());

    // 1. System Skills Section
    println!("\n{}", "--- SYSTEM SKILLS (CONFIGURED) ---".bold().underline());
    if config.skills.is_empty() {
        println!("  {}", "No system skills configured yet.".dimmed());
        println!("  Add some with: {} add <PATH> [-r]", "manage-skills".bold());
    } else {
        for path in &config.skills {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
            let exists = path.exists();
            let has_skill_md = is_skill_dir(path);

            let status_tag = if !exists {
                "[MISSING PATH]".red().bold()
            } else if !has_skill_md {
                "[NO SKILL.MD]".yellow().bold()
            } else {
                "[VALID]".green().bold()
            };

            println!(
                "  • {:<20} {:<15} {}",
                name.bold(),
                status_tag,
                collapse_tilde(path).dimmed()
            );
        }
    }

    // 2. Per-Agent Current State Section
    println!("\n{}", "--- PER-AGENT HARNESS STATUS ---".bold().underline());
    if config.agents.is_empty() {
        println!("  {}", "No agents configured.".dimmed());
        println!("  Initialize agents with: {}", "manage-skills init".bold());
    } else {
        for (agent_name, path_str) in &config.agents {
            let agent_dir = config.resolve_agent_dir(agent_name);
            let agent_state = state.agents.get(agent_name);
            let last_sync_str = match agent_state.and_then(|s| s.last_synced) {
                Some(dt) => dt.format("%Y-%m-%d %H:%M:%S UTC").to_string(),
                None => "never".to_string(),
            };

            let dir_exists = agent_dir.as_ref().map(|d| d.exists()).unwrap_or(false);
            let dir_status = if dir_exists {
                "active".green()
            } else {
                "directory missing".yellow()
            };

            println!(
                "\n{} [{}] (path: {}, last synced: {})",
                "Agent:".blue().bold(),
                agent_name.bold(),
                path_str.dimmed(),
                last_sync_str.cyan()
            );
            println!("  Directory: {} ({})", agent_dir.as_ref().map(|d| collapse_tilde(d)).unwrap_or_default(), dir_status);

            if !dir_exists {
                println!("  {}", "Directory does not exist yet. Run 'sync' to create.".dimmed());
                continue;
            }

            let agent_dir_path = agent_dir.unwrap();
            let managed_map = agent_state.map(|s| &s.managed);

            // Read live directory items
            let mut live_items = BTreeSet::new();
            if let Ok(entries) = std::fs::read_dir(&agent_dir_path) {
                for entry in entries.flatten() {
                    if let Ok(name) = entry.file_name().into_string() {
                        live_items.insert(name);
                    }
                }
            }

            // A) Managed skills in config
            println!("  {}:", "Managed Skills".underline());
            if config.skills.is_empty() {
                println!("    {}", "No skills configured in system list.".dimmed());
            } else {
                for source in &config.skills {
                    let skill_name = source
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown");
                    let link_path = agent_dir_path.join(skill_name);

                    if link_path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                        let target = read_symlink(&link_path).unwrap_or(None);
                        match target {
                            Some(target_path) => {
                                let is_correct = target_path == *source
                                    || target_path.canonicalize().ok() == source.canonicalize().ok();
                                if is_correct {
                                    println!(
                                        "    {} {:<18} -> {}",
                                        "✓ [OK]".green().bold(),
                                        skill_name,
                                        collapse_tilde(&target_path).dimmed()
                                    );
                                } else {
                                    println!(
                                        "    {} {:<18} -> {} (expected {})",
                                        "~ [DIVERGED]".yellow().bold(),
                                        skill_name,
                                        collapse_tilde(&target_path),
                                        collapse_tilde(source).dimmed()
                                    );
                                }
                            }
                            None => {
                                println!("    {} {:<18} (broken link)", "✗ [BROKEN]".red().bold(), skill_name);
                            }
                        }
                    } else if link_path.exists() {
                        println!(
                            "    {} {:<18} (exists as regular folder/file, not managed symlink)",
                            "! [CONFLICT]".yellow().bold(),
                            skill_name
                        );
                    } else {
                        println!(
                            "    {} {:<18} (not synced yet)",
                            "• [PENDING]".cyan(),
                            skill_name
                        );
                    }
                }
            }

            // B) Unmanaged items found in the agent folder
            let mut unmanaged = Vec::new();
            for item in &live_items {
                // Check if it's managed by us
                let is_managed = managed_map.map(|m| m.contains_key(item)).unwrap_or(false)
                    || config.skills.iter().any(|s| s.file_name().map(|n| n == item.as_str()).unwrap_or(false));
                
                if !is_managed {
                    let item_path = agent_dir_path.join(item);
                    if let Ok(meta) = item_path.symlink_metadata() {
                        if meta.file_type().is_symlink() {
                            let target = read_symlink(&item_path).unwrap_or(None);
                            let target_desc = target.map(|t| collapse_tilde(&t)).unwrap_or_else(|| "broken".to_string());
                            unmanaged.push((item.clone(), format!("symlink -> {}", target_desc)));
                        } else if meta.is_dir() {
                            unmanaged.push((item.clone(), "directory".to_string()));
                        } else {
                            unmanaged.push((item.clone(), "file".to_string()));
                        }
                    }
                }
            }

            if !unmanaged.is_empty() {
                println!("  {} (will not be modified by sync):", "Unmanaged Harness Items".underline().dimmed());
                for (name, desc) in unmanaged {
                    println!("    • {:<18} ({})", name.dimmed(), desc.dimmed());
                }
            }
        }
    }

    println!("\n{}", "==================================================".dimmed());
    Ok(())
}
