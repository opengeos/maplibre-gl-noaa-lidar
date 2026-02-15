import maplibregl from 'maplibre-gl';
import { NoaaLidarControl, NoaaLidarLayerAdapter } from '../../src/index';
import { LayerControl } from 'maplibre-gl-layer-control';
import { TerrainControl } from 'maplibre-gl-components';

import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-lidar/style.css';
import 'maplibre-gl-layer-control/style.css';

// Create map centered on South Carolina coast (good NOAA coastal LiDAR coverage)
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [-100, 40],
  zoom: 3.5,
  maxPitch: 85,
});

// Add navigation controls
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

// // Add terrain control
// map.addControl(new TerrainControl(), 'top-right');

// Add NOAA LiDAR control when map loads
map.on('load', () => {
  // Find the first symbol layer to insert layers below labels
  const layers = map.getStyle().layers;
  let firstSymbolId: string | undefined;
  for (const layer of layers) {
    if (layer.type === 'symbol') {
      firstSymbolId = layer.id;
      break;
    }
  }

  // Add Google Satellite basemap
  map.addSource('google-satellite', {
    type: 'raster',
    tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
    tileSize: 256,
    attribution: '&copy; Google',
  });

  map.addLayer(
    {
      id: 'google-satellite',
      type: 'raster',
      source: 'google-satellite',
      paint: {
        'raster-opacity': 1,
      },
      layout: {
        visibility: 'none',
      },
    },
  );

  // Create the NOAA LiDAR control (created first for adapter, added to map after layer control)
  const noaaLidarControl = new NoaaLidarControl({
    title: 'NOAA Coastal LiDAR',
    collapsed: false,
    maxResults: 100,
    showFootprints: true,
    autoZoomToResults: true,
    lidarControlOptions: {
      pointSize: 2,
      colorScheme: 'elevation',
    },
  });

  // Create the NOAA LiDAR layer adapter for layer control integration
  const noaaLidarAdapter = new NoaaLidarLayerAdapter(noaaLidarControl);

  // Add layer control with the NOAA LiDAR adapter
  const layerControl = new LayerControl({
    collapsed: true,
    basemapStyleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    customLayerAdapters: [noaaLidarAdapter],
    excludeDrawnLayers: true,
    excludeLayers: ['*Draw*', "Noaa*"],
  });
  map.addControl(layerControl, 'top-right');

  // Add NOAA LiDAR control to the map (after layer control)
  map.addControl(noaaLidarControl, 'top-right');

  // Listen for events
  noaaLidarControl.on('searchstart', () => {
    console.log('Search started...');
  });

  noaaLidarControl.on('searchcomplete', (event) => {
    console.log(`Found ${event.items?.length ?? 0} LiDAR datasets`);
  });

  noaaLidarControl.on('searcherror', (event) => {
    console.error('Search failed:', event.error);
  });

  noaaLidarControl.on('loadstart', () => {
    console.log('Loading LiDAR data...');
  });

  noaaLidarControl.on('loadcomplete', (event) => {
    console.log('LiDAR data loaded:', event.pointCloud);
  });

  noaaLidarControl.on('loaderror', (event) => {
    console.error('Load failed:', event.error);
  });

  console.log('NOAA LiDAR control added to map');
});
