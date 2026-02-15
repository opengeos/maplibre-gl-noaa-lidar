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
    const mockCatalog = {
      type: 'Catalog',
      id: 'noaa-coastal-lidar',
      stac_version: '1.0.0',
      description: 'NOAA Coastal LiDAR',
      links: [
        { rel: 'item', href: './DigitalCoast_mission_13754.json' },
        { rel: 'item', href: './DigitalCoast_mission_10418.json' },
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

    const mockItem10418 = {
      id: 'DigitalCoast_mission_10418',
      type: 'Feature',
      stac_version: '1.0.0',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-82, 30], [-81, 30], [-81, 31], [-82, 31], [-82, 30]]],
      },
      bbox: [-82, 30, -81, 31],
      properties: {
        datetime: '2019-01-01T00:00:00Z',
        title: 'Florida Coast',
        'pc:count': 500000,
      },
      links: [],
      assets: {
        data: {
          href: 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/10418/ept.json',
        },
      },
    };

    it('should fetch catalog and return matching items', async () => {
      // Mock catalog fetch
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      // Mock item fetches
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem13754),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem10418),
      } as Response);

      // Search for South Carolina coast area
      const result = await searcher.searchByExtent([-80.5, 32, -79, 33], 10);

      expect(result.type).toBe('FeatureCollection');
      expect(result.features.length).toBe(1);
      expect(result.features[0].id).toBe('DigitalCoast_mission_13754');
    });

    it('should use cached data on subsequent searches', async () => {
      // First search - fetches from network
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem13754),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem10418),
      } as Response);

      await searcher.searchByExtent([-80, 32, -79, 33], 10);
      const initialFetchCount = fetchSpy.mock.calls.length;

      // Second search - should use cache
      await searcher.searchByExtent([-82, 30, -81, 31], 10);

      // No additional fetches should have been made
      expect(fetchSpy.mock.calls.length).toBe(initialFetchCount);
    });

    it('should return empty results for non-matching bbox', async () => {
      // Mock catalog fetch
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem13754),
      } as Response);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockItem10418),
      } as Response);

      // Search for area with no data
      const result = await searcher.searchByExtent([-100, 40, -99, 41], 10);

      expect(result.type).toBe('FeatureCollection');
      expect(result.features.length).toBe(0);
    });

    it('should throw error on catalog fetch failure', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(searcher.searchByExtent([-80, 32, -79, 33], 10)).rejects.toThrow(
        'Failed to fetch NOAA STAC catalog'
      );
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

  describe('clearCache', () => {
    it('should clear cached items', async () => {
      const mockCatalog = {
        type: 'Catalog',
        id: 'noaa-coastal-lidar',
        stac_version: '1.0.0',
        description: 'NOAA Coastal LiDAR',
        links: [],
      };

      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      // First search
      await searcher.searchByExtent([-80, 32, -79, 33], 10);
      const fetchCountAfterFirst = fetchSpy.mock.calls.length;

      // Clear cache
      searcher.clearCache();

      // Second search should fetch again
      await searcher.searchByExtent([-80, 32, -79, 33], 10);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetchCountAfterFirst);
    });
  });
});
