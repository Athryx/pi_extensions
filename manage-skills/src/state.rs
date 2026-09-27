use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct State {
    #[serde(default)]
    pub agents: BTreeMap<String, AgentState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    pub last_synced: Option<DateTime<Utc>>,
    /// Map of skill_name -> canonical source path on system
    #[serde(default)]
    pub managed: BTreeMap<String, PathBuf>,
}

impl State {
    /// Returns the standard state file path: `~/.config/manage-skills/state.toml`
    pub fn state_path() -> PathBuf {
        Config::config_dir().join("state.toml")
    }

    /// Loads state from `state.toml` or returns empty default state if not found.
    pub fn load() -> Result<Self> {
        let path = Self::state_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read state file at '{}'", path.display()))?;
        let state: State = toml::from_str(&content)
            .with_context(|| format!("Failed to parse state file at '{}'", path.display()))?;
        Ok(state)
    }

    /// Saves state to `state.toml`.
    pub fn save(&self) -> Result<()> {
        let dir = Config::config_dir();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create directory '{}'", dir.display()))?;
        let path = Self::state_path();
        let toml_str = toml::to_string_pretty(self)
            .context("Failed to serialize state to TOML")?;
        
        let header = "# manage-skills state tracking file\n# Automatically updated on 'sync'. Do not edit manually.\n\n";
        let full_content = format!("{}{}", header, toml_str);
        
        std::fs::write(&path, full_content)
            .with_context(|| format!("Failed to write state to '{}'", path.display()))?;
        Ok(())
    }

    /// Gets previously managed skills for a given agent.
    pub fn get_agent_managed(&self, agent_name: &str) -> Option<&BTreeMap<String, PathBuf>> {
        self.agents.get(agent_name).map(|s| &s.managed)
    }

    /// Checks if a skill is recorded as managed by manage-skills for this agent.
    #[allow(dead_code)]
    pub fn is_skill_managed(&self, agent_name: &str, skill_name: &str) -> bool {
        self.agents
            .get(agent_name)
            .map(|a| a.managed.contains_key(skill_name))
            .unwrap_or(false)
    }

    /// Records newly synced managed skills for an agent.
    pub fn record_agent_sync(&mut self, agent_name: &str, managed: BTreeMap<String, PathBuf>) {
        let agent_state = self.agents.entry(agent_name.to_string()).or_default();
        agent_state.last_synced = Some(Utc::now());
        agent_state.managed = managed;
    }
}
