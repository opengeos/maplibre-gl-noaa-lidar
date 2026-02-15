import type { IControl, Map as MapLibreMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl';
import { LidarControl } from 'maplibre-gl-lidar';
import type {
  ColorScheme,
  ColormapName,
  ColorRangeConfig,
  PointCloudFullMetadata,
  ElevationProfile,
} from 'maplibre-gl-lidar';
import type {
  NoaaLidarControlOptions,
  NoaaLidarState,
  NoaaLidarControlEvent,
  NoaaLidarEventHandler,
  NoaaLidarEventData,
  StacItem,
  LoadedItemInfo,
  UnifiedSearchItem,
} from './types';
import { StacSearcher } from '../stac/StacSearcher';
import { FootprintLayer } from '../results/FootprintLayer';
import { PanelBuilder } from '../gui/PanelBuilder';
import { getItemShortName, stacToUnified } from '../utils';

const DEFAULT_OPTIONS: Required<
  Omit<NoaaLidarControlOptions, 'className' | 'lidarControlOptions'>
> = {
  collapsed: true,
  position: 'top-right',
  title: 'NOAA Coastal LiDAR',
  panelWidth: 380,
  maxHeight: 500,
  maxResults: 50,
  showFootprints: true,
  autoZoomToResults: true,
  stacCatalogUrl:
    'https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/catalog.json',
  cacheDuration: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Drawing layer IDs
const DRAW_SOURCE_ID = 'noaa-lidar-draw-source';
const DRAW_FILL_LAYER_ID = 'noaa-lidar-draw-fill';
const DRAW_LINE_LAYER_ID = 'noaa-lidar-draw-line';

/**
 * A MapLibre GL control for searching and visualizing NOAA Coastal LiDAR data.
 *
 * @example
 * ```typescript
 * const control = new NoaaLidarControl({
 *   title: 'NOAA Coastal LiDAR',
 *   maxResults: 25,
 * });
 * map.addControl(control, 'top-right');
 *
 * // Search by map extent
 * await control.searchByExtent();
 *
 * // Load a selected item
 * control.loadItem(item);
 * ```
 */
export class NoaaLidarControl implements IControl {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _options: Required<Omit<NoaaLidarControlOptions, 'className' | 'lidarControlOptions'>> &
    Pick<NoaaLidarControlOptions, 'className' | 'lidarControlOptions'>;
  private _state: NoaaLidarState;
  private _eventHandlers: Map<NoaaLidarControlEvent, Set<NoaaLidarEventHandler>> = new Map();

  // Core components
  private _stacSearcher: StacSearcher;
  private _footprintLayer?: FootprintLayer;
  private _lidarControl?: LidarControl;
  private _panelBuilder?: PanelBuilder;
  private _initialized: boolean = false;

  // Drawing state
  private _drawStartPoint: { lng: number; lat: number } | null = null;
  private _boundMouseDown?: (e: MapMouseEvent) => void;
  private _boundMouseMove?: (e: MapMouseEvent) => void;
  private _boundMouseUp?: (e: MapMouseEvent) => void;

  // Track URL to item ID mapping for loaded items
  private _urlToItemId: Map<string, string> = new Map();

  /**
   * Creates a new NoaaLidarControl instance.
   *
   * @param options - Configuration options
   */
  constructor(options?: Partial<NoaaLidarControlOptions>) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._stacSearcher = new StacSearcher(
      this._options.stacCatalogUrl,
      undefined,
      this._options.cacheDuration
    );
    this._state = {
      collapsed: this._options.collapsed,
      panelWidth: this._options.panelWidth,
      maxHeight: this._options.maxHeight,
      dataSource: 'ept', // NOAA data is always EPT
      searchMode: 'none',
      isDrawing: false,
      drawnBbox: null,
      searchResults: [],
      selectedItems: new Set(),
      isSearching: false,
      searchError: null,
      totalMatched: null,
      loadedItems: new Map(),
      lidarState: null,
    };
  }

  // ==================== IControl Implementation ====================

  /**
   * Called when the control is added to the map.
   */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();

    // Create UI immediately
    this._container = this._createContainer();
    this._panel = this._createPanel();
    this._mapContainer.appendChild(this._panel);

    // Initialize components after map style is ready
    const initWhenReady = () => {
      if (!this._initialized) this._initComponents();
    };
    if (map.isStyleLoaded()) {
      initWhenReady();
    } else {
      map.once('style.load', initWhenReady);
    }

    this._setupEventListeners();

    if (!this._state.collapsed) {
      this._panel.classList.add('expanded');
      requestAnimationFrame(() => this._updatePanelPosition());
    }

    return this._container;
  }

  /**
   * Called when the control is removed from the map.
   */
  onRemove(): void {
    // Cleanup drawing
    this.stopDrawing();
    this._removeDrawLayers();

    // Cleanup components
    this._footprintLayer?.destroy();

    if (this._lidarControl && this._map) {
      try {
        this._map.removeControl(this._lidarControl);
      } catch {
        // Ignore errors
      }
    }

    // Remove DOM elements
    this._panel?.parentNode?.removeChild(this._panel);
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._eventHandlers.clear();
    this._initialized = false;
  }

  private _initComponents(): void {
    if (!this._map || this._initialized) return;

    try {
      // Initialize drawing layers
      this._initDrawLayers();

      // Initialize FootprintLayer
      this._footprintLayer = new FootprintLayer(this._map);
      this._footprintLayer.onClick((itemId) => {
        const item = this._state.searchResults.find((i) => i.id === itemId);
        if (item) {
          this.toggleItemSelection(item);
        }
      });

      // Initialize LidarControl (collapsed - we use our own UI)
      this._lidarControl = new LidarControl({
        collapsed: true,
        position: this._options.position,
        ...this._options.lidarControlOptions,
      });
      this._map.addControl(this._lidarControl, this._options.position);

      // Hide the LidarControl's toggle button since NoaaLidarControl provides its own UI
      const lidarEl = (this._lidarControl as any)._container as HTMLElement;
      if (lidarEl) lidarEl.style.display = 'none';

      // Listen to lidar control state changes
      this._lidarControl.on('statechange', (event) => {
        this.setState({ lidarState: event.state });
        // Show viz section when data is loaded
        if (this._panelBuilder && this._state.loadedItems.size > 0) {
          this._panelBuilder.showVisualizationSection(true);
        }
      });

      this._initialized = true;
    } catch (error) {
      console.error('Error in _initComponents:', error);
    }
  }

  private _initDrawLayers(): void {
    if (!this._map) return;

    // Add source
    if (!this._map.getSource(DRAW_SOURCE_ID)) {
      this._map.addSource(DRAW_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    // Add fill layer
    if (!this._map.getLayer(DRAW_FILL_LAYER_ID)) {
      this._map.addLayer({
        id: DRAW_FILL_LAYER_ID,
        type: 'fill',
        source: DRAW_SOURCE_ID,
        paint: {
          'fill-color': 'rgba(0, 120, 255, 0.1)',
        },
      });
    }

    // Add line layer
    if (!this._map.getLayer(DRAW_LINE_LAYER_ID)) {
      this._map.addLayer({
        id: DRAW_LINE_LAYER_ID,
        type: 'line',
        source: DRAW_SOURCE_ID,
        paint: {
          'line-color': 'rgba(0, 120, 255, 0.8)',
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      });
    }
  }

  private _removeDrawLayers(): void {
    if (!this._map) return;

    if (this._map.getLayer(DRAW_LINE_LAYER_ID)) {
      this._map.removeLayer(DRAW_LINE_LAYER_ID);
    }
    if (this._map.getLayer(DRAW_FILL_LAYER_ID)) {
      this._map.removeLayer(DRAW_FILL_LAYER_ID);
    }
    if (this._map.getSource(DRAW_SOURCE_ID)) {
      this._map.removeSource(DRAW_SOURCE_ID);
    }
  }

  private _updateDrawLayer(bbox: [number, number, number, number] | null): void {
    if (!this._map) return;

    const source = this._map.getSource(DRAW_SOURCE_ID) as GeoJSONSource;
    if (!source) return;

    if (!bbox) {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const [west, south, east, north] = bbox;
    source.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        },
      ],
    });
  }

  // ==================== Public API ====================

  /**
   * Returns whether the control is fully initialized and ready.
   */
  isReady(): boolean {
    return this._initialized && this._lidarControl !== undefined;
  }

  /**
   * Gets the current control state.
   */
  getState(): NoaaLidarState {
    return {
      ...this._state,
      selectedItems: new Set(this._state.selectedItems),
      loadedItems: new Map(this._state.loadedItems),
    };
  }

  /**
   * Updates the control state.
   *
   * @param newState - Partial state to merge
   */
  setState(newState: Partial<NoaaLidarState>): void {
    this._state = { ...this._state, ...newState };
    this._panelBuilder?.updateState(this._state);
    this._emit('statechange');
  }

  /**
   * Toggles the panel open/closed.
   */
  toggle(): void {
    this._state.collapsed = !this._state.collapsed;
    if (this._panel) {
      if (this._state.collapsed) {
        this._panel.classList.remove('expanded');
        this._emit('collapse');
      } else {
        this._panel.classList.add('expanded');
        this._updatePanelPosition();
        this._emit('expand');
      }
    }
    this._emit('statechange');
  }

  /**
   * Expands the panel.
   */
  expand(): void {
    if (this._state.collapsed) this.toggle();
  }

  /**
   * Collapses the panel.
   */
  collapse(): void {
    if (!this._state.collapsed) this.toggle();
  }

  /**
   * Registers an event handler.
   *
   * @param event - Event type
   * @param handler - Handler function
   */
  on(event: NoaaLidarControlEvent, handler: NoaaLidarEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - Event type
   * @param handler - Handler function
   */
  off(event: NoaaLidarControlEvent, handler: NoaaLidarEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Gets the MapLibre GL map instance.
   */
  getMap(): MapLibreMap | undefined {
    return this._map;
  }

  /**
   * Gets the internal LidarControl instance.
   */
  getLidarControl(): LidarControl | undefined {
    return this._lidarControl;
  }

  /**
   * Gets the FootprintLayer instance.
   */
  getFootprintLayer(): FootprintLayer | undefined {
    return this._footprintLayer;
  }

  // ==================== Search API ====================

  /**
   * Searches by the current map extent.
   *
   * @returns Promise resolving to search results
   */
  async searchByExtent(): Promise<UnifiedSearchItem[]> {
    if (!this._map) throw new Error('Control not added to map');

    const bounds = this._map.getBounds();
    const bbox: [number, number, number, number] = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];

    return this.searchByBbox(bbox);
  }

  /**
   * Searches by a bounding box.
   *
   * @param bbox - Bounding box [west, south, east, north]
   * @returns Promise resolving to search results
   */
  async searchByBbox(bbox: [number, number, number, number]): Promise<UnifiedSearchItem[]> {
    // Wait for initialization if not ready (footprint layer needs to be created)
    if (!this._initialized) {
      await this._waitForInit();
    }

    this.setState({
      isSearching: true,
      searchError: null,
      searchResults: [],
      selectedItems: new Set(),
    });
    this._emit('searchstart');

    try {
      // Search NOAA STAC catalog
      const response = await this._stacSearcher.searchByExtent(bbox, this._options.maxResults);
      const items = response.features.map(stacToUnified);
      const totalMatched = response.numberMatched ?? response.context?.matched ?? items.length;

      this.setState({
        isSearching: false,
        searchResults: items,
        totalMatched,
      });

      // Show footprints on map
      if (this._options.showFootprints && this._footprintLayer) {
        this._footprintLayer.setItems(items);
        if (this._options.autoZoomToResults && items.length > 0) {
          this._footprintLayer.zoomToFootprints();
        }
      }

      this._emitWithData('searchcomplete', { items });
      return items;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setState({
        isSearching: false,
        searchError: err.message,
      });
      this._emitWithData('searcherror', { error: err });
      throw err;
    }
  }

  /**
   * Starts bbox drawing mode.
   */
  startDrawing(): void {
    if (!this._map) return;

    // Ensure draw layers are initialized
    if (!this._map.getSource(DRAW_SOURCE_ID)) {
      this._initDrawLayers();
    }

    this.setState({ searchMode: 'draw', isDrawing: true });
    this._emit('drawstart');

    // Clear previous drawn bbox
    this.clearDrawnBbox();

    // Disable map interactions during drawing
    this._map.dragPan.disable();
    this._map.doubleClickZoom.disable();
    this._map.getCanvas().style.cursor = 'crosshair';

    this._boundMouseDown = (e: MapMouseEvent) => {
      e.preventDefault();
      this._drawStartPoint = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    };

    this._boundMouseMove = (e: MapMouseEvent) => {
      if (!this._drawStartPoint) return;

      const west = Math.min(this._drawStartPoint.lng, e.lngLat.lng);
      const east = Math.max(this._drawStartPoint.lng, e.lngLat.lng);
      const south = Math.min(this._drawStartPoint.lat, e.lngLat.lat);
      const north = Math.max(this._drawStartPoint.lat, e.lngLat.lat);

      this._updateDrawLayer([west, south, east, north]);
    };

    this._boundMouseUp = (e: MapMouseEvent) => {
      if (this._drawStartPoint) {
        const west = Math.min(this._drawStartPoint.lng, e.lngLat.lng);
        const east = Math.max(this._drawStartPoint.lng, e.lngLat.lng);
        const south = Math.min(this._drawStartPoint.lat, e.lngLat.lat);
        const north = Math.max(this._drawStartPoint.lat, e.lngLat.lat);

        // Only create bbox if user actually dragged (not just clicked)
        const minDrag = 0.0001; // Small threshold to detect actual drag
        if (Math.abs(east - west) > minDrag || Math.abs(north - south) > minDrag) {
          const bbox: [number, number, number, number] = [west, south, east, north];
          this.setState({ drawnBbox: bbox, isDrawing: false });
          this._updateDrawLayer(bbox);
          this._emit('drawend');
        }
      }
      this._drawStartPoint = null;
      this.stopDrawing();
    };

    this._map.on('mousedown', this._boundMouseDown);
    this._map.on('mousemove', this._boundMouseMove);
    this._map.on('mouseup', this._boundMouseUp);
  }

  /**
   * Stops bbox drawing mode.
   */
  stopDrawing(): void {
    if (!this._map) return;

    // Re-enable map interactions
    this._map.dragPan.enable();
    this._map.doubleClickZoom.enable();
    this._map.getCanvas().style.cursor = '';

    if (this._boundMouseDown) {
      this._map.off('mousedown', this._boundMouseDown);
      this._boundMouseDown = undefined;
    }
    if (this._boundMouseMove) {
      this._map.off('mousemove', this._boundMouseMove);
      this._boundMouseMove = undefined;
    }
    if (this._boundMouseUp) {
      this._map.off('mouseup', this._boundMouseUp);
      this._boundMouseUp = undefined;
    }

    this._drawStartPoint = null;
    this.setState({ searchMode: 'none', isDrawing: false });
  }

  /**
   * Clears the drawn bbox.
   */
  clearDrawnBbox(): void {
    this.setState({ drawnBbox: null });
    this._updateDrawLayer(null);
  }

  // ==================== Selection API ====================

  /**
   * Selects an item for visualization.
   *
   * @param item - The unified search item to select
   */
  selectItem(item: UnifiedSearchItem): void {
    const newSelected = new Set(this._state.selectedItems);
    newSelected.add(item.id);
    this.setState({ selectedItems: newSelected });
    this._footprintLayer?.setSelectedIds(newSelected);
    this._emit('itemselect');
  }

  /**
   * Deselects an item.
   *
   * @param item - The unified search item to deselect
   */
  deselectItem(item: UnifiedSearchItem): void {
    const newSelected = new Set(this._state.selectedItems);
    newSelected.delete(item.id);
    this.setState({ selectedItems: newSelected });
    this._footprintLayer?.setSelectedIds(newSelected);
    this._emit('itemdeselect');
  }

  /**
   * Toggles item selection.
   *
   * @param item - The unified search item to toggle
   */
  toggleItemSelection(item: UnifiedSearchItem): void {
    if (this._state.selectedItems.has(item.id)) {
      this.deselectItem(item);
    } else {
      this.selectItem(item);
    }
  }

  /**
   * Clears all selections.
   */
  clearSelection(): void {
    this.setState({ selectedItems: new Set() });
    this._footprintLayer?.setSelectedIds(new Set());
  }

  // ==================== Loading API ====================

  /**
   * Loads a unified search item's point cloud data for visualization.
   *
   * @param item - Unified search item to load
   */
  async loadItem(item: UnifiedSearchItem): Promise<void> {
    // Wait for initialization if not ready
    if (!this._initialized) {
      await this._waitForInit();
    }

    if (!this._lidarControl) {
      throw new Error('LiDAR control not available');
    }

    this._emit('loadstart');

    // Set cursor to waiting
    if (this._map) {
      this._map.getCanvas().style.cursor = 'wait';
    }

    try {
      // Get EPT URL from STAC item
      const url = await this._stacSearcher.getEptUrl(item.originalItem as StacItem);

      // Track URL to item ID mapping
      this._urlToItemId.set(url, item.id);

      const pointCloudInfo = await this._lidarControl.loadPointCloud(url);

      // Create LoadedItemInfo with the item name
      const info: LoadedItemInfo = {
        ...pointCloudInfo,
        name: getItemShortName(item.id),
      };

      const loadedItems = new Map(this._state.loadedItems);
      loadedItems.set(item.id, info);
      this.setState({ loadedItems });

      // Show visualization section
      if (this._panelBuilder) {
        this._panelBuilder.showVisualizationSection(true);
      }

      this._emitWithData('loadcomplete', { pointCloud: info });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._emitWithData('loaderror', { error: err });
      throw err;
    } finally {
      // Reset cursor
      if (this._map) {
        this._map.getCanvas().style.cursor = '';
      }
    }
  }

  /**
   * Wait for the control to be initialized.
   */
  private _waitForInit(): Promise<void> {
    return new Promise((resolve) => {
      if (this._initialized) {
        resolve();
        return;
      }

      // Try to initialize now if map is ready
      if (this._map && this._map.isStyleLoaded() && !this._initialized) {
        this._initComponents();
        if (this._initialized) {
          resolve();
          return;
        }
      }

      let attempts = 0;
      const maxAttempts = 100; // ~1.6 seconds at 60fps

      const checkInit = () => {
        if (this._initialized) {
          resolve();
          return;
        }

        attempts++;

        // Try to force initialization if map appears ready
        if (this._map && this._map.isStyleLoaded() && !this._initialized) {
          this._initComponents();
          if (this._initialized) {
            resolve();
            return;
          }
        }

        if (attempts < maxAttempts) {
          requestAnimationFrame(checkInit);
        } else {
          // Give up waiting and resolve anyway - search will work but footprints may not show
          console.warn('NoaaLidarControl: Initialization timeout, proceeding without full initialization');
          resolve();
        }
      };
      checkInit();
    });
  }

  /**
   * Loads all selected items.
   */
  async loadSelectedItems(): Promise<void> {
    const selectedItems = this._state.searchResults.filter((item) =>
      this._state.selectedItems.has(item.id)
    );

    for (const item of selectedItems) {
      if (!this._state.loadedItems.has(item.id)) {
        try {
          await this.loadItem(item);
        } catch {
          // Individual load failures are handled by loadItem
        }
      }
    }
  }

  /**
   * Unloads a specific item.
   *
   * @param itemId - The item ID to unload
   */
  unloadItem(itemId: string): void {
    const info = this._state.loadedItems.get(itemId);
    if (info) {
      this._lidarControl?.unloadPointCloud(info.id);
      const loadedItems = new Map(this._state.loadedItems);
      loadedItems.delete(itemId);
      this.setState({ loadedItems });

      // Emit unload event
      this._emitWithData('unload', { itemId });

      // Hide visualization section if no items loaded
      if (loadedItems.size === 0 && this._panelBuilder) {
        this._panelBuilder.showVisualizationSection(false);
      }
    }
  }

  /**
   * Clears all loaded items.
   */
  clearLoadedItems(): void {
    // Emit unload events for each item before clearing
    const itemIds = Array.from(this._state.loadedItems.keys());
    this._lidarControl?.unloadPointCloud();
    this.setState({ loadedItems: new Map() });
    this._urlToItemId.clear();

    // Emit unload event for each removed item
    for (const itemId of itemIds) {
      this._emitWithData('unload', { itemId });
    }

    // Hide visualization section
    if (this._panelBuilder) {
      this._panelBuilder.showVisualizationSection(false);
    }
  }

  /**
   * Clears search results and footprints.
   */
  clearResults(): void {
    this._footprintLayer?.clear();
    this.setState({
      searchResults: [],
      selectedItems: new Set(),
      totalMatched: null,
    });
  }

  // ==================== URL/Download API ====================

  /**
   * Gets URLs for the selected items.
   *
   * @returns Promise resolving to array of URLs
   */
  async getSignedUrls(): Promise<string[]> {
    const selectedItems = this._state.searchResults.filter((item) =>
      this._state.selectedItems.has(item.id)
    );

    const urls: string[] = [];
    for (const item of selectedItems) {
      try {
        const url = await this._stacSearcher.getEptUrl(item.originalItem as StacItem);
        urls.push(url);
      } catch (error) {
        console.error(`Failed to get URL for ${item.id}:`, error);
      }
    }

    return urls;
  }

  /**
   * Copies URLs for selected items to the clipboard.
   */
  async copySignedUrls(): Promise<void> {
    const selectedCount = this._state.selectedItems.size;
    if (selectedCount === 0) {
      console.warn('No items selected to copy URLs');
      return;
    }

    try {
      const urls = await this.getSignedUrls();
      if (urls.length === 0) {
        console.warn('No URLs could be generated');
        return;
      }

      const urlText = urls.join('\n');
      await navigator.clipboard.writeText(urlText);
      console.log(`Copied ${urls.length} URL(s) to clipboard`);

      // Show temporary success feedback
      this._showNotification(`Copied ${urls.length} URL(s) to clipboard`);
    } catch (error) {
      console.error('Failed to copy URLs:', error);
      this._showNotification('Failed to copy URLs', true);
    }
  }

  /**
   * Shows a temporary notification message.
   */
  private _showNotification(message: string, isError: boolean = false): void {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `noaa-lidar-notification${isError ? ' error' : ''}`;
    notification.textContent = message;

    // Add to panel
    if (this._panel) {
      this._panel.appendChild(notification);

      // Remove after 3 seconds
      setTimeout(() => {
        notification.remove();
      }, 3000);
    }
  }

  // ==================== Visualization API ====================

  /**
   * Sets the point size.
   *
   * @param size - Point size in pixels
   */
  setPointSize(size: number): void {
    this._lidarControl?.setPointSize(size);
  }

  /**
   * Sets the point cloud opacity.
   *
   * @param opacity - Opacity value (0-1)
   */
  setOpacity(opacity: number): void {
    this._lidarControl?.setOpacity(opacity);
  }

  /**
   * Sets the color scheme.
   *
   * @param scheme - Color scheme type
   */
  setColorScheme(scheme: ColorScheme): void {
    this._lidarControl?.setColorScheme(scheme);
  }

  /**
   * Sets the Z offset for vertical adjustment.
   * Use negative values to bring point clouds down to ground level.
   *
   * @param offset - Z offset in meters
   */
  setZOffset(offset: number): void {
    this._lidarControl?.setZOffset(offset);
  }

  /**
   * Sets whether points are pickable (enables hover/click interactions).
   *
   * @param pickable - Whether points should be pickable
   */
  setPickable(pickable: boolean): void {
    this._lidarControl?.setPickable(pickable);
  }

  /**
   * Sets the elevation range filter.
   *
   * @param range - Elevation range [min, max] or null to clear
   */
  setElevationRange(range: [number, number] | null): void {
    if (range) {
      this._lidarControl?.setElevationRange(range[0], range[1]);
    } else {
      this._lidarControl?.clearElevationRange();
    }
  }

  /**
   * Sets visibility for a specific classification.
   *
   * @param code - Classification code
   * @param visible - Whether to show the classification
   */
  setClassificationVisibility(code: number, visible: boolean): void {
    this._lidarControl?.setClassificationVisibility(code, visible);
  }

  /**
   * Shows all classifications (makes all visible).
   */
  showAllClassifications(): void {
    this._lidarControl?.showAllClassifications();
  }

  /**
   * Hides all classifications.
   */
  hideAllClassifications(): void {
    this._lidarControl?.hideAllClassifications();
  }

  /**
   * Sets the colormap for elevation/intensity coloring.
   *
   * @param colormap - Colormap name
   */
  setColormap(colormap: ColormapName): void {
    this._lidarControl?.setColormap(colormap);
  }

  /**
   * Gets the current colormap.
   *
   * @returns Current colormap name
   */
  getColormap(): ColormapName | undefined {
    return this._lidarControl?.getColormap();
  }

  /**
   * Sets the color range configuration.
   *
   * @param config - Color range configuration
   */
  setColorRange(config: ColorRangeConfig): void {
    this._lidarControl?.setColorRange(config);
  }

  /**
   * Gets the current color range configuration.
   *
   * @returns Current color range config
   */
  getColorRange(): ColorRangeConfig | undefined {
    return this._lidarControl?.getColorRange();
  }

  // ==================== Metadata API ====================

  /**
   * Shows the metadata panel for a point cloud.
   *
   * @param itemId - Optional item ID. If not provided, uses the active point cloud.
   */
  showMetadata(itemId?: string): void {
    const id = itemId ?? this._getActivePointCloudId();
    if (id && this._lidarControl) {
      this._lidarControl.showMetadataPanel(id);
    }
  }

  /**
   * Hides the metadata panel.
   */
  hideMetadata(): void {
    this._lidarControl?.hideMetadataPanel();
  }

  /**
   * Gets the full metadata for a point cloud.
   *
   * @param itemId - Optional item ID. If not provided, uses the active point cloud.
   * @returns Full metadata or undefined if not available.
   */
  getMetadata(itemId?: string): PointCloudFullMetadata | undefined {
    return this._lidarControl?.getFullMetadata(itemId);
  }

  /**
   * Gets the active point cloud ID from the internal state.
   *
   * @returns Active point cloud ID or null.
   */
  private _getActivePointCloudId(): string | null {
    if (!this._lidarControl) return null;
    const state = this._lidarControl.getState();
    return state.activePointCloudId ?? (state.pointClouds.length > 0 ? state.pointClouds[0].id : null);
  }

  // ==================== Cross-Section API ====================

  /**
   * Enables cross-section drawing mode.
   * Users can click two points on the map to define a cross-section line.
   */
  enableCrossSection(): void {
    this._lidarControl?.enableCrossSection();
  }

  /**
   * Disables cross-section drawing mode.
   */
  disableCrossSection(): void {
    this._lidarControl?.disableCrossSection();
  }

  /**
   * Checks if cross-section drawing mode is enabled.
   *
   * @returns True if cross-section mode is active.
   */
  isCrossSectionEnabled(): boolean {
    return this._lidarControl?.isCrossSectionEnabled() ?? false;
  }

  /**
   * Sets the buffer distance for cross-section extraction.
   *
   * @param meters - Buffer distance in meters.
   */
  setCrossSectionBufferDistance(meters: number): void {
    this._lidarControl?.setCrossSectionBufferDistance(meters);
  }

  /**
   * Gets the current cross-section elevation profile.
   *
   * @returns Elevation profile data or null if no cross-section exists.
   */
  getCrossSectionProfile(): ElevationProfile | null {
    return this._lidarControl?.getCrossSectionProfile() ?? null;
  }

  /**
   * Clears the current cross-section line and profile.
   */
  clearCrossSection(): void {
    this._lidarControl?.clearCrossSection();
  }

  /**
   * Gets the cross-section panel element from the internal LidarControl.
   * This can be used to embed the panel in custom UI.
   *
   * @returns HTMLElement containing the cross-section panel, or null.
   */
  getCrossSectionPanel(): HTMLElement | null {
    if (!this._lidarControl) return null;
    const panel = this._lidarControl.getCrossSectionPanel();
    return panel ? panel.render() : null;
  }

  // ==================== Private Methods ====================

  private _emit(event: NoaaLidarControlEvent): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData: NoaaLidarEventData = { type: event, state: this.getState() };
      handlers.forEach((handler) => handler(eventData));
    }
  }

  private _emitWithData(event: NoaaLidarControlEvent, data: Partial<NoaaLidarEventData>): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData: NoaaLidarEventData = { type: event, state: this.getState(), ...data };
      handlers.forEach((handler) => handler(eventData));
    }
  }

  private _createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group noaa-lidar-control${
      this._options.className ? ` ${this._options.className}` : ''
    }`;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'noaa-lidar-control-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', this._options.title);
    toggleBtn.innerHTML = `
      <span class="noaa-lidar-control-icon">
        <img
          class="noaa-lidar-control-icon-image"
          src="https://cdn-icons-png.flaticon.com/512/2311/2311489.png"
          alt=""
          aria-hidden="true"
        />
      </span>
    `;
    toggleBtn.addEventListener('click', () => this.toggle());

    container.appendChild(toggleBtn);
    return container;
  }

  private _createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'noaa-lidar-control-panel';
    panel.style.width = `${this._options.panelWidth}px`;
    panel.style.maxHeight = `${this._options.maxHeight}px`;

    // Header
    const header = document.createElement('div');
    header.className = 'noaa-lidar-control-header';

    const title = document.createElement('span');
    title.className = 'noaa-lidar-control-title';
    title.textContent = this._options.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'noaa-lidar-control-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.collapse());

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Content via PanelBuilder
    this._panelBuilder = new PanelBuilder(
      {
        onSearchByExtent: () => this.searchByExtent(),
        onStartDrawing: () => this.startDrawing(),
        onStopDrawing: () => this.stopDrawing(),
        onSearchByDrawn: () => {
          if (this._state.drawnBbox) {
            this.searchByBbox(this._state.drawnBbox);
          }
        },
        onClearDrawn: () => this.clearDrawnBbox(),
        onItemSelect: (item) => this.toggleItemSelection(item),
        onItemLoad: (item) => {
          this.loadItem(item).catch(() => {
            // Errors are handled via events
          });
        },
        onLoadSelected: () => {
          this.loadSelectedItems().catch(() => {
            // Errors are handled via events
          });
        },
        onCopySignedUrls: () => {
          this.copySignedUrls().catch((err) => {
            console.error('Failed to copy URLs:', err);
          });
        },
        onDownloadSelected: () => {
          // Download is not applicable for EPT data
          console.warn('EPT data cannot be downloaded directly');
        },
        onClearResults: () => this.clearResults(),
        onUnloadItem: (itemId) => this.unloadItem(itemId),
        onClearLoaded: () => this.clearLoadedItems(),
        onPointSizeChange: (size) => this.setPointSize(size),
        onOpacityChange: (opacity) => this.setOpacity(opacity),
        onColorSchemeChange: (scheme) => this.setColorScheme(scheme as ColorScheme),
        onZOffsetChange: (offset) => this.setZOffset(offset),
        onPickableChange: (pickable) => this.setPickable(pickable),
        onElevationRangeChange: (range) => this.setElevationRange(range),
        onClassificationToggle: (code, visible) => this.setClassificationVisibility(code, visible),
        onClassificationShowAll: () => this.showAllClassifications(),
        onClassificationHideAll: () => this.hideAllClassifications(),
        onColormapChange: (colormap) => this.setColormap(colormap),
        onColorRangeChange: (config) => this.setColorRange(config),
        onShowMetadata: (itemId) => this.showMetadata(itemId),
        onCrossSectionPanel: () => this.getCrossSectionPanel(),
        onRebuildIndex: async (onProgress) => {
          await this._stacSearcher.rebuildIndex(onProgress);
        },
        getIndexInfo: () => this._stacSearcher.getIndexInfo(),
      },
      this._state
    );

    const content = this._panelBuilder.build();

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
  }

  private _setupEventListeners(): void {
    // Click outside to close - but not if clicking in the map
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't close if clicking inside the panel, container, or map canvas
      if (
        this._container?.contains(target) ||
        this._panel?.contains(target) ||
        this._mapContainer?.querySelector('.maplibregl-canvas')?.contains(target)
      ) {
        return;
      }
      // Don't close if clicking inside lidar popups (metadata panel, chart popup)
      const lidarPopup = document.querySelector('.lidar-metadata-backdrop, .lidar-chart-popup-backdrop');
      if (lidarPopup?.contains(target)) {
        return;
      }
      // Also check if the click target itself is part of a lidar popup (by class)
      // This handles cases where the popup closes before we can check containment
      if (target.closest?.('.lidar-metadata-backdrop, .lidar-metadata-panel, .lidar-chart-popup-backdrop, .lidar-chart-popup')) {
        return;
      }
      // Only collapse if panel is expanded and click is truly outside
      if (!this._state.collapsed) {
        this.collapse();
      }
    };

    // Use capture phase to avoid conflicts
    document.addEventListener('click', handleClickOutside, true);

    // Update panel position on resize
    window.addEventListener('resize', () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    });

    this._map?.on('resize', () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    });
  }

  private _getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this._container?.parentElement;
    if (!parent) return 'top-right';

    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';

    return 'top-right';
  }

  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;

    const button = this._container.querySelector('.noaa-lidar-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;

    const panelGap = 5;

    this._panel.style.top = '';
    this._panel.style.bottom = '';
    this._panel.style.left = '';
    this._panel.style.right = '';

    switch (position) {
      case 'top-left':
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case 'top-right':
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
      case 'bottom-left':
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case 'bottom-right':
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }
  }

  getPanelElement(): HTMLElement | null {
    return this._panel ?? null;
  }
}
