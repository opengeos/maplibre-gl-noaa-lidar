// Import styles
import './lib/styles/noaa-lidar-control.css';

// Main entry point - Core exports
export { NoaaLidarControl } from './lib/core/NoaaLidarControl';

// Adapter exports
export { NoaaLidarLayerAdapter } from './lib/adapters';

// STAC exports
export { StacSearcher } from './lib/stac';

// Results exports
export { FootprintLayer } from './lib/results';

// Type exports
export type {
  // Primary types
  NoaaLidarControlOptions,
  NoaaLidarState,
  NoaaLidarControlEvent,
  NoaaLidarEventHandler,
  NoaaLidarEventData,
  NoaaLidarControlReactProps,
  // STAC types
  StacItem,
  StacSearchParams,
  StacSearchResponse,
  StacAsset,
  StacLink,
  // Search types
  SearchMode,
  LoadedItemInfo,
  // EPT types
  DataSourceType,
  EptFeature,
  EptSearchResponse,
  UnifiedSearchItem,
  CacheEntry,
  // Metadata types (re-exported from maplibre-gl-lidar)
  PointCloudFullMetadata,
  DimensionInfo,
  CopcMetadata,
  EptExtendedMetadata,
  // Cross-section types (re-exported from maplibre-gl-lidar)
  CrossSectionLine,
  ProfilePoint,
  ElevationProfile,
} from './lib/core/types';

export type { FootprintLayerOptions } from './lib/results';

// Re-export colormap types from maplibre-gl-lidar
export type { ColormapName, ColorRangeConfig } from 'maplibre-gl-lidar';

// Utility exports
export {
  clamp,
  formatNumber,
  formatPointCount,
  formatBbox,
  generateId,
  debounce,
  throttle,
  classNames,
  truncate,
  getItemShortName,
  getBboxFromGeometry,
  // Converter utilities
  stacToUnified,
  eptToUnified,
  getUnifiedItemName,
  getUnifiedItemMetadata,
} from './lib/utils';
