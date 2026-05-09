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
import { recordClientTelemetry } from "./telemetry";

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

test("captureTelemetryContext injects the active W3C trace context", async () => {
	const telemetry = await import("./telemetry");
	const captureTelemetryContext = (
		telemetry as {
			captureTelemetryContext?: (ctx?: ReturnType<typeof otelContext.active>) => Record<string, string>;
		}
	).captureTelemetryContext;

	if (typeof captureTelemetryContext !== "function") {
		assert.fail("captureTelemetryContext should be exported");
	}

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

test("withTelemetryContext makes an extracted W3C trace context active", async () => {
	const telemetry = await import("./telemetry");
	const withTelemetryContext = (
		telemetry as {
			withTelemetryContext?: <T>(
				carrier: Record<string, string> | undefined,
				fn: () => T,
			) => T;
		}
	).withTelemetryContext;

	if (typeof withTelemetryContext !== "function") {
		assert.fail("withTelemetryContext should be exported");
	}

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

test("client auto-instrumentations ignore telemetry exporter requests", async () => {
	const telemetry = await import("./telemetry");
	const createClientAutoInstrumentationConfig = (
		telemetry as {
			createClientAutoInstrumentationConfig?: () => Record<
				string,
				{
					ignoreUrls?: Array<string | RegExp>;
				}
			>;
		}
	).createClientAutoInstrumentationConfig;
	const createClientAutoInstrumentations = (
		telemetry as {
			createClientAutoInstrumentations?: () => Array<{
				instrumentationName: string;
			}>;
		}
	).createClientAutoInstrumentations;

	if (typeof createClientAutoInstrumentationConfig !== "function") {
		assert.fail("createClientAutoInstrumentationConfig should be exported");
	}
	if (typeof createClientAutoInstrumentations !== "function") {
		assert.fail("createClientAutoInstrumentations should be exported");
	}

	const config = createClientAutoInstrumentationConfig();
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

test("global browser error hooks record errors and unhandled rejections", async () => {
	const telemetry = await import("./telemetry");
	const registerGlobalBrowserErrorHandlers = (
		telemetry as {
			registerGlobalBrowserErrorHandlers?: (target: {
				addEventListener(
					type: string,
					listener: (event: unknown) => void,
				): void;
			}) => void;
		}
	).registerGlobalBrowserErrorHandlers;

	if (typeof registerGlobalBrowserErrorHandlers !== "function") {
		assert.fail("registerGlobalBrowserErrorHandlers should be exported");
	}

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
		addEventListener(type, listener) {
			listeners.set(type, listener);
		},
	});

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
