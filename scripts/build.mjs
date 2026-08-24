import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { writeIcons } from "./gen-icons.mjs";

const outdir = "dist";

await mkdir(`${outdir}/icons`, { recursive: true });

await build({
  entryPoints: {
    content: "src/content/index.ts",
    background: "src/background/index.ts",
    options: "src/options/options.ts",
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
});

await copyFile("src/manifest.json", `${outdir}/manifest.json`);
await copyFile("src/options/options.html", `${outdir}/options.html`);
await writeIcons(`${outdir}/icons`);
