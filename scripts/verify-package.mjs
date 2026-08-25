import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const EXPECTED_FILES = [
  "background.js",
  "content.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "manifest.json",
  "options.html",
  "options.js",
].sort();

function portable(path) {
  return path.split(sep).join("/");
}

async function filesUnder(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(root, path)));
    } else if (entry.isFile()) {
      files.push(portable(relative(root, path)));
    }
  }
  return files;
}

function referencedFiles(manifest) {
  const references = [];
  const worker = manifest.background?.service_worker;
  if (typeof worker === "string") references.push(worker);
  if (typeof manifest.options_page === "string") references.push(manifest.options_page);

  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) {
      if (typeof file === "string") references.push(file);
    }
  }
  for (const file of Object.values(manifest.icons ?? {})) {
    if (typeof file === "string") references.push(file);
  }
  return references;
}

function assertFileSet(actual) {
  const missing = EXPECTED_FILES.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !EXPECTED_FILES.includes(file));
  if (missing.length === 0 && unexpected.length === 0) return;

  const details = [];
  if (missing.length) details.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length) details.push(`unexpected: ${unexpected.join(", ")}`);
  throw new Error(`invalid dist file set (${details.join("; ")})`);
}

async function assertNonEmpty(root, files) {
  for (const file of files) {
    const info = await stat(join(root, file));
    if (info.size === 0) throw new Error(`built extension file is empty: ${file}`);
  }
}

export async function verifyDist(root = "dist") {
  let actual;
  try {
    actual = (await filesUnder(root)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${root}/ is missing — run \`npm run build\` first.`);
    }
    throw error;
  }

  assertFileSet(actual);
  await assertNonEmpty(root, actual);

  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (manifest.manifest_version !== 3) {
    throw new Error(`expected Manifest V3, found ${String(manifest.manifest_version)}`);
  }
  if (manifest.version !== pkg.version) {
    throw new Error(`version mismatch: manifest ${manifest.version} != package ${pkg.version}`);
  }

  const available = new Set(actual);
  for (const reference of referencedFiles(manifest)) {
    if (!available.has(reference)) {
      throw new Error(`manifest references missing file: ${reference}`);
    }
  }

  return { files: actual, version: manifest.version };
}
