// Zip dist/ into artifacts/chat-freept.zip. Uses `zip` where present (CI ubuntu),
// PowerShell Compress-Archive on Windows dev machines.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

if (!existsSync("dist/manifest.json")) {
  console.error("dist/ is missing or incomplete — run `npm run build` first.");
  process.exit(1);
}

await mkdir("artifacts", { recursive: true });
const target = resolve("artifacts/chat-freept.zip");
await rm(target, { force: true });

function has(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (has("zip")) {
  execFileSync("zip", ["-r", target, "."], { cwd: resolve("dist"), stdio: "inherit" });
} else {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Compress-Archive -Path dist/* -DestinationPath '${target}' -Force`],
    { stdio: "inherit" },
  );
}
console.info(`packaged ${target}`);
