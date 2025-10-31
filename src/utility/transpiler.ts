import path from "path";
import fs from "fs";
import log from "../modules/logger";

const transpiler = new Bun.Transpiler({
    loader: "tsx",
});

function transpileDirectory(sourceDir: string) {
    const scripts = fs.readdirSync(sourceDir).filter((file) => file.endsWith(".ts"));

    for (const script of scripts) {
        const filePath = path.join(sourceDir, script);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const result = transpiler.transformSync(fileContent);

        if (result) {
            const outputFile = path.join(sourceDir, script.replace(".ts", ".js"));
            log.info(`Transpiled ${script} > ${path.basename(outputFile)}`);

            // Token-replace known variables in script
            const envVars = [ // TODO maybe move this to a config ts file or something to make it more visible or something
                { key: "__VAR.WEBSOCKETURL__", value: (process.env.WEB_SOCKET_URL as string), defaultvalue: "ws://localhost:3000" },
            ];
            let replacedResult = result; // copy result to new variable to edit it
            envVars.forEach((env) => replacedResult = replacedResult.replaceAll(env.key, env.value || env.defaultvalue) );

            fs.writeFileSync(outputFile, replacedResult);
        } else {
            console.error(`Failed to transpile ${script}`);
        }
    }
}

// Define directories to transpile
const directories = [
    path.join(import.meta.dir, "..", "webserver", "www", "public", "js", "web"),
];

// Transpile each directory
for (const dir of directories) {
    transpileDirectory(dir);
}
