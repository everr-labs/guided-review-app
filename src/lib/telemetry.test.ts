import assert from "node:assert/strict";
import test from "node:test";
import {
	context as otelContext,
	propagation,
	trace,
	TraceFlags,
} from "@opentelemetry/api";
import { logs, type Logger, type LogRecord } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import {
	captureTelemetryContext,
	createClientAutoInstrumentationConfig,
	createClientAutoInstrumentations,
	recordClientTelemetry,
	registerGlobalBrowserErrorHandlers,
	withTelemetryContext,
} from "./telemetry";

test.afterEach(() => {
	otelContext.disable();
	logs.disable();
	propagation.disable();
});

test("recordClientTelemetry sends log timestamps as Date values", () => {
	let emitted: LogRecord | undefined;
	const logger: Logger = {
		emit(record) {
			emitted = record;
		},
		enabled() {
			return true;
		},
	};

	logs.setGlobalLoggerProvider({
		getLogger() {
			return logger;
		},
	});

	recordClientTelemetry("client.test.timestamped_log");

	assert(emitted);
	assert(emitted.timestamp instanceof Date);
	assert.equal(emitted.observedTimestamp, emitted.timestamp);
});

test("captureTelemetryContext injects the active W3C trace context", () => {
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	const span = trace.wrapSpanContext({
		traceId: "0af7651916cd43dd8448eb211c80319c",
		spanId: "b7ad6b7169203331",
		traceFlags: TraceFlags.SAMPLED,
		isRemote: false,
	});
	const ctx = trace.setSpan(otelContext.active(), span);

	const carrier = captureTelemetryContext(ctx);

	assert.equal(
		carrier.traceparent,
		"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	);
});

test("withTelemetryContext makes an extracted W3C trace context active", () => {
	otelContext.setGlobalContextManager(new StackContextManager().enable());
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	const traceId = withTelemetryContext(
		{
			traceparent:
				"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		},
		() => trace.getSpan(otelContext.active())?.spanContext().traceId,
	);

	assert.equal(traceId, "0af7651916cd43dd8448eb211c80319c");
});

test("client auto-instrumentations ignore telemetry exporter requests", () => {
	const config = createClientAutoInstrumentationConfig() as Record<
		string,
		{ ignoreUrls?: Array<string | RegExp> }
	>;
	const instrumentations = createClientAutoInstrumentations();
	const names = instrumentations.map(
		(instrumentation) => instrumentation.instrumentationName,
	);

	assert(names.includes("@opentelemetry/instrumentation-fetch"));

	for (const name of [
		"@opentelemetry/instrumentation-fetch",
		"@opentelemetry/instrumentation-xml-http-request",
	]) {
		const ignoreUrls = config[name]?.ignoreUrls ?? [];

		assert(ignoreUrls.includes("http://127.0.0.1:54418/v1/traces"));
		assert(ignoreUrls.includes("http://127.0.0.1:54418/v1/logs"));
	}
});

test("global browser error hooks record errors and unhandled rejections", () => {
	const emitted: LogRecord[] = [];
	const logger: Logger = {
		emit(record) {
			emitted.push(record);
		},
		enabled() {
			return true;
		},
	};
	const listeners = new Map<string, (event: unknown) => void>();

	logs.setGlobalLoggerProvider({
		getLogger() {
			return logger;
		},
	});

	registerGlobalBrowserErrorHandlers({
		addEventListener(type: string, listener: (event: unknown) => void) {
			listeners.set(type, listener);
		},
	} as Parameters<typeof registerGlobalBrowserErrorHandlers>[0]);

	const scriptError = new Error("render failed");
	listeners.get("error")?.({
		message: "Script error",
		filename: "app:///main.js",
		lineno: 42,
		colno: 7,
		error: scriptError,
	});
	listeners.get("unhandledrejection")?.({
		reason: "background task failed",
	});

	assert.deepEqual([...listeners.keys()], ["error", "unhandledrejection"]);
	assert.equal(emitted.length, 2);
	assert.equal(emitted[0].eventName, "client.browser.error");
	assert.equal(emitted[0].attributes?.["error.message"], "render failed");
	assert.equal(emitted[0].attributes?.["error.source"], "window.error");
	assert.equal(emitted[0].attributes?.["error.filename"], "app:///main.js");
	assert.equal(emitted[0].attributes?.["error.lineno"], 42);
	assert.equal(emitted[0].attributes?.["error.colno"], 7);
	assert.equal(emitted[1].eventName, "client.browser.unhandled_rejection");
	assert.equal(emitted[1].attributes?.["error.message"], "background task failed");
	assert.equal(
		emitted[1].attributes?.["error.source"],
		"window.unhandledrejection",
	);
});
