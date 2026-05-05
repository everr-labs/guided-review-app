use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

impl AgentKind {
    pub fn label(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }

    pub fn launch_command(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "npx -y @zed-industries/claude-code-acp",
            AgentKind::Codex => "npx -y @zed-industries/codex-acp",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub kind: AgentKind,
    pub label: &'static str,
    pub launch_command: &'static str,
}

pub fn list_agents() -> Vec<AgentInfo> {
    [AgentKind::ClaudeCode, AgentKind::Codex]
        .into_iter()
        .map(|kind| AgentInfo {
            kind,
            label: kind.label(),
            launch_command: kind.launch_command(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_agents_excludes_fake_agent() {
        let agents = list_agents();
        let kinds: Vec<AgentKind> = agents.into_iter().map(|agent| agent.kind).collect();

        assert_eq!(kinds, vec![AgentKind::ClaudeCode, AgentKind::Codex]);
    }
}
