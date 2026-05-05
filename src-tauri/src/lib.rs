mod acp_client;
mod agent_runner;
mod commands;
mod comments;
mod events;
mod fenced;
mod projects;
mod repo;
mod section;
mod telemetry;

use crate::acp_client::AcpSessions;
use commands::*;
use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    telemetry::init();

    let sessions = AcpSessions::default();

    tauri::Builder::default()
        .manage(sessions.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_agents_cmd,
            agent_skill_cmd,
            start_session_cmd,
            send_message_cmd,
            end_session_cmd,
            get_file_at_ref_cmd,
            get_diff_cmd,
            publish_comment_cmd,
            parse_pr_url_cmd,
            list_recent_projects_cmd,
            inspect_local_repo_origin_cmd,
            record_recent_project_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let sessions = sessions.clone();
                tauri::async_runtime::block_on(async move {
                    sessions.shutdown_all().await;
                });
                telemetry::shutdown();
            }
        });
}
