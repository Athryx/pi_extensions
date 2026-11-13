use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::fs_utils::expand_tilde;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub skills: Vec<PathBuf>,
    #[serde(default)]
    pub agents: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, AgentOverrides>,
}

/// Per-agent adjustments merged on top of the global skill list.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentOverrides {
    /// Skill paths for this agent only. These win over `remove` and over a
    /// global skill with the same name.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<PathBuf>,
    /// Names of global skills this agent should not receive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
}

impl AgentOverrides {
    fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty()
    }
}

/// The name a skill is linked under: its directory name.
fn skill_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().to_string())
}

fn named(path: &PathBuf) -> Option<(String, PathBuf)> {
    skill_name(path).map(|name| (name, path.clone()))
}

impl Config {
    /// Returns the standard config directory: `~/.config/manage-skills`
    pub fn config_dir() -> PathBuf {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            PathBuf::from(xdg).join("manage-skills")
        } else if let Some(home) = dirs::home_dir() {
            home.join(".config").join("manage-skills")
        } else {
            PathBuf::from(".config/manage-skills")
        }
    }

    /// Returns the standard config file path: `~/.config/manage-skills/config.toml`
    pub fn config_path() -> PathBuf {
        Self::config_dir().join("config.toml")
    }

    /// Loads the configuration file if it exists, or returns Ok(None) if not found.
    pub fn load() -> Result<Option<Self>> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config file at '{}'", path.display()))?;
        let config: Config = toml::from_str(&content)
            .with_context(|| format!("Failed to parse config file at '{}'", path.display()))?;
        Ok(Some(config))
    }

    /// Loads the configuration or returns a default instance if the file doesn't exist yet.
    pub fn load_or_default() -> Result<Self> {
        Ok(Self::load()?.unwrap_or_default())
    }

    /// Saves the configuration file with clean TOML formatting.
    pub fn save(&self) -> Result<()> {
        let dir = Self::config_dir();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create directory '{}'", dir.display()))?;
        let path = Self::config_path();
        let toml_str = toml::to_string_pretty(self)
            .context("Failed to serialize configuration to TOML")?;
        
        let header = "# manage-skills configuration\n# Auto-generated and maintained by manage-skills CLI\n\n";
        let full_content = format!("{}{}", header, toml_str);
        
        std::fs::write(&path, full_content)
            .with_context(|| format!("Failed to write configuration to '{}'", path.display()))?;
        Ok(())
    }

    /// Detects known coding agent harnesses on the current system.
    pub fn detect_known_agents() -> BTreeMap<String, String> {
        let candidates = [
            ("codex", "~/.codex/skills"),
            ("antigravity", "~/.gemini/config/skills"),
            ("pi", "~/.pi/agent/skills"),
            ("opencode", "~/.config/opencode/skills"),
            ("claude", "~/.claude/skills"),
        ];

        let mut detected = BTreeMap::new();
        for (name, path_str) in candidates {
            let expanded = expand_tilde(Path::new(path_str));
            // Check if either the skills dir exists or the parent harness dir exists
            let parent_exists = expanded.parent().map(|p| p.exists()).unwrap_or(false);
            if expanded.exists() || parent_exists {
                detected.insert(name.to_string(), path_str.to_string());
            }
        }
        detected
    }

    /// Resolves the absolute path for an agent harness.
    pub fn resolve_agent_dir(&self, agent_name: &str) -> Option<PathBuf> {
        self.agents.get(agent_name).map(|p| expand_tilde(Path::new(p)))
    }

    /// Returns an error unless `agent` is configured.
    pub fn ensure_agent(&self, agent: &str) -> Result<()> {
        if self.agents.contains_key(agent) {
            return Ok(());
        }
        anyhow::bail!(
            "Agent '{}' not found in configuration. Available agents: {}",
            agent,
            self.agents.keys().cloned().collect::<Vec<_>>().join(", ")
        )
    }

    /// The skills an agent should receive, as name -> source path: the global
    /// list, minus the agent's removes, plus the agent's adds.
    pub fn effective_skills(&self, agent: &str) -> BTreeMap<String, PathBuf> {
        let overrides = self.overrides.get(agent);
        let removed = overrides.map_or(&[][..], |o| o.remove.as_slice());
        let added = overrides.map_or(&[][..], |o| o.add.as_slice());

        let mut skills: BTreeMap<String, PathBuf> = self
            .skills
            .iter()
            .filter_map(named)
            .filter(|(name, _)| !removed.contains(name))
            .collect();
        skills.extend(added.iter().filter_map(named));
        skills
    }

    /// Makes `path` active for one agent. Returns false if it already was.
    pub fn add_agent_skill(&mut self, agent: &str, path: PathBuf) -> bool {
        let Some(name) = skill_name(&path) else {
            return false;
        };
        if self.effective_skills(agent).get(&name) == Some(&path) {
            return false;
        }

        let in_global = self.skills.contains(&path);
        let overrides = self.overrides.entry(agent.to_string()).or_default();
        overrides.remove.retain(|n| *n != name);
        overrides.add.retain(|p| p.file_name() != path.file_name());
        if !in_global {
            overrides.add.push(path);
            overrides.add.sort();
        }
        self.overrides.retain(|_, o| !o.is_empty());
        true
    }

    /// Stops one agent receiving a skill, matched by name or full path.
    /// Returns the skill's name, or None if it wasn't active for that agent.
    pub fn remove_agent_skill(&mut self, agent: &str, query: &str) -> Option<String> {
        let name = self
            .effective_skills(agent)
            .into_iter()
            .find(|(name, path)| name == query || path == Path::new(query))
            .map(|(name, _)| name)?;

        let in_global = self
            .skills
            .iter()
            .any(|p| skill_name(p).as_deref() == Some(name.as_str()));
        let overrides = self.overrides.entry(agent.to_string()).or_default();
        overrides
            .add
            .retain(|p| skill_name(p).as_deref() != Some(name.as_str()));
        if in_global {
            overrides.remove.push(name.clone());
            overrides.remove.sort();
        }
        self.overrides.retain(|_, o| !o.is_empty());
        Some(name)
    }

    /// Adds a skill path, ensuring no duplicates. Returns true if added, false if already existed.
    pub fn add_skill(&mut self, path: PathBuf) -> bool {
        if !self.skills.contains(&path) {
            self.skills.push(path);
            self.skills.sort();
            true
        } else {
            false
        }
    }

    /// Removes a skill matching either full path or skill directory name.
    /// Returns the removed path if found.
    pub fn remove_skill(&mut self, query: &str) -> Option<PathBuf> {
        let query_path = PathBuf::from(query);
        let index = self.skills.iter().position(|s| {
            if s == &query_path {
                return true;
            }
            if let Some(file_name) = s.file_name() {
                if file_name.to_string_lossy() == query {
                    return true;
                }
            }
            false
        });

        if let Some(idx) = index {
            Some(self.skills.remove(idx))
        } else {
            None
        }
    }
}
