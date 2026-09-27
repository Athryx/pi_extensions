use manage_skills::config::Config;
use manage_skills::fs_utils::{
    create_or_replace_symlink, expand_tilde, find_skills_recursive, is_skill_dir, read_symlink,
};
use manage_skills::state::State;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

#[test]
fn test_expand_tilde() {
    let home = dirs::home_dir().expect("Home dir must exist");
    assert_eq!(expand_tilde(Path::new("~")), home);
    assert_eq!(expand_tilde(Path::new("~/test/path")), home.join("test/path"));
    assert_eq!(
        expand_tilde(Path::new("/var/log")),
        PathBuf::from("/var/log")
    );
}

#[test]
fn test_config_add_and_remove() {
    let mut config = Config::default();
    let p1 = PathBuf::from("/home/user/skills/python-style");
    let p2 = PathBuf::from("/home/user/skills/skill-issue");

    assert!(config.add_skill(p1.clone()));
    assert!(!config.add_skill(p1.clone())); // duplicate rejected
    assert!(config.add_skill(p2.clone()));
    assert_eq!(config.skills.len(), 2);

    // Remove by name
    let removed = config.remove_skill("python-style");
    assert_eq!(removed, Some(p1));
    assert_eq!(config.skills.len(), 1);

    // Remove by exact path
    let removed_again = config.remove_skill("/home/user/skills/skill-issue");
    assert_eq!(removed_again, Some(p2));
    assert_eq!(config.skills.len(), 0);
}

#[test]
fn test_find_skills_recursive() {
    let temp = tempdir().expect("Failed to create tempdir");
    let root = temp.path();

    let skill_a = root.join("category").join("skill_a");
    let skill_b = root.join("skill_b");
    let not_a_skill = root.join("docs");
    let hidden_skill = root.join(".hidden").join("skill_c");
    let node_modules_skill = root.join("node_modules").join("skill_d");

    fs::create_dir_all(&skill_a).unwrap();
    fs::write(skill_a.join("SKILL.md"), "# Skill A").unwrap();

    fs::create_dir_all(&skill_b).unwrap();
    fs::write(skill_b.join("skill.md"), "# Skill B").unwrap();

    fs::create_dir_all(&not_a_skill).unwrap();
    fs::write(not_a_skill.join("README.md"), "# Not a skill").unwrap();

    fs::create_dir_all(&hidden_skill).unwrap();
    fs::write(hidden_skill.join("SKILL.md"), "# Hidden Skill").unwrap();

    fs::create_dir_all(&node_modules_skill).unwrap();
    fs::write(node_modules_skill.join("SKILL.md"), "# Node Skill").unwrap();

    assert!(is_skill_dir(&skill_a));
    assert!(is_skill_dir(&skill_b));
    assert!(!is_skill_dir(&not_a_skill));

    let found = find_skills_recursive(root);
    let found_names: Vec<String> = found
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();

    assert!(found_names.contains(&"skill_a".to_string()));
    assert!(found_names.contains(&"skill_b".to_string()));
    assert!(!found_names.contains(&"skill_c".to_string()));
    assert!(!found_names.contains(&"skill_d".to_string()));
    assert_eq!(found.len(), 2);
}

#[test]
fn test_symlink_creation_and_safe_prune_logic() {
    let temp = tempdir().expect("Failed to create tempdir");
    let root = temp.path();

    // 1. Create system skills
    let system_skills = root.join("system_skills");
    let skill_1 = system_skills.join("skill_1");
    let skill_2 = system_skills.join("skill_2");
    fs::create_dir_all(&skill_1).unwrap();
    fs::write(skill_1.join("SKILL.md"), "Skill 1").unwrap();
    fs::create_dir_all(&skill_2).unwrap();
    fs::write(skill_2.join("SKILL.md"), "Skill 2").unwrap();

    // 2. Create agent directory with unmanaged hand-crafted items
    let agent_dir = root.join("agent_skills");
    fs::create_dir_all(&agent_dir).unwrap();

    // An unmanaged real directory
    let unmanaged_dir = agent_dir.join("grilling");
    fs::create_dir_all(&unmanaged_dir).unwrap();
    fs::write(unmanaged_dir.join("recipe.txt"), "Steak").unwrap();

    // An unmanaged symlink pointing to an external tool
    let unmanaged_target = root.join("external_tool");
    fs::create_dir_all(&unmanaged_target).unwrap();
    let unmanaged_link = agent_dir.join("cuttle-cli");
    create_or_replace_symlink(&unmanaged_target, &unmanaged_link).unwrap();

    // 3. Simulate initial sync:
    // Skill 1 and Skill 2 should be linked
    let link_1 = agent_dir.join("skill_1");
    let link_2 = agent_dir.join("skill_2");
    create_or_replace_symlink(&skill_1, &link_1).unwrap();
    create_or_replace_symlink(&skill_2, &link_2).unwrap();

    assert_eq!(read_symlink(&link_1).unwrap().unwrap(), skill_1);
    assert_eq!(read_symlink(&link_2).unwrap().unwrap(), skill_2);

    // Track in state
    let mut state = State::default();
    let mut managed = BTreeMap::new();
    managed.insert("skill_1".to_string(), skill_1.clone());
    managed.insert("skill_2".to_string(), skill_2.clone());
    state.record_agent_sync("test_agent", managed);

    // 4. Simulate a sync where skill_1 was removed from config (only skill_2 desired)
    let desired = vec![("skill_2".to_string(), skill_2.clone())]
        .into_iter()
        .collect::<BTreeMap<_, _>>();

    let prev_managed = state.get_agent_managed("test_agent").unwrap().clone();

    // Prune phase
    for (prev_name, prev_source) in &prev_managed {
        if !desired.contains_key(prev_name) {
            let lp = agent_dir.join(prev_name);
            if let Ok(meta) = lp.symlink_metadata() {
                if meta.file_type().is_symlink() {
                    let actual_target = read_symlink(&lp).unwrap().unwrap();
                    if actual_target == *prev_source {
                        fs::remove_file(&lp).unwrap();
                    }
                }
            }
        }
    }

    // 5. Verify results
    // skill_1 is gone!
    assert!(!link_1.exists());
    assert!(link_1.symlink_metadata().is_err());

    // skill_2 is still there
    assert!(link_2.exists());
    assert_eq!(read_symlink(&link_2).unwrap().unwrap(), skill_2);

    // Unmanaged directory is untouched
    assert!(unmanaged_dir.exists());
    assert!(unmanaged_dir.join("recipe.txt").exists());

    // Unmanaged symlink is untouched
    assert!(unmanaged_link.exists());
    assert_eq!(
        read_symlink(&unmanaged_link).unwrap().unwrap(),
        unmanaged_target
    );
}
