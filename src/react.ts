// React entry point
export { NoaaLidarControlReact } from './lib/core/NoaaLidarControlReact';

// React hooks
export { useNoaaLidarState } from './lib/hooks';

// Re-export types for React consumers
export type {
  // Primary types
  NoaaLidarControlOptions,
  NoaaLidarState,
  NoaaLidarControlReactProps,
  NoaaLidarControlEvent,
  NoaaLidarEventHandler,
  NoaaLidarEventData,
  // Other types
  StacItem,
  StacSearchParams,
  StacSearchResponse,
  SearchMode,
} from './lib/core/types';
