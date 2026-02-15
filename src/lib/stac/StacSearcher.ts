import type { StacSearchResponse, StacItem, CacheEntry } from '../core/types';
import prebuiltIndex from '../../data/stac-index.json';

const NOAA_STAC_CATALOG =
  'https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/catalog.json';
const EPT_BASE_URL = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18';
const CACHE_KEY = 'noaa-lidar-stac-items';
const DEFAULT_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * NOAA STAC Catalog link structure.
 */
interface CatalogLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

/**
 * NOAA STAC Catalog structure.
 */
interface StacCatalog {
  type: string;
  id: string;
  stac_version: string;
  description: string;
  links: CatalogLink[];
}

/**
 * Cached item index entry.
 */
interface CachedItem {
  id: string;
  title?: string;
  bbox: [number, number, number, number];
  eptUrl: string;
  pointCount?: number;
}

/**
 * Pre-built index structure.
 */
interface PrebuiltIndex {
  version: number;
  generatedAt: string;
  itemCount: number;
  items: CachedItem[];
}

/**
 * Progress callback for rebuild operation.
 */
export type RebuildProgressCallback = (progress: number, total: number) => void;

/**
 * Client for searching NOAA Coastal LiDAR EPT data from AWS Open Data.
 *
 * Uses a pre-built index for instant searches. The index can be rebuilt
 * to fetch the latest data from the NOAA STAC catalog.
 *
 * @example
 * ```typescript
 * const searcher = new StacSearcher();
 * const results = await searcher.searchByExtent(
 *   [-80.0, 32.0, -79.0, 33.0],
 *   25
 * );
 * ```
 */
export class StacSearcher {
  private _catalogUrl: string;
  private _eptBaseUrl: string;
  private _cacheDuration: number;
  private _items: CachedItem[] | null = null;

  /**
   * Creates a new StacSearcher instance.
   *
   * @param catalogUrl - URL to the NOAA STAC catalog.json
   * @param eptBaseUrl - Base URL for EPT data
   * @param cacheDuration - Cache duration in milliseconds
   */
  constructor(
    catalogUrl: string = NOAA_STAC_CATALOG,
    eptBaseUrl: string = EPT_BASE_URL,
    cacheDuration: number = DEFAULT_CACHE_DURATION
  ) {
    this._catalogUrl = catalogUrl;
    this._eptBaseUrl = eptBaseUrl;
    this._cacheDuration = cacheDuration;
  }

  /**
   * Gets the STAC catalog URL.
   */
  get baseUrl(): string {
    return this._catalogUrl;
  }

  /**
   * Gets the EPT base URL.
   */
  get eptBaseUrl(): string {
    return this._eptBaseUrl;
  }

  /**
   * Validates and clamps a bounding box to valid geographic coordinates.
   */
  private _validateBbox(
    bbox: [number, number, number, number]
  ): [number, number, number, number] {
    const safeValue = (val: number, defaultVal: number, min: number, max: number): number => {
      if (!Number.isFinite(val)) {
        return defaultVal;
      }
      return Math.max(min, Math.min(max, val));
    };

    return [
      safeValue(bbox[0], -180, -180, 180), // west
      safeValue(bbox[1], -90, -90, 90), // south
      safeValue(bbox[2], 180, -180, 180), // east
      safeValue(bbox[3], 90, -90, 90), // north
    ];
  }

  /**
   * Loads items from the pre-built index or localStorage cache.
   */
  private _loadItems(): CachedItem[] {
    // Check localStorage cache first (for rebuilt index)
    const cached = this._getFromCache();
    if (cached) {
      return cached;
    }

    // Use pre-built index
    const index = prebuiltIndex as PrebuiltIndex;
    return index.items;
  }

  /**
   * Fetches fresh data from the NOAA STAC catalog.
   * This is a slow operation that fetches all items (1000+).
   *
   * @param onProgress - Optional progress callback
   * @returns Promise resolving to fresh items
   */
  async rebuildIndex(onProgress?: RebuildProgressCallback): Promise<CachedItem[]> {
    // Fetch catalog.json
    const catalogResponse = await fetch(this._catalogUrl);
    if (!catalogResponse.ok) {
      throw new Error(`Failed to fetch NOAA STAC catalog: ${catalogResponse.status} ${catalogResponse.statusText}`);
    }

    const catalog: StacCatalog = await catalogResponse.json();

    // Get all item links
    const itemLinks = catalog.links.filter(
      (link) => link.rel === 'item' || link.rel === 'child'
    );

    const total = itemLinks.length;

    // Fetch items in batches
    const items: CachedItem[] = [];
    const batchSize = 50;

    for (let i = 0; i < itemLinks.length; i += batchSize) {
      const batch = itemLinks.slice(i, i + batchSize);
      const batchPromises = batch.map(async (link) => {
        try {
          const itemUrl = new URL(link.href, this._catalogUrl).href;
          const response = await fetch(itemUrl);
          if (!response.ok) {
            console.warn(`Failed to fetch item: ${itemUrl}`);
            return null;
          }

          const item: StacItem = await response.json();

          // Extract mission ID
          const missionMatch = item.id.match(/(\d+)$/);
          const missionId = missionMatch ? missionMatch[1] : item.id;

          // Build EPT URL
          const eptUrl = `${this._eptBaseUrl}/${missionId}/ept.json`;

          // Get bbox
          const bbox: [number, number, number, number] =
            item.bbox.length === 6
              ? [item.bbox[0], item.bbox[1], item.bbox[3], item.bbox[4]]
              : (item.bbox as [number, number, number, number]);

          return {
            id: item.id,
            title: item.properties?.title || item.id,
            bbox,
            eptUrl,
            pointCount: item.properties?.['pc:count'] || item.properties?.['pointcloud:count'],
          };
        } catch (error) {
          console.warn(`Error processing item ${link.href}:`, error);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      items.push(...(batchResults.filter((item) => item !== null) as CachedItem[]));

      // Report progress
      if (onProgress) {
        onProgress(Math.min(i + batchSize, total), total);
      }
    }

    // Cache the result
    this._saveToCache(items);
    this._items = items;

    return items;
  }

  /**
   * Gets cached items from localStorage.
   */
  private _getFromCache(): CachedItem[] | null {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;

      const entry: CacheEntry<CachedItem[]> = JSON.parse(cached);
      if (Date.now() > entry.expiresAt) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }

      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Saves items to localStorage cache.
   */
  private _saveToCache(items: CachedItem[]): void {
    try {
      const entry: CacheEntry<CachedItem[]> = {
        data: items,
        timestamp: Date.now(),
        expiresAt: Date.now() + this._cacheDuration,
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    } catch (error) {
      console.warn('Failed to cache NOAA STAC items:', error);
    }
  }

  /**
   * Clears the cached items (localStorage cache only, not pre-built index).
   */
  clearCache(): void {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Ignore localStorage errors
    }
    this._items = null;
  }

  /**
   * Ensures items are loaded.
   */
  private _ensureLoaded(): CachedItem[] {
    if (this._items) {
      return this._items;
    }

    this._items = this._loadItems();
    return this._items;
  }

  /**
   * Searches by bounding box.
   *
   * @param bbox - Bounding box [west, south, east, north]
   * @param limit - Maximum results (default: 50)
   * @returns Promise resolving to search results
   */
  async searchByExtent(
    bbox: [number, number, number, number],
    limit: number = 50
  ): Promise<StacSearchResponse> {
    const items = this._ensureLoaded();

    // Validate bbox
    const [west, south, east, north] = this._validateBbox(bbox);

    // Filter items that intersect with bbox
    const matching = items.filter((item) => {
      const [iWest, iSouth, iEast, iNorth] = item.bbox;
      // Check for bbox intersection
      return !(iEast < west || iWest > east || iNorth < south || iSouth > north);
    });

    // Sort by point count (descending) and limit
    const sorted = matching
      .sort((a, b) => (b.pointCount ?? 0) - (a.pointCount ?? 0))
      .slice(0, limit);

    // Convert to StacItem format for compatibility
    const features: StacItem[] = sorted.map((item) => ({
      id: item.id,
      type: 'Feature',
      stac_version: '1.0.0',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [item.bbox[0], item.bbox[1]],
          [item.bbox[2], item.bbox[1]],
          [item.bbox[2], item.bbox[3]],
          [item.bbox[0], item.bbox[3]],
          [item.bbox[0], item.bbox[1]],
        ]],
      },
      bbox: item.bbox,
      properties: {
        datetime: null,
        title: item.title,
        'pc:count': item.pointCount,
      },
      links: [],
      assets: {
        data: {
          href: item.eptUrl,
          type: 'application/json',
          title: 'EPT Index',
        },
      },
      collection: 'noaa-coastal-lidar',
    }));

    return {
      type: 'FeatureCollection',
      features,
      numberMatched: matching.length,
      numberReturned: features.length,
    };
  }

  /**
   * Gets the EPT URL for a STAC item.
   *
   * @param item - STAC item
   * @returns EPT URL
   */
  async getEptUrl(item: StacItem): Promise<string> {
    const asset = item.assets.data;
    if (!asset) {
      throw new Error(`No data asset found for item ${item.id}`);
    }
    return asset.href;
  }

  /**
   * Alias for getEptUrl for backward compatibility.
   * @deprecated Use getEptUrl instead
   */
  async getCopcUrl(item: StacItem): Promise<string> {
    return this.getEptUrl(item);
  }

  /**
   * Gets all available items.
   */
  async getAllItems(): Promise<CachedItem[]> {
    return this._ensureLoaded();
  }

  /**
   * Gets the total count of items.
   */
  async getCount(): Promise<number> {
    return this._ensureLoaded().length;
  }

  /**
   * Gets information about the current index.
   */
  getIndexInfo(): { source: 'prebuilt' | 'cached'; itemCount: number; generatedAt?: string } {
    const cached = this._getFromCache();
    if (cached) {
      return {
        source: 'cached',
        itemCount: cached.length,
      };
    }

    const index = prebuiltIndex as PrebuiltIndex;
    return {
      source: 'prebuilt',
      itemCount: index.itemCount,
      generatedAt: index.generatedAt,
    };
  }
}
