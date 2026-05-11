import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
	context as otelContext,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace,
	type Context,
} from "@opentelemetry/api";
import {
	getWebAutoInstrumentations,
	type InstrumentationConfigMap,
} from "@opentelemetry/auto-instrumentations-web";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
	registerInstrumentations,
	type Instrumentation,
} from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

type TelemetryValue = string | number | boolean | undefined | null;
type TelemetryAttributes = Record<string, TelemetryValue>;
export type TelemetryContext = Record<string, string>;
type BrowserErrorEventTarget = {
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(
		type: "unhandledrejection",
		listener: (event: PromiseRejectionEvent) => void,
	): void;
};

const DEFAULT_OTLP_BASE = "http://127.0.0.1:54418";
const SERVICE_NAME = "guided-review-app-client";
const SERVICE_VERSION = "0.1.0";
const TEXT_ATTRIBUTE_LIMIT = 4096;
const FETCH_INSTRUMENTATION = "@opentelemetry/instrumentation-fetch";
const XHR_INSTRUMENTATION =
	"@opentelemetry/instrumentation-xml-http-request";

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

function exporterEndpoints(): string[] {
	return [tracesEndpoint(), logsEndpoint()];
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

export function captureTelemetryContext(
	sourceContext: Context = otelContext.active(),
): TelemetryContext {
	const carrier: TelemetryContext = {};
	propagation.inject(sourceContext, carrier);
	return carrier;
}

export function withTelemetryContext<T>(
	telemetryContext: TelemetryContext | null | undefined,
	fn: () => T,
): T {
	if (!telemetryContext || Object.keys(telemetryContext).length === 0) {
		return fn();
	}
	const extracted = propagation.extract(otelContext.active(), telemetryContext);
	return otelContext.with(extracted, fn);
}

export async function withClientTelemetrySpan<T>(
	name: string,
	attrs: TelemetryAttributes,
	fn: (telemetryContext: TelemetryContext) => Promise<T>,
): Promise<T> {
	const attributes = cleanAttributes(attrs);
	const span = trace.getTracer("guided-review-client").startSpan(name, {
		kind: SpanKind.INTERNAL,
		attributes,
	});
	const activeContext = trace.setSpan(otelContext.active(), span);
	return otelContext.with(activeContext, async () => {
		try {
			return await fn(captureTelemetryContext(activeContext));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			throw error;
		} finally {
			span.end();
		}
	});
}

export function createClientAutoInstrumentationConfig(): InstrumentationConfigMap {
	const ignoreUrls = exporterEndpoints();
	return {
		[FETCH_INSTRUMENTATION]: {
			ignoreUrls,
		},
		[XHR_INSTRUMENTATION]: {
			ignoreUrls,
		},
	} satisfies InstrumentationConfigMap;
}

export function createClientAutoInstrumentations(): Instrumentation[] {
	return getWebAutoInstrumentations(createClientAutoInstrumentationConfig());
}

export function registerGlobalBrowserErrorHandlers(
	target: BrowserErrorEventTarget,
) {
	target.addEventListener("error", (event) => {
		recordClientTelemetryError(
			"client.browser.error",
			event.error ?? (event.message || "Uncaught browser error"),
			{
				"error.source": "window.error",
				"error.filename": event.filename,
				"error.lineno": event.lineno,
				"error.colno": event.colno,
			},
		);
	});

	target.addEventListener("unhandledrejection", (event) => {
		recordClientTelemetryError(
			"client.browser.unhandled_rejection",
			event.reason ?? "Unhandled promise rejection",
			{
				"error.source": "window.unhandledrejection",
			},
		);
	});
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

	registerInstrumentations({
		instrumentations: createClientAutoInstrumentations(),
		tracerProvider: traceProvider,
		loggerProvider: logProvider,
	});

	window.addEventListener("pagehide", () => {
		void flushClientTelemetry();
	});
	registerGlobalBrowserErrorHandlers(window);

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
	const timestamp = new Date();
	logs.getLogger("guided-review-client").emit({
		eventName: name,
		timestamp,
		observedTimestamp: timestamp,
		severityText,
		severityNumber,
		body: name,
		attributes,
	});
}

export async function flushClientTelemetry() {
	await Promise.all([traceProvider?.forceFlush(), logProvider?.forceFlush()]);
}
