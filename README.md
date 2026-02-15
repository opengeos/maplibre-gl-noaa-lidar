# maplibre-gl-noaa-lidar

A MapLibre GL JS plugin for searching and visualizing [NOAA Coastal LiDAR data](https://coast.noaa.gov/dataviewer/#/lidar/search/) from [AWS Open Data](https://registry.opendata.aws/noaa-coastal-lidar/).

[![npm version](https://img.shields.io/npm/v/maplibre-gl-noaa-lidar.svg)](https://www.npmjs.com/package/maplibre-gl-noaa-lidar)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Search NOAA Coastal LiDAR data by map extent or custom bounding box
- Uses EPT (Entwine Point Tiles) format for efficient point cloud streaming
- View search results with dataset footprints on the map
- Load and visualize point cloud data with dynamic streaming
- Customizable color schemes (elevation, intensity, classification, RGB)
- React components and hooks for easy integration
- TypeScript support with full type definitions
- Local caching of STAC catalog for fast searches

## Installation

```bash
npm install maplibre-gl-noaa-lidar maplibre-gl maplibre-gl-lidar
```

## Quick Start

### Vanilla JavaScript/TypeScript

```typescript
import maplibregl from 'maplibre-gl';
import { NoaaLidarControl } from 'maplibre-gl-noaa-lidar';

// Import styles
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-lidar/style.css';
import 'maplibre-gl-noaa-lidar/style.css';

// Create map centered on a coastal area
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [-80.0, 32.8], // South Carolina coast
  zoom: 10,
});

map.on('load', () => {
  // Add NOAA LiDAR control
  const control = new NoaaLidarControl({
    title: 'NOAA Coastal LiDAR',
    collapsed: false,
    maxResults: 50,
  });

  map.addControl(control, 'top-right');

  // Listen for events
  control.on('searchcomplete', (event) => {
    console.log(`Found ${event.items?.length} datasets`);
  });

  control.on('loadcomplete', (event) => {
    console.log('Loaded:', event.pointCloud);
  });
});
```

### React

```tsx
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { NoaaLidarControlReact, useNoaaLidarState } from 'maplibre-gl-noaa-lidar/react';

// Import styles
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-lidar/style.css';
import 'maplibre-gl-noaa-lidar/style.css';

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState(null);
  const { state, toggle } = useNoaaLidarState({ collapsed: false });

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [-80.2, 25.8], // Florida coast
      zoom: 10,
    });

    mapInstance.on('load', () => {
      setMap(mapInstance);
    });

    return () => mapInstance.remove();
  }, []);

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {map && (
        <NoaaLidarControlReact
          map={map}
          title="NOAA Coastal LiDAR"
          collapsed={state.collapsed}
          onSearchComplete={(items) => console.log('Found:', items.length)}
        />
      )}
    </div>
  );
}
```

## API

### NoaaLidarControl

Main control class implementing MapLibre's `IControl` interface.

#### Options

| Option                | Type      | Default                | Description                       |
| --------------------- | --------- | ---------------------- | --------------------------------- |
| `collapsed`           | `boolean` | `true`                 | Start with panel collapsed        |
| `position`            | `string`  | `'top-right'`          | Control position                  |
| `title`               | `string`  | `'NOAA Coastal LiDAR'` | Panel title                       |
| `panelWidth`          | `number`  | `380`                  | Panel width in pixels             |
| `maxHeight`           | `number`  | `600`                  | Panel max height in pixels        |
| `maxResults`          | `number`  | `50`                   | Maximum search results            |
| `showFootprints`      | `boolean` | `true`                 | Show dataset footprints on map    |
| `autoZoomToResults`   | `boolean` | `true`                 | Auto-zoom to results              |
| `stacCatalogUrl`      | `string`  | NOAA catalog           | Custom STAC catalog URL           |
| `cacheDuration`       | `number`  | `604800000`            | Cache duration (7 days in ms)     |
| `lidarControlOptions` | `object`  | `{}`                   | Options for internal LidarControl |

#### Methods

| Method                | Description                        |
| --------------------- | ---------------------------------- |
| `searchByExtent()`    | Search by current map extent       |
| `searchByBbox(bbox)`  | Search by bounding box             |
| `startDrawing()`      | Start drawing mode                 |
| `stopDrawing()`       | Stop drawing mode                  |
| `selectItem(item)`    | Select an item                     |
| `deselectItem(item)`  | Deselect an item                   |
| `loadItem(item)`      | Load item's EPT data               |
| `loadSelectedItems()` | Load all selected items            |
| `unloadItem(itemId)`  | Unload an item                     |
| `clearResults()`      | Clear search results               |
| `clearLoadedItems()`  | Clear loaded items                 |
| `toggle()`            | Toggle panel open/closed           |
| `expand()`            | Expand panel                       |
| `collapse()`          | Collapse panel                     |
| `getState()`          | Get current control state          |
| `getLidarControl()`   | Get internal LidarControl instance |

#### Events

| Event            | Description       |
| ---------------- | ----------------- |
| `collapse`       | Panel collapsed   |
| `expand`         | Panel expanded    |
| `statechange`    | State changed     |
| `searchstart`    | Search started    |
| `searchcomplete` | Search completed  |
| `searcherror`    | Search error      |
| `loadstart`      | Loading started   |
| `loadcomplete`   | Loading completed |
| `loaderror`      | Loading error     |
| `unload`         | Item unloaded     |
| `drawstart`      | Drawing started   |
| `drawend`        | Drawing ended     |

### StacSearcher

STAC catalog client for searching NOAA Coastal LiDAR data.

```typescript
import { StacSearcher } from 'maplibre-gl-noaa-lidar';

const searcher = new StacSearcher();
const results = await searcher.searchByExtent(
  [-80, 32, -79, 33], // bbox: [west, south, east, north]
  25 // limit
);

// Get EPT URL for a specific item
const eptUrl = await searcher.getEptUrl(results.features[0]);
```

### NoaaLidarLayerAdapter

Adapter for integrating with [maplibre-gl-layer-control](https://github.com/opengeos/maplibre-gl-layer-control).

```typescript
import { NoaaLidarControl, NoaaLidarLayerAdapter } from 'maplibre-gl-noaa-lidar';
import { LayerControl } from 'maplibre-gl-layer-control';

const noaaControl = new NoaaLidarControl({ ... });
map.addControl(noaaControl, 'top-right');

const adapter = new NoaaLidarLayerAdapter(noaaControl);
const layerControl = new LayerControl({
  customLayerAdapters: [adapter],
});
map.addControl(layerControl, 'top-left');
```

## Data Source

This plugin uses NOAA Coastal LiDAR data from AWS Open Data:

- **Data**: [NOAA Coastal LiDAR](https://registry.opendata.aws/noaa-coastal-lidar/)
- **Format**: EPT (Entwine Point Tiles)
- **STAC Catalog**: `https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/catalog.json`

The data covers coastal areas of the United States and includes bathymetric and topographic LiDAR surveys.

## Docker

The examples can be run using Docker. The image is automatically built and published to GitHub Container Registry.

### Pull and Run

```bash
# Pull the latest image
docker pull ghcr.io/opengeos/maplibre-gl-noaa-lidar:latest

# Run the container
docker run -p 8080:80 ghcr.io/opengeos/maplibre-gl-noaa-lidar:latest
```

Then open http://localhost:8080/maplibre-gl-noaa-lidar/ in your browser.

### Build Locally

```bash
# Build the image
docker build -t maplibre-gl-noaa-lidar .

# Run the container
docker run -p 8080:80 maplibre-gl-noaa-lidar
```

## Dependencies

- [maplibre-gl](https://maplibre.org/) - Map rendering
- [maplibre-gl-lidar](https://github.com/opengeos/maplibre-gl-lidar) - LiDAR visualization

## License

MIT
