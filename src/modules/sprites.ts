import fs from "fs";
import path from "path";
import sharp from "sharp";
import assetConfig from "../services/assetConfig";
const assetPath = assetConfig.getAssetConfig();
const assetData = assetConfig.getAssetData() as any;
import zlib from "zlib";
import crypto from "crypto";

// Generates the sprite frames from the sprite sheet
const sprites = [] as SpriteData[];
export default async function generate(data: SpriteSheetData) {
    if (!assetPath || !fs.existsSync(path.join(assetPath))) {
      throw new Error(`Asset path not found at ${assetPath}`);
    }

    const output = path.join(
      assetPath,
      assetData.sprites.path,
      data.name
    );

    if (!fs.existsSync(output)) {
      fs.mkdirSync(output, { recursive: true });
    } else {
      fs.readdirSync(output).forEach((file) => {
        fs.unlinkSync(path.join(output, file));
      });
    }

    const spriteSheet = sharp(data.data);
    const metadata = await spriteSheet.metadata();
    if (!metadata) {
      return "Sprite metadata not found";
    }

    const { height, width } = metadata;

    const spriteWidth = data.width;
    const spriteHeight = data.height;

    // Check if the sprite is divisible by the sprite width and height
    if (Number(height) % spriteHeight !== 0) {
      throw new Error("Sprite is not divisible by the sprite width and height");
    }

    const columns = Number(width) / spriteWidth;
    const rows = Number(height) / spriteHeight;

    // Create a clone and crop the sprite into individual frames
    let i = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const frame = spriteSheet.clone().extract({
          left: column * spriteWidth,
          top: row * spriteHeight,
          width: spriteWidth,
          height: spriteHeight,
        });

        await frame.toFile(path.resolve(output, `${i}.png`));
        const name = `${data.name}_${i}`;
        // Read the generated PNG file and compress its data
        const fileData = fs.readFileSync(path.resolve(output, `${i}.png`));
        const compressedData = zlib.gzipSync(new Uint8Array(fileData));
        const hash = crypto.createHash("sha256").update(name).digest("hex");
        sprites.push({ name, hash, data: compressedData });
        i++;
      }
    }
    return sprites;
}
