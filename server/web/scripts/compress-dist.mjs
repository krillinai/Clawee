import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const distDir = fileURLToPath(new URL("../../internal/server/webdist/dist/", import.meta.url));
const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".svg"]);
const minimumSize = 1024;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return files.flat();
}

const files = await listFiles(distDir);
let generated = 0;

for (const file of files) {
  if (!compressibleExtensions.has(path.extname(file))) continue;
  if ((await stat(file)).size < minimumSize) continue;

  const source = await readFile(file);
  const compressed = await gzipAsync(source, { level: 9 });
  if (compressed.length >= source.length) continue;

  await writeFile(`${file}.gz`, compressed);
  generated++;
}

console.log(`Generated ${generated} gzip assets.`);
