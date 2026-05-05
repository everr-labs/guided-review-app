import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

type TelemetryValue = string | number | boolean | undefined | null;
type TelemetryAttributes = Record<string, TelemetryValue>;

const DEFAULT_OTLP_BASE = "http://127.0.0.1:54418";
const SERVICE_NAME = "guided-review-app-client";
const SERVICE_VERSION = "0.1.0";
const TEXT_ATTRIBUTE_LIMIT = 4096;

let traceProvider: WebTracerProvider | null = null;
let logProvider: LoggerProvider | null = null;
let sequence = 0;

function viteEnv(name: string): string | undefined {
	const meta = import.meta as ImportMeta & {
		env?: Record<string, string | undefined>;
	};
	return meta.env?.[name];
}

function tracesEndpoint(): string {
	const configured =
		viteEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT") ?? DEFAULT_OTLP_BASE;
	if (configured.includes("/v1/")) return configured;
	return `${configured.replace(/\/+$/, "")}/v1/traces`;
}

function logsEndpoint(): string {
	const configured =
		viteEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT") ?? DEFAULT_OTLP_BASE;
	if (configured.includes("/v1/")) return configured.replace(/\/v1\/traces$/, "/v1/logs");
	return `${configured.replace(/\/+$/, "")}/v1/logs`;
}

function cleanAttributes(attrs: TelemetryAttributes): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(attrs).filter(
			(entry): entry is [string, string | number | boolean] =>
				entry[1] !== undefined && entry[1] !== null,
		),
	);
}

export function truncateTelemetryText(text: string): string {
	if (text.length <= TEXT_ATTRIBUTE_LIMIT) return text;
	return text.slice(0, TEXT_ATTRIBUTE_LIMIT);
}

export function initClientTelemetry() {
	if (traceProvider || typeof window === "undefined") return;

	const traceExporter = new OTLPTraceExporter({
		url: tracesEndpoint(),
	});
	const logExporter = new OTLPLogExporter({
		url: logsEndpoint(),
	});
	const resource = resourceFromAttributes({
		"service.name": SERVICE_NAME,
		"service.version": SERVICE_VERSION,
	});

	traceProvider = new WebTracerProvider({
		resource,
		spanLimits: {
			attributeCountLimit: 128,
			attributeValueLengthLimit: TEXT_ATTRIBUTE_LIMIT,
			eventCountLimit: 128,
		},
		spanProcessors: [
			new BatchSpanProcessor(traceExporter, {
				maxQueueSize: 512,
				maxExportBatchSize: 64,
				scheduledDelayMillis: 500,
				exportTimeoutMillis: 3000,
			}),
		],
	});
	traceProvider.register();

	logProvider = new LoggerProvider({
		resource,
		logRecordLimits: {
			attributeCountLimit: 128,
			attributeValueLengthLimit: TEXT_ATTRIBUTE_LIMIT,
		},
		processors: [
			new BatchLogRecordProcessor(logExporter, {
				maxQueueSize: 512,
				maxExportBatchSize: 64,
				scheduledDelayMillis: 500,
				exportTimeoutMillis: 3000,
			}),
		],
	});
	logs.setGlobalLoggerProvider(logProvider);

	window.addEventListener("pagehide", () => {
		void flushClientTelemetry();
	});

	recordClientTelemetry("client.telemetry.initialized", {
		"otel.exporter.otlp.endpoint": tracesEndpoint(),
		"otel.exporter.otlp.logs_endpoint": logsEndpoint(),
	});
}

export function recordClientTelemetry(
	name: string,
	attrs: TelemetryAttributes = {},
) {
	const eventSequence = sequence++;
	const attributes = cleanAttributes({
		...attrs,
		"client.sequence": eventSequence,
	});
	const span = trace.getTracer("guided-review-client").startSpan(name, {
		kind: SpanKind.INTERNAL,
		attributes,
	});
	span.end();
	recordClientLog(name, "INFO", SeverityNumber.INFO, attributes);
}

export function recordClientTelemetryError(
	name: string,
	error: unknown,
	attrs: TelemetryAttributes = {},
) {
	const message = error instanceof Error ? error.message : String(error);
	const eventSequence = sequence++;
	const attributes = cleanAttributes({
		...attrs,
		"client.sequence": eventSequence,
		"error.message": message,
	});
	const span = trace.getTracer("guided-review-client").startSpan(name, {
		kind: SpanKind.INTERNAL,
		attributes,
	});
	span.setStatus({ code: SpanStatusCode.ERROR, message });
	span.end();
	recordClientLog(name, "ERROR", SeverityNumber.ERROR, attributes);
}

function recordClientLog(
	name: string,
	severityText: string,
	severityNumber: SeverityNumber,
	attributes: Record<string, string | number | boolean>,
) {
	logs.getLogger("guided-review-client").emit({
		eventName: name,
		severityText,
		severityNumber,
		body: name,
		attributes,
	});
}

export async function flushClientTelemetry() {
	await Promise.all([traceProvider?.forceFlush(), logProvider?.forceFlush()]);
}
