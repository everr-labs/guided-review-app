use crate::events::*;
use crate::section::{CommentDraft, DiffFocus, ReviewSection, SectionMap};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const TAG_SECTION_MAP: &str = "acp-section-map";
const TAG_SECTION: &str = "acp-section";
const TAG_COMMENT_DRAFT: &str = "acp-comment-draft";
const TAG_DIFF_FOCUS: &str = "acp-diff-focus";

#[derive(Debug, Deserialize)]
struct SectionMapWire {
    #[serde(default)]
    schema_version: Option<u32>,
    sections: Vec<crate::section::SectionMapEntry>,
}

#[derive(Debug, Deserialize)]
struct SectionWire {
    #[serde(default)]
    schema_version: Option<u32>,
    section_id: String,
    title: String,
    intent: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    ranges: Vec<crate::section::LineRange>,
    #[serde(default)]
    concerns: Vec<crate::section::Concern>,
    #[serde(default)]
    uncovered_scenarios: Vec<crate::section::Concern>,
    #[serde(default)]
    test_coverage_notes: String,
    base_ref: String,
    head_ref: String,
    #[serde(default)]
    pause_prompt: String,
}

pub struct FencedBuffers {
    inner: Mutex<HashMap<String, String>>,
}

impl FencedBuffers {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn append(&self, app: &AppHandle, session_id: &str, chunk: &str) {
        let mut guard = self.inner.lock().expect("poisoned");
        let buf = guard.entry(session_id.to_string()).or_default();
        buf.push_str(chunk);
        let extracted = extract_fenced_blocks(buf);
        if extracted.is_empty() {
            return;
        }
        let consumed_to = extracted.last().map(|(_, _, end)| *end).unwrap_or(0);
        let remaining = buf[consumed_to..].to_string();
        *buf = remaining;
        drop(guard);

        for (tag, body, _) in extracted {
            handle_block(app, session_id, &tag, &body);
        }
    }

}

fn parse_lenient<T: DeserializeOwned>(body: &str) -> Result<T, String> {
    match serde_json::from_str::<T>(body) {
        Ok(v) => Ok(v),
        Err(strict) => match json5::from_str::<T>(body) {
            Ok(v) => Ok(v),
            Err(lax) => Err(format!("strict: {strict}; lenient: {lax}")),
        },
    }
}

fn snippet(body: &str) -> String {
    let mut s = body.replace('\n', "⏎");
    if s.len() > 240 {
        s.truncate(240);
        s.push('…');
    }
    s
}

fn validate_diff_focus(focus: &DiffFocus) -> Result<(), String> {
    if focus.file_path.trim().is_empty() {
        return Err("file_path is required".to_string());
    }
    if focus.start_line == 0 || focus.end_line == 0 {
        return Err("start_line and end_line must be positive".to_string());
    }
    Ok(())
}

fn handle_block(app: &AppHandle, session_id: &str, tag: &str, body: &str) {
    match tag {
        TAG_SECTION_MAP => match parse_lenient::<SectionMapWire>(body) {
            Ok(wire) => {
                let map = SectionMap {
                    schema_version: wire.schema_version.unwrap_or(1),
                    sections: wire.sections,
                };
                tracing::info!(session_id, sections = map.sections.len(), "section_map parsed");
                let _ = app.emit(
                    EV_SECTION_MAP,
                    SectionMapEvent {
                        session_id: session_id.to_string(),
                        map,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse section_map");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("section map JSON invalid: {e}"),
                    },
                );
            }
        },
        TAG_SECTION => match parse_lenient::<SectionWire>(body) {
            Ok(wire) => {
                let section = ReviewSection {
                    schema_version: wire.schema_version.unwrap_or(1),
                    section_id: wire.section_id,
                    title: wire.title,
                    intent: wire.intent,
                    files: wire.files,
                    ranges: wire.ranges,
                    concerns: wire.concerns,
                    uncovered_scenarios: wire.uncovered_scenarios,
                    test_coverage_notes: wire.test_coverage_notes,
                    base_ref: wire.base_ref,
                    head_ref: wire.head_ref,
                    pause_prompt: wire.pause_prompt,
                };
                tracing::info!(
                    session_id,
                    section_id = %section.section_id,
                    files = section.files.len(),
                    concerns = section.concerns.len(),
                    "section parsed",
                );
                let _ = app.emit(
                    EV_SECTION,
                    SectionEvent {
                        session_id: session_id.to_string(),
                        section,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse section");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("section JSON invalid: {e}"),
                    },
                );
            }
        },
        TAG_COMMENT_DRAFT => match parse_lenient::<CommentDraft>(body) {
            Ok(draft) => {
                tracing::info!(session_id, kind = ?draft.kind, "comment draft parsed");
                let draft_id = format!("draft-{}", uuid::Uuid::new_v4());
                let _ = app.emit(
                    EV_COMMENT_DRAFT,
                    CommentDraftEvent {
                        session_id: session_id.to_string(),
                        draft_id,
                        draft,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse comment draft");
            }
        },
        TAG_DIFF_FOCUS => match parse_lenient::<DiffFocus>(body).and_then(|focus| {
            validate_diff_focus(&focus)?;
            Ok(focus)
        }) {
            Ok(focus) => {
                tracing::info!(
                    session_id,
                    file_path = %focus.file_path,
                    start_line = focus.start_line,
                    end_line = focus.end_line,
                    "diff focus parsed",
                );
                let _ = app.emit(
                    EV_DIFF_FOCUS,
                    DiffFocusEvent {
                        session_id: session_id.to_string(),
                        focus,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse diff focus");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("diff focus JSON invalid: {e}"),
                    },
                );
            }
        },
        _ => {}
    }
}

fn extract_fenced_blocks(buf: &str) -> Vec<(String, String, usize)> {
    let mut out = Vec::new();
    let mut search = 0usize;
    while let Some(rel) = buf[search..].find("```") {
        let open_start = search + rel;
        let after_open = open_start + 3;
        let line_end = match buf[after_open..].find('\n') {
            Some(i) => after_open + i,
            None => break,
        };
        let tag_line = buf[after_open..line_end].trim();
        if tag_line != TAG_SECTION_MAP
            && tag_line != TAG_SECTION
            && tag_line != TAG_COMMENT_DRAFT
            && tag_line != TAG_DIFF_FOCUS
        {
            search = after_open;
            continue;
        }
        let body_start = line_end + 1;
        let close_rel = match buf[body_start..].find("\n```") {
            Some(i) => i,
            None => break,
        };
        let body = buf[body_start..body_start + close_rel].to_string();
        let close_end = body_start + close_rel + 4;
        let trimmed_close_end = match buf[close_end..].find('\n') {
            Some(i) => close_end + i + 1,
            None => close_end,
        };
        out.push((tag_line.to_string(), body, trimmed_close_end));
        search = trimmed_close_end;
    }
    out
}
