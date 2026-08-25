// Zip dist/ into artifacts/chat-freept.zip. Uses `zip` where present (CI ubuntu),
// PowerShell Compress-Archive on Windows dev machines.
import { execFileSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyDist } from "./verify-package.mjs";

const verified = await verifyDist("dist");
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

const archive = await stat(target);
if (archive.size === 0) throw new Error("packaged extension archive is empty");
console.info(
  `packaged Chat FreePT ${verified.version}: ${verified.files.length} files -> ${target}`,
);
