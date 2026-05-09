use opentelemetry::trace::TracerProvider as _;
use opentelemetry::{global, Context};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

const DEFAULT_OTLP_BASE: &str = "http://127.0.0.1:54418";
const SERVICE_NAME: &str = "guided-review-app";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelemetryContext {
    #[serde(flatten)]
    fields: HashMap<String, String>,
}

impl TelemetryContext {
    #[cfg(test)]
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            fields: pairs
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }

    fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

pub fn extract_context(telemetry_context: Option<&TelemetryContext>) -> Context {
    match telemetry_context {
        Some(carrier) if !carrier.is_empty() => {
            global::get_text_map_propagator(|propagator| propagator.extract(&carrier.fields))
        }
        _ => Context::new(),
    }
}

pub fn set_span_parent(span: &tracing::Span, telemetry_context: Option<&TelemetryContext>) {
    let Some(carrier) = telemetry_context.filter(|carrier| !carrier.is_empty()) else {
        return;
    };
    if let Err(error) = span.set_parent(extract_context(Some(carrier))) {
        tracing::warn!(error = ?error, "failed to attach propagated telemetry context");
    }
}

pub fn current_context() -> TelemetryContext {
    let context = tracing::Span::current().context();
    let mut fields = HashMap::new();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut fields);
    });
    TelemetryContext { fields }
}

pub fn init() {
    if PROVIDER.get().is_some() {
        return;
    }
    global::set_text_map_propagator(TraceContextPropagator::new());

    let base = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| DEFAULT_OTLP_BASE.to_string());
    let endpoint = if base.contains("/v1/") {
        base.clone()
    } else {
        format!("{}/v1/traces", base.trim_end_matches('/'))
    };

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_endpoint(&endpoint)
        .with_protocol(Protocol::HttpBinary)
        .build()
    {
        Ok(e) => e,
        Err(err) => {
            eprintln!("[telemetry] OTLP exporter init failed ({err}); telemetry disabled");
            install_stdout_only();
            return;
        }
    };

    let resource = Resource::builder().with_service_name(SERVICE_NAME).build();

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();

    let tracer = provider.tracer(SERVICE_NAME);
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,guided_review_app_lib=debug"));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(otel_layer)
        .try_init();

    let _ = PROVIDER.set(provider);
    eprintln!("[telemetry] exporting to {endpoint}");
}

fn install_stdout_only() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,guided_review_app_lib=debug"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .try_init();
}

pub fn shutdown() {
    if let Some(p) = PROVIDER.get() {
        let _ = p.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::global;
    use opentelemetry::trace::TraceContextExt;
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    #[test]
    fn extracts_w3c_traceparent_from_telemetry_context() {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let carrier = TelemetryContext::from_pairs([(
            "traceparent",
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        )]);

        let extracted = extract_context(Some(&carrier));

        assert_eq!(
            extracted.span().span_context().trace_id().to_string(),
            "0af7651916cd43dd8448eb211c80319c"
        );
    }
}
