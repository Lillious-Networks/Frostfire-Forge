import path from "path";
import fs from "fs";
class AssetConfigService {
  getAssetConfig() {
    const assetPath = path.join(import.meta.dir, "..", "assets");
    return fs.existsSync(assetPath) ? assetPath : null;
  }

  getAssetData() {
    const assetConfigPath = path.join(import.meta.dir, "..", "config", "assets.json");
    return fs.existsSync(assetConfigPath) ? JSON.parse(fs.readFileSync(assetConfigPath, "utf-8")) : null;
  }
}

const assetConfig: AssetConfigService = new AssetConfigService();

export default assetConfig;