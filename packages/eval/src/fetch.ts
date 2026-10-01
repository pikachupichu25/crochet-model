// `eval fetch`: download the pinned dataset files and record them in
// data/SOURCES.json with their checksums.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_DIR, dataPath, SOURCES, type SourceName } from "./sources.ts";

export async function fetchDatasets(log: (line: string) => void = console.log) {
  const record: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(SOURCES) as [SourceName, (typeof SOURCES)[SourceName]][]) {
    const files: Record<string, string> = {};
    for (const file of source.files) {
      const path = dataPath(name, file);
      let bytes: Buffer;
      if (existsSync(path)) {
        bytes = readFileSync(path);
        log(`have   ${name}/${file}`);
      } else {
        const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${file}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        log(`fetched ${name}/${file} (${bytes.length} bytes)`);
      }
      files[file] = createHash("sha256").update(bytes).digest("hex");
    }
    record[name] = { ...source, files };
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}SOURCES.json`, `${JSON.stringify(record, null, 2)}\n`);
}
