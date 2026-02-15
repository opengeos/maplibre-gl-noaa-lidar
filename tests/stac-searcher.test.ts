import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StacSearcher } from '../src/lib/stac/StacSearcher';

// Mock localStorage
const localStorageMock = (() => {
  let store: { [key: string]: string } = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

describe('StacSearcher', () => {
  let searcher: StacSearcher;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    searcher = new StacSearcher();
    fetchSpy = vi.spyOn(global, 'fetch');
    localStorageMock.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default NOAA STAC catalog URL', () => {
      expect(searcher.baseUrl).toBe(
        'https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/catalog.json'
      );
    });

    it('should use default EPT base URL', () => {
      expect(searcher.eptBaseUrl).toBe(
        'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18'
      );
    });

    it('should accept custom URLs', () => {
      const customSearcher = new StacSearcher(
        'https://custom.catalog.json',
        'https://custom.ept',
        86400000
      );
      expect(customSearcher.baseUrl).toBe('https://custom.catalog.json');
      expect(customSearcher.eptBaseUrl).toBe('https://custom.ept');
    });
  });

  describe('searchByExtent', () => {
    it('should use pre-built index and return matching items', async () => {
      // No fetch calls needed - uses pre-built index
      const result = await searcher.searchByExtent([-80.5, 32.5, -79.5, 33], 10);

      expect(result.type).toBe('FeatureCollection');
      expect(result.features.length).toBeGreaterThan(0);
      // Should not have made any fetch calls (using pre-built index)
      expect(fetchSpy.mock.calls.length).toBe(0);
    });

    it('should return results within the requested limit', async () => {
      const result = await searcher.searchByExtent([-85, 25, -75, 35], 5);

      expect(result.type).toBe('FeatureCollection');
      expect(result.features.length).toBeLessThanOrEqual(5);
    });

    it('should return empty results for non-matching bbox', async () => {
      // Search for area with no NOAA coastal data (central Asia)
      const result = await searcher.searchByExtent([70, 40, 75, 45], 10);

      expect(result.type).toBe('FeatureCollection');
      expect(result.features.length).toBe(0);
    });

    it('should include EPT URL in asset data', async () => {
      const result = await searcher.searchByExtent([-80.5, 32.5, -79.5, 33], 1);

      expect(result.features.length).toBeGreaterThan(0);
      const feature = result.features[0];
      expect(feature.assets.data).toBeDefined();
      expect(feature.assets.data?.href).toContain('ept.json');
    });

    it('should report numberMatched and numberReturned', async () => {
      const result = await searcher.searchByExtent([-85, 25, -75, 35], 5);

      expect(result.numberMatched).toBeGreaterThanOrEqual(result.numberReturned!);
      expect(result.numberReturned).toBeLessThanOrEqual(5);
    });
  });

  describe('getEptUrl', () => {
    it('should return the EPT URL from item assets', async () => {
      const item = {
        id: 'DigitalCoast_mission_13754',
        assets: {
          data: {
            href: 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/13754/ept.json',
          },
        },
      };

      const url = await searcher.getEptUrl(item as any);
      expect(url).toBe(
        'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/13754/ept.json'
      );
    });

    it('should throw error when no data asset exists', async () => {
      const item = {
        id: 'test-item',
        assets: {},
      };

      await expect(searcher.getEptUrl(item as any)).rejects.toThrow(
        'No data asset found for item test-item'
      );
    });
  });

  describe('getIndexInfo', () => {
    it('should return info about the pre-built index', () => {
      const info = searcher.getIndexInfo();

      expect(info.source).toBe('prebuilt');
      expect(info.itemCount).toBeGreaterThan(0);
      expect(info.generatedAt).toBeDefined();
    });
  });

  describe('clearCache', () => {
    it('should clear localStorage cache', () => {
      // Simulate cached data
      localStorageMock.setItem('noaa-lidar-stac-items', JSON.stringify({
        data: [],
        timestamp: Date.now(),
        expiresAt: Date.now() + 86400000,
      }));

      searcher.clearCache();

      expect(localStorageMock.getItem('noaa-lidar-stac-items')).toBeNull();
    });
  });

  describe('rebuildIndex', () => {
    const mockCatalog = {
      type: 'Catalog',
      id: 'noaa-coastal-lidar',
      stac_version: '1.0.0',
      description: 'NOAA Coastal LiDAR',
      links: [
        { rel: 'item', href: './DigitalCoast_mission_13754.json' },
      ],
    };

    const mockItem13754 = {
      id: 'DigitalCoast_mission_13754',
      type: 'Feature',
      stac_version: '1.0.0',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-80, 32], [-79, 32], [-79, 33], [-80, 33], [-80, 32]]],
      },
      bbox: [-80, 32, -79, 33],
      properties: {
        datetime: '2020-01-01T00:00:00Z',
        title: 'South Carolina Coast',
        'pc:count': 1000000,
      },
      links: [],
      assets: {
        data: {
          href: 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/13754/ept.json',
        },
      },
    };

    it('should fetch fresh data from NOAA catalog', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem13754),
      } as Response);

      const progressCalls: [number, number][] = [];
      const items = await searcher.rebuildIndex((progress, total) => {
        progressCalls.push([progress, total]);
      });

      expect(items.length).toBe(1);
      expect(items[0].id).toBe('DigitalCoast_mission_13754');
      expect(fetchSpy.mock.calls.length).toBe(2); // catalog + 1 item
      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it('should throw error on catalog fetch failure', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(searcher.rebuildIndex()).rejects.toThrow(
        'Failed to fetch NOAA STAC catalog'
      );
    });

    it('should save rebuilt index to localStorage cache', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem13754),
      } as Response);

      await searcher.rebuildIndex();

      const cached = localStorageMock.getItem('noaa-lidar-stac-items');
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.data.length).toBe(1);
    });
  });
});
