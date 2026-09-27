use anyhow::Result;
use clap::{Parser, Subcommand};
use manage_skills::commands;

#[derive(Parser, Debug)]
#[command(
    name = "manage-skills",
    version,
    about = "Manage and synchronize AI coding agent skills across harnesses (Codex, Antigravity, Pi, OpenCode, etc.)",
    long_about = "A CLI tool to centralize and sync AI coding agent skills across harnesses via symlinks, maintaining config in ~/.config/manage-skills/config.toml and tracking managed state."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Initialize ~/.config/manage-skills/config.toml with auto-detected agents
    Init {
        /// Force re-initialization even if config already exists
        #[arg(short, long)]
        force: bool,
    },

    /// Add a skill path or search recursively for skills
    Add {
        /// Path to a skill directory or parent directory
        path: String,

        /// Recursively search subdirectories for folders containing SKILL.md
        #[arg(short, long)]
        recursive: bool,

        /// Immediately sync skills after adding
        #[arg(short, long)]
        sync: bool,
    },

    /// Synchronize skills to agent harness directories
    Sync {
        /// Sync only to a specific agent harness
        #[arg(short, long)]
        agent: Option<String>,

        /// Perform a dry run without modifying the filesystem
        #[arg(short, long)]
        dry_run: bool,
    },

    /// List configured settings, system skills, and live per-agent status
    List,

    /// Remove a skill from configuration
    #[command(alias = "rm")]
    Remove {
        /// Skill name or directory path to remove
        query: String,

        /// Immediately sync and remove symlinks after removing from config
        #[arg(short, long)]
        sync: bool,
    },

    /// Manage configured agent harnesses
    Agent {
        #[command(subcommand)]
        command: AgentCommands,
    },
}

#[derive(Subcommand, Debug)]
enum AgentCommands {
    /// Register a new agent harness
    Add {
        /// Name of the agent (e.g., codex, pi, antigravity, opencode, custom)
        name: String,
        /// Path to the agent's skills directory (e.g., ~/.codex/skills)
        path: String,
    },

    /// Unregister an agent harness
    #[command(alias = "rm")]
    Remove {
        /// Name of the agent to remove
        name: String,
    },

    /// List all configured agent harnesses
    List,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { force } => commands::init::run(force),
        Commands::Add {
            path,
            recursive,
            sync,
        } => commands::add::run(&path, recursive, sync),
        Commands::Sync { agent, dry_run } => commands::sync::run(agent.as_deref(), dry_run),
        Commands::List => commands::list::run(),
        Commands::Remove { query, sync } => commands::remove::run(&query, sync),
        Commands::Agent { command } => match command {
            AgentCommands::Add { name, path } => commands::agent::add(&name, &path),
            AgentCommands::Remove { name } => commands::agent::remove(&name),
            AgentCommands::List => commands::agent::list(),
        },
    }
}
