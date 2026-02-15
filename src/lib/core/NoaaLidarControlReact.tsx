import { useEffect, useRef } from 'react';
import type { NoaaLidarControlReactProps } from './types';
import { NoaaLidarControl } from './NoaaLidarControl';

/**
 * React wrapper component for NoaaLidarControl.
 *
 * @example
 * ```tsx
 * function MyMap() {
 *   const [map, setMap] = useState<Map | null>(null);
 *
 *   return (
 *     <div>
 *       <Map onLoad={setMap} />
 *       {map && (
 *         <NoaaLidarControlReact
 *           map={map}
 *           title="NOAA Coastal LiDAR"
 *           onSearchComplete={(items) => console.log('Found:', items.length)}
 *         />
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function NoaaLidarControlReact({
  map,
  onStateChange,
  onSearchComplete,
  onItemLoad,
  onError,
  onControlReady,
  ...options
}: NoaaLidarControlReactProps): null {
  const controlRef = useRef<NoaaLidarControl | null>(null);
  const addedRef = useRef(false);

  useEffect(() => {
    if (!map || addedRef.current) return;

    // Create and add control
    const control = new NoaaLidarControl(options);
    controlRef.current = control;

    // Set up event listeners
    if (onStateChange) {
      control.on('statechange', (event) => {
        onStateChange(event.state);
      });
    }

    if (onSearchComplete) {
      control.on('searchcomplete', (event) => {
        if (event.items) {
          onSearchComplete(event.items);
        }
      });
    }

    if (onItemLoad) {
      control.on('loadcomplete', (event) => {
        if (event.pointCloud) {
          onItemLoad(event.pointCloud);
        }
      });
    }

    if (onError) {
      control.on('searcherror', (event) => {
        if (event.error) {
          onError(event.error);
        }
      });
      control.on('loaderror', (event) => {
        if (event.error) {
          onError(event.error);
        }
      });
    }

    // Add control to map
    map.addControl(control, options.position ?? 'top-right');
    addedRef.current = true;

    // Notify when ready
    if (onControlReady) {
      onControlReady(control);
    }

    return () => {
      if (controlRef.current && map) {
        try {
          map.removeControl(controlRef.current);
        } catch {
          // Control may already be removed
        }
      }
      controlRef.current = null;
      addedRef.current = false;
    };
  }, [map]);

  // Handle option changes
  useEffect(() => {
    if (controlRef.current && options.collapsed !== undefined) {
      if (options.collapsed) {
        controlRef.current.collapse();
      } else {
        controlRef.current.expand();
      }
    }
  }, [options.collapsed]);

  // This component renders nothing - it's just a controller
  return null;
}
