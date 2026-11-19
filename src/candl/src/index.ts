// Orbit Pro stand-in for the CandL library entry point. The custom indicators only need the
// built-in indicator registry, the interval tables and the shared types; the CandL chart engine,
// drawing tools and data providers are not part of Orbit, so they are not imported here.

export * from './indicators'
export type { IndicatorDef, IndicatorOutput, IndicatorParam, IndicatorPlacement, PlotStyle } from './indicators/types'
export type { Candle, Interval, SymbolInfo, Theme } from './core/types'
export { INTERVALS, INTERVAL_MS, INTERVAL_LABELS } from './core/types'
export type { Converters, DrawEnv } from './drawings/types'
export type { DataProvider, TradeEvent, TickerUpdate, TickerStat, DepthSnapshot } from './data/types'

// Types the indicator files reference from the engine (type positions only).
export type IChartEngine = any // eslint-disable-line @typescript-eslint/no-explicit-any
export type ChartType = string
export type PriceTag = any // eslint-disable-line @typescript-eslint/no-explicit-any

// Only the stand-alone Options view in options.ts creates an engine; Orbit never opens that view
// (it has its own option chain), so this throws if something calls it.
export function createChartEngine(): never {
  throw new Error('The CandL chart engine is not available in Orbit Pro')
}
