import fs from "fs";
import path from "path";
import crypto from "crypto";
import assetConfig from "../services/assetConfig";

export function calculateFileChecksum(filePath: string): string {
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");

    const jsonData = JSON.parse(fileContent);
    const normalizedContent = JSON.stringify(jsonData);
    return crypto.createHash("sha256").update(normalizedContent).digest("hex");
  } catch (error) {
    console.error(`Failed to calculate checksum for ${filePath}:`, error);
    return "";
  }
}

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

export function writeMapContent(mapName: string, mapData: any): boolean {
  try {
    const assetPath = assetConfig.getAssetConfig() as string;
    const assetData = assetConfig.getAssetData() as any;
    const mapDir = path.join(assetPath, assetData.maps.path);
    const filePath = path.join(mapDir, mapName.endsWith(".json") ? mapName : `${mapName}.json`);

    // Write with normalized JSON format to ensure checksums match after writing
    const normalizedContent = JSON.stringify(mapData);
    fs.writeFileSync(filePath, normalizedContent, "utf-8");
    return true;
  } catch (error) {
    console.error(`Failed to write map ${mapName}:`, error);
    return false;
  }
}
