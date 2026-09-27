use anyhow::{bail, Context, Result};
use colored::Colorize;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::config::Config;
use crate::fs_utils::{collapse_tilde, create_or_replace_symlink, read_symlink};
use crate::state::State;

pub fn run(filter_agent: Option<&str>, dry_run: bool) -> Result<()> {
    let config = Config::load()?.unwrap_or_default();
    if config.agents.is_empty() {
        println!(
            "{} No agent harnesses configured. Run {} to initialize or {} to add one.",
            "!".yellow().bold(),
            "manage-skills init".bold(),
            "manage-skills agent add <NAME> <PATH>".bold()
        );
        return Ok(());
    }

    let mut state = State::load()?;

    if dry_run {
        println!("{}", "[DRY RUN] No filesystem changes will be made.".yellow().bold());
    }

    let target_agents: Vec<(&String, &String)> = if let Some(agent_name) = filter_agent {
        if let Some(path) = config.agents.get(agent_name) {
            vec![(
                config.agents.get_key_value(agent_name).unwrap().0,
                path,
            )]
        } else {
            bail!(
                "Agent '{}' not found in configuration. Available agents: {}",
                agent_name,
                config.agents.keys().cloned().collect::<Vec<_>>().join(", ")
            );
        }
    } else {
        config.agents.iter().collect()
    };

    // Prepare desired skills map: skill_name -> source_path
    let mut desired_skills: BTreeMap<String, PathBuf> = BTreeMap::new();
    for source in &config.skills {
        if !source.exists() {
            println!(
                "{} Warning: Configured skill path does not exist: {}",
                "!".yellow().bold(),
                source.display()
            );
            continue;
        }
        let skill_name = match source.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                println!(
                    "{} Warning: Invalid skill path (no directory name): {}",
                    "!".yellow().bold(),
                    source.display()
                );
                continue;
            }
        };
        desired_skills.insert(skill_name, source.clone());
    }

    let mut total_linked = 0;
    let mut total_updated = 0;
    let mut total_pruned = 0;
    let mut total_unchanged = 0;
    let mut total_skipped = 0;

    for (agent_name, agent_path_str) in target_agents {
        println!(
            "\n{} Syncing agent {} ({})",
            "==>".blue().bold(),
            agent_name.bold(),
            agent_path_str.dimmed()
        );

        let agent_dir = match config.resolve_agent_dir(agent_name) {
            Some(d) => d,
            None => {
                println!("  {} Could not resolve agent directory path.", "!".red());
                continue;
            }
        };

        if !dry_run && !agent_dir.exists() {
            std::fs::create_dir_all(&agent_dir).with_context(|| {
                format!("Failed to create agent directory '{}'", agent_dir.display())
            })?;
        }

        let prev_managed = state
            .get_agent_managed(agent_name)
            .cloned()
            .unwrap_or_default();

        let mut current_managed: BTreeMap<String, PathBuf> = BTreeMap::new();

        // Phase 1: Pruning stale managed skills
        for (prev_name, prev_source) in &prev_managed {
            if !desired_skills.contains_key(prev_name) {
                let link_path = agent_dir.join(prev_name);
                match link_path.symlink_metadata() {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        let actual_target = read_symlink(&link_path)?.unwrap_or_default();
                        let matches_target = actual_target == *prev_source
                            || actual_target.canonicalize().ok() == prev_source.canonicalize().ok();

                        if matches_target {
                            if !dry_run {
                                std::fs::remove_file(&link_path).with_context(|| {
                                    format!("Failed to remove stale symlink '{}'", link_path.display())
                                })?;
                            }
                            println!("  {} Removed stale link: {}", "-".red().bold(), prev_name);
                            total_pruned += 1;
                        } else {
                            println!(
                                "  {} Preserved '{}': symlink target diverged (points to '{}', expected '{}').",
                                "!".yellow().bold(),
                                prev_name,
                                collapse_tilde(&actual_target),
                                collapse_tilde(prev_source)
                            );
                            total_skipped += 1;
                        }
                    }
                    Ok(_) => {
                        println!(
                            "  {} Preserved '{}': target is a regular file/directory, not a managed symlink.",
                            "!".yellow().bold(),
                            prev_name
                        );
                        total_skipped += 1;
                    }
                    Err(_) => {
                        // Already gone on disk, cleanly drop from state
                    }
                }
            }
        }

        // Phase 2: Linking desired skills
        for (skill_name, source_path) in &desired_skills {
            let link_path = agent_dir.join(skill_name);
            let exists_symlink = link_path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
            let exists_regular = link_path.exists();

            if exists_symlink {
                let actual_target = read_symlink(&link_path)?.unwrap_or_default();
                let matches_source = actual_target == *source_path
                    || actual_target.canonicalize().ok() == source_path.canonicalize().ok();

                if matches_source {
                    println!("  {} Up to date: {}", "=".dimmed(), skill_name);
                    current_managed.insert(skill_name.clone(), source_path.clone());
                    total_unchanged += 1;
                } else if prev_managed.contains_key(skill_name) {
                    if !dry_run {
                        create_or_replace_symlink(source_path, &link_path)?;
                    }
                    println!(
                        "  {} Updated link: {} -> {}",
                        "~".cyan().bold(),
                        skill_name.bold(),
                        collapse_tilde(source_path).dimmed()
                    );
                    current_managed.insert(skill_name.clone(), source_path.clone());
                    total_updated += 1;
                } else {
                    println!(
                        "  {} Preserved unmanaged symlink: '{}' -> '{}'. Skipping.",
                        "!".yellow().bold(),
                        skill_name,
                        collapse_tilde(&actual_target)
                    );
                    total_skipped += 1;
                }
            } else if exists_regular {
                println!(
                    "  {} Target '{}' is an unmanaged directory or file. Skipping to avoid data loss.",
                    "!".yellow().bold(),
                    skill_name
                );
                total_skipped += 1;
            } else {
                // Link path does not exist
                if !dry_run {
                    create_or_replace_symlink(source_path, &link_path)?;
                }
                println!(
                    "  {} Created link: {} -> {}",
                    "+".green().bold(),
                    skill_name.bold(),
                    collapse_tilde(source_path).dimmed()
                );
                current_managed.insert(skill_name.clone(), source_path.clone());
                total_linked += 1;
            }
        }

        if !dry_run {
            state.record_agent_sync(agent_name, current_managed);
        }
    }

    if !dry_run {
        state.save()?;
    }

    println!(
        "\n{} Sync summary: {} created, {} updated, {} pruned, {} unchanged, {} skipped.",
        "✓".green().bold(),
        total_linked.to_string().green(),
        total_updated.to_string().cyan(),
        total_pruned.to_string().red(),
        total_unchanged.to_string().dimmed(),
        total_skipped.to_string().yellow()
    );

    Ok(())
}
