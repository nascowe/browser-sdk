import type { Context } from '../../tools/context'
import { display } from '../../tools/display'
import { toStackTraceString } from '../../tools/error'
import { assign, combine, jsonStringify } from '../../tools/utils'
import { canUseEventBridge, getEventBridge } from '../../transport'
import type { Configuration } from '../configuration'
import { computeStackTrace } from '../tracekit'
import { isExperimentalFeatureEnabled } from '../configuration'
import { Observable } from '../../tools/observable'
import { timeStampNow } from '../../tools/timeUtils'
import { startMonitoringBatch } from './startMonitoringBatch'
import type { TelemetryEvent } from './telemetryEvent.types'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

enum StatusType {
  debug = 'debug',
  error = 'error',
}

export interface InternalMonitoring {
  setExternalContextProvider: (provider: () => Context) => void
  setTelemetryContextProvider: (provider: () => Context) => void
  telemetryEventObservable: Observable<TelemetryEvent & Context>
}

export interface MonitoringMessage extends Context {
  message: string
  status: StatusType
  error?: {
    kind?: string
    stack: string
  }
}

const monitoringConfiguration: {
  debugMode?: boolean
  maxMessagesPerPage: number
  sentMessageCount: number
} = { maxMessagesPerPage: 0, sentMessageCount: 0 }

let monitoringMessageObservable: Observable<MonitoringMessage> | undefined

export function startInternalMonitoring(configuration: Configuration): InternalMonitoring {
  let externalContextProvider: () => Context
  let telemetryContextProvider: () => Context
  monitoringMessageObservable = new Observable<MonitoringMessage>()
  const telemetryEventObservable = new Observable<TelemetryEvent & Context>()

  if (canUseEventBridge()) {
    const bridge = getEventBridge<'internal_log', MonitoringMessage>()!
    monitoringMessageObservable.subscribe((message: MonitoringMessage) =>
      bridge.send('internal_log', withContext(message))
    )
  } else if (configuration.internalMonitoringEndpointBuilder) {
    const batch = startMonitoringBatch(
      configuration,
      configuration.internalMonitoringEndpointBuilder,
      configuration.replica?.internalMonitoringEndpointBuilder
    )
    monitoringMessageObservable.subscribe((message: MonitoringMessage) => batch.add(withContext(message)))
  }
  if (isExperimentalFeatureEnabled('telemetry')) {
    if (canUseEventBridge()) {
      const bridge = getEventBridge<'internal_telemetry', TelemetryEvent>()!
      monitoringMessageObservable.subscribe((message: MonitoringMessage) =>
        bridge.send('internal_telemetry', toTelemetryEvent(message))
      )
    } else if (configuration.internalMonitoringEndpointBuilder) {
      monitoringMessageObservable.subscribe((message: MonitoringMessage) =>
        telemetryEventObservable.notify(toTelemetryEvent(message))
      )
    }
  }

  assign(monitoringConfiguration, {
    maxMessagesPerPage: configuration.maxInternalMonitoringMessagesPerPage,
    sentMessageCount: 0,
  })

  function withContext(message: MonitoringMessage) {
    return combine(
      { date: timeStampNow() },
      externalContextProvider !== undefined ? externalContextProvider() : {},
      message
    )
  }

  function toTelemetryEvent(message: MonitoringMessage): TelemetryEvent & Context {
    return combine(
      {
        date: timeStampNow(),
        service: 'browser-sdk',
        version: __BUILD_ENV__SDK_VERSION__,
        _dd: {
          event_type: 'internal_telemetry' as const,
        },
      },
      telemetryContextProvider !== undefined ? telemetryContextProvider() : {},
      message
    )
  }

  return {
    setExternalContextProvider: (provider: () => Context) => {
      externalContextProvider = provider
    },
    setTelemetryContextProvider: (provider: () => Context) => {
      telemetryContextProvider = provider
    },
    telemetryEventObservable,
  }
}

export function startFakeInternalMonitoring() {
  monitoringMessageObservable = new Observable<MonitoringMessage>()
  const messages: MonitoringMessage[] = []
  assign(monitoringConfiguration, {
    maxMessagesPerPage: Infinity,
    sentMessageCount: 0,
  })
  monitoringMessageObservable.subscribe((message: MonitoringMessage) => {
    messages.push(message)
  })

  return messages
}

export function resetInternalMonitoring() {
  monitoringMessageObservable = undefined
}

export function monitored<T extends (...params: any[]) => unknown>(
  _: any,
  __: string,
  descriptor: TypedPropertyDescriptor<T>
) {
  const originalMethod = descriptor.value!
  descriptor.value = function (this: any, ...args: Parameters<T>) {
    const decorated = monitoringMessageObservable ? monitor(originalMethod) : originalMethod
    return decorated.apply(this, args) as ReturnType<T>
  } as T
}

export function monitor<T extends (...args: any[]) => any>(fn: T): T {
  return function (this: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return callMonitored(fn, this, arguments as unknown as Parameters<T>)
  } as unknown as T // consider output type has input type
}

export function callMonitored<T extends (...args: any[]) => any>(
  fn: T,
  context: ThisParameterType<T>,
  args: Parameters<T>
): ReturnType<T> | undefined
export function callMonitored<T extends (this: void) => any>(fn: T): ReturnType<T> | undefined
export function callMonitored<T extends (...args: any[]) => any>(
  fn: T,
  context?: any,
  args?: any
): ReturnType<T> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return fn.apply(context, args)
  } catch (e) {
    logErrorIfDebug(e)
    try {
      addMonitoringError(e)
    } catch (e) {
      logErrorIfDebug(e)
    }
  }
}

export function addMonitoringMessage(message: string, context?: Context) {
  logMessageIfDebug(message, context)
  addToMonitoring(
    assign(
      {
        message,
        status: StatusType.debug,
      },
      context
    )
  )
}

export function addMonitoringError(e: unknown) {
  addToMonitoring(
    assign(
      {
        status: StatusType.error,
      },
      formatError(e)
    )
  )
}

function addToMonitoring(message: MonitoringMessage) {
  if (
    monitoringMessageObservable &&
    monitoringConfiguration.sentMessageCount < monitoringConfiguration.maxMessagesPerPage
  ) {
    monitoringConfiguration.sentMessageCount += 1
    monitoringMessageObservable?.notify(message)
  }
}

function formatError(e: unknown) {
  if (e instanceof Error) {
    const stackTrace = computeStackTrace(e)
    return {
      error: {
        kind: stackTrace.name,
        stack: toStackTraceString(stackTrace),
      },
      message: stackTrace.message!,
    }
  }
  return {
    error: {
      stack: 'Not an instance of error',
    },
    message: `Uncaught ${jsonStringify(e)!}`,
  }
}

export function setDebugMode(debugMode: boolean) {
  monitoringConfiguration.debugMode = debugMode
}

function logErrorIfDebug(e: any) {
  if (monitoringConfiguration.debugMode) {
    display.error('[INTERNAL ERROR]', e)
  }
}

function logMessageIfDebug(message: any, context?: Context) {
  if (monitoringConfiguration.debugMode) {
    display.log('[MONITORING MESSAGE]', message, context)
  }
}
