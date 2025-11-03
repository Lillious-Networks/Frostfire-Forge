import path from "path";
import fs from "fs";
const pwd = process.cwd();
class AssetConfigService {
  getAssetConfig() {
    const assetPath = path.join(pwd, "src", "assets");
    return fs.existsSync(assetPath) ? assetPath : null;
  }

  getAssetData() {
    const assetConfigPath = path.join(pwd,  "src", "config", "assets.json");
    return fs.existsSync(assetConfigPath) ? JSON.parse(fs.readFileSync(assetConfigPath, "utf-8")) : null;
  }
}

const assetConfig: AssetConfigService = new AssetConfigService();

export default assetConfig;