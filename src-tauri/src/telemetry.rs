use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use std::sync::OnceLock;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

const DEFAULT_OTLP_BASE: &str = "http://127.0.0.1:54418";
const SERVICE_NAME: &str = "guided-review-app";

pub fn init() {
    if PROVIDER.get().is_some() {
        return;
    }

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
