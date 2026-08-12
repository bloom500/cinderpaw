//! What the model may call, and what happens when it does.
//!
//! The two halves of tool use, kept together because they have to agree: a name
//! declared here must be answerable here, and the failure when they disagree is
//! not an error message but a call that hangs — the model waits for a response
//! that no branch produces.
//!
//! This bridges the tools Rust owns and can run by itself. The agent sidecar has
//! many more, and reaching those needs a round trip that does not exist yet;
//! `FunctionDeclaration` is the common currency, so a second source of them
//! joins here without changing the session.

use super::{FunctionCall, FunctionDeclaration, FunctionResponse};
use crate::tools::{execute, ToolType};

/// Everything the model is told it can do.
pub fn declarations() -> Vec<FunctionDeclaration> {
    ToolType::ALL.iter().map(|t| t.to_gemini_declaration()).collect()
}

/// Run one call and produce the response that must go back.
///
/// Always returns a response, including for a tool that does not exist. The
/// model blocks on the `id` it asked about, so "we do not have that tool" has to
/// travel as an answer — staying silent reads as a tool that never finished, and
/// the conversation stops rather than recovering.
pub async fn answer(call: &FunctionCall) -> FunctionResponse {
    let response = match ToolType::from_name(&call.name) {
        None => serde_json::json!({
            "error": format!("no such tool: {}", call.name),
        }),
        Some(tool) => {
            let result = execute(tool, call.args.clone()).await;
            // A tool that failed is reported as a failure, not as an error on
            // the call: the model can say "that did not work" and carry on, but
            // only if it is told in a field it reads rather than in prose.
            serde_json::json!({ "ok": result.ok, "output": result.output })
        }
    };
    FunctionResponse {
        id: call.id.clone(),
        name: call.name.clone(),
        response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_declared_and_none_is_declared_twice() {
        let decls = declarations();
        assert_eq!(decls.len(), ToolType::ALL.len());
        let mut names: Vec<_> = decls.iter().map(|d| d.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), decls.len(), "two tools share a name");
    }

    #[test]
    fn a_declaration_carries_a_usable_schema() {
        let search = declarations().into_iter().find(|d| d.name == "web_search").unwrap();
        assert!(!search.description.is_empty());
        assert_eq!(search.parameters["type"], "object");
        assert_eq!(search.parameters["properties"]["query"]["type"], "string");
        assert_eq!(search.parameters["required"][0], "query");
    }

    #[test]
    fn every_vendor_shape_wraps_the_same_schema() {
        // The reason `parameters()` exists. If these ever disagree, one provider
        // has been told a different set of arguments than the others.
        for tool in ToolType::ALL {
            let schema = tool.parameters();
            assert_eq!(tool.to_openai_definition()["function"]["parameters"], schema);
            assert_eq!(tool.to_anthropic_definition()["input_schema"], schema);
            assert_eq!(tool.to_gemini_declaration().parameters, schema);
        }
    }

    #[tokio::test]
    async fn an_unknown_tool_still_gets_an_answer() {
        // The model blocks on this id. Silence is the one response that ends the
        // conversation instead of continuing it.
        let call = FunctionCall {
            id: "call-9".into(),
            name: "definitely_not_a_tool".into(),
            args: serde_json::json!({}),
        };
        let response = answer(&call).await;
        assert_eq!(response.id, "call-9");
        assert_eq!(response.name, "definitely_not_a_tool");
        assert!(response.response["error"].as_str().unwrap().contains("no such tool"));
    }

    #[tokio::test]
    async fn a_failing_tool_reports_failure_rather_than_vanishing() {
        // file_read on a path that cannot exist: the tool runs, refuses, and the
        // refusal has to reach the model as a normal answer.
        let call = FunctionCall {
            id: "call-1".into(),
            name: "file_read".into(),
            args: serde_json::json!({ "path": "../../etc/nope-not-here" }),
        };
        let response = answer(&call).await;
        assert_eq!(response.id, "call-1");
        assert_eq!(response.response["ok"], false);
        assert!(response.response["output"].is_string());
    }
}
