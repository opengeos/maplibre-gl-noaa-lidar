#!/usr/bin/env node
/**
 * Script to pre-build the NOAA STAC catalog index.
 * Run with: node scripts/build-stac-index.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOAA_STAC_CATALOG =
  'https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/catalog.json';
const EPT_BASE_URL = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18';
const OUTPUT_FILE = path.join(__dirname, '../src/data/stac-index.json');

async function buildIndex() {
  console.log('Fetching NOAA STAC catalog...');

  const catalogResponse = await fetch(NOAA_STAC_CATALOG);
  if (!catalogResponse.ok) {
    throw new Error(`Failed to fetch catalog: ${catalogResponse.status}`);
  }

  const catalog = await catalogResponse.json();
  const itemLinks = catalog.links.filter(
    (link) => link.rel === 'item' || link.rel === 'child'
  );

  console.log(`Found ${itemLinks.length} items to fetch...`);

  const items = [];
  const batchSize = 50;
  let processed = 0;

  for (let i = 0; i < itemLinks.length; i += batchSize) {
    const batch = itemLinks.slice(i, i + batchSize);
    const batchPromises = batch.map(async (link) => {
      try {
        const itemUrl = new URL(link.href, NOAA_STAC_CATALOG).href;
        const response = await fetch(itemUrl);
        if (!response.ok) {
          console.warn(`Failed to fetch: ${itemUrl}`);
          return null;
        }

        const item = await response.json();
        const missionMatch = item.id.match(/(\d+)$/);
        const missionId = missionMatch ? missionMatch[1] : item.id;
        const eptUrl = `${EPT_BASE_URL}/${missionId}/ept.json`;

        const bbox = item.bbox.length === 6
          ? [item.bbox[0], item.bbox[1], item.bbox[3], item.bbox[4]]
          : item.bbox;

        return {
          id: item.id,
          title: item.properties?.title || item.id,
          bbox,
          eptUrl,
          pointCount: item.properties?.['pc:count'] || item.properties?.['pointcloud:count'],
        };
      } catch (error) {
        console.warn(`Error processing ${link.href}:`, error.message);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    items.push(...batchResults.filter((item) => item !== null));

    processed += batch.length;
    console.log(`Progress: ${processed}/${itemLinks.length} (${Math.round(processed/itemLinks.length*100)}%)`);
  }

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Save index with metadata
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index));
  console.log(`\nIndex saved to ${OUTPUT_FILE}`);
  console.log(`Total items: ${items.length}`);
}

buildIndex().catch((error) => {
  console.error('Failed to build index:', error);
  process.exit(1);
});
