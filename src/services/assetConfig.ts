import path from "path";
import fs from "fs";
class AssetConfigService {
  getAssetConfig() {
    const assetPath = path.join("src", "assets");
    return fs.existsSync(assetPath) ? assetPath : null;
  }

  getAssetData() {
    const assetConfigPath = path.join("src", "config", "assets.json");
    return fs.existsSync(assetConfigPath) ? JSON.parse(fs.readFileSync(assetConfigPath, "utf-8")) : null;
  }
}

const assetConfig: AssetConfigService = new AssetConfigService();

export default assetConfig;