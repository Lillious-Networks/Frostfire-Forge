import fs from "fs";
import path from "path";
import crypto from "crypto";
import assetConfig from "../services/assetConfig";

/**
 * Calculate SHA256 checksum of a file (normalized JSON)
 */
export function calculateFileChecksum(filePath: string): string {
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    // Parse and re-stringify with consistent formatting for deterministic checksums
    const jsonData = JSON.parse(fileContent);
    const normalizedContent = JSON.stringify(jsonData);
    return crypto.createHash("sha256").update(normalizedContent).digest("hex");
  } catch (error) {
    console.error(`Failed to calculate checksum for ${filePath}:`, error);
    return "";
  }
}

/**
 * Calculate checksums for all map files
 */
export function calculateAllMapChecksums(): Record<string, string> {
  const checksums: Record<string, string> = {};
  const assetPath = assetConfig.getAssetConfig() as string;
  const assetData = assetConfig.getAssetData() as any;
  const mapDir = path.join(assetPath, assetData.maps.path);

  if (!fs.existsSync(mapDir)) {
    console.warn(`Map directory not found at ${mapDir}`);
    return checksums;
  }

  const mapFiles = fs.readdirSync(mapDir).filter((f) => f.endsWith(".json"));

  mapFiles.forEach((file) => {
    const filePath = path.join(mapDir, file);
    checksums[file] = calculateFileChecksum(filePath);
  });

  return checksums;
}

/**
 * Get a specific map file content
 */
export function getMapContent(mapName: string): any | null {
  try {
    const assetPath = assetConfig.getAssetConfig() as string;
    const assetData = assetConfig.getAssetData() as any;
    const mapDir = path.join(assetPath, assetData.maps.path);
    const filePath = path.join(mapDir, mapName.endsWith(".json") ? mapName : `${mapName}.json`);

    if (!fs.existsSync(filePath)) {
      console.warn(`Map file not found: ${filePath}`);
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.error(`Failed to read map ${mapName}:`, error);
    return null;
  }
}

/**
 * Write updated map content to file
 */
export function writeMapContent(mapName: string, mapData: any): boolean {
  try {
    const assetPath = assetConfig.getAssetConfig() as string;
    const assetData = assetConfig.getAssetData() as any;
    const mapDir = path.join(assetPath, assetData.maps.path);
    const filePath = path.join(mapDir, mapName.endsWith(".json") ? mapName : `${mapName}.json`);

    fs.writeFileSync(filePath, JSON.stringify(mapData, null, 2), "utf-8");
    return true;
  } catch (error) {
    console.error(`Failed to write map ${mapName}:`, error);
    return false;
  }
}
