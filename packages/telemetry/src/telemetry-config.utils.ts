/** Environment map read for the OpenTelemetry export opt-in variables. */
export type Environment = Record<string, string | undefined>

const isSet = (value: string | undefined) => Boolean(value?.trim())

/**
 * Detects an OpenTelemetry trace-export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether the general or the traces-specific OTLP endpoint is set and non-blank.
 */
export const hasTraceExportConfig = (env: Environment) =>
  isSet(env.OTEL_EXPORTER_OTLP_ENDPOINT) || isSet(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)

/**
 * Detects an OpenTelemetry metric-export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether the general or the metrics-specific OTLP endpoint is set and non-blank.
 */
export const hasMetricExportConfig = (env: Environment) =>
  isSet(env.OTEL_EXPORTER_OTLP_ENDPOINT) || isSet(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)

/**
 * Detects any complete OpenTelemetry export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether at least one telemetry signal has a configured OTLP endpoint.
 * @remarks Endpoint values may embed access tokens, so callers must never log them; this predicate
 * exists so opt-in detection needs no access to the values themselves.
 */
export const hasTelemetryConfig = (env: Environment) =>
  hasTraceExportConfig(env) || hasMetricExportConfig(env)

/**
 * Resolves the configured HTTP exporter URL without the SDK's localhost fallback.
 * @param env - Process environment read by the OTLP exporters.
 * @param signal - Signal selecting the endpoint override and default resource path.
 * @returns A validated absolute HTTP(S) URL, with the resource path appended for a general endpoint.
 * @throws TypeError when the effective endpoint is absent, malformed, or not HTTP(S).
 */
export const resolveOtlpHttpEndpoint = (env: Environment, signal: 'traces' | 'metrics'): string => {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]?.trim()
  const endpoint = specific || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) throw new TypeError('Invalid OTLP endpoint')
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Invalid OTLP endpoint')
  }
  if (!specific) url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${signal}`
  return url.toString()
}
