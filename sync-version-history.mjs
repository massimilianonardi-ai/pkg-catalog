import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const histories = new Map();
const changes = [];
const full = process.argv.length === 3 && process.argv[2] === "--full";
if (process.argv.length > (full ? 3 : 2)) throw new Error("usage: node sync-version-history.mjs [--full]");

async function history(owner, repository, known, anchor) {
  const identity = owner + "/" + repository;
  const key = identity + ":" + (full ? "full" : "incremental") + ":" + anchor + ":" + known.join(",");
  const stopTag = full ? (known[0] || anchor) : (known[known.length - 1] || anchor);
  if (histories.has(key)) return histories.get(key);
  const releases = [];
  let overlapped = false;
  for (let page = 1; ; ++page) {
    const url = "https://api.github.com/repos/" + encodeURIComponent(owner) +
      "/" + encodeURIComponent(repository) + "/releases?per_page=100&page=" + page;
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "rumiai-pkg-catalog-sync"
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(key + ": release discovery failed: HTTP " + response.status);
    }
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) throw new Error(key + ": invalid release response");
    releases.push(...pageItems);
    if (pageItems.some(x => x.tag_name === stopTag && !x.draft && !x.prerelease)) {
      overlapped = !full && known.length > 0;
      break;
    }
    if (pageItems.length < 100) break;
  }
  const seen = new Set();
  const sorted = releases.filter(x => !x.draft && !x.prerelease).map(x => {
    if (!versionPattern.test(x.tag_name) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(x.created_at) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(x.published_at) ||
        seen.has(x.tag_name)) throw new Error(key + ": invalid stable release");
    seen.add(x.tag_name);
    return { tag: x.tag_name, created: x.created_at, published: x.published_at };
  }).sort((a,b) => a.created < b.created ? -1 : a.created > b.created ? 1 :
    a.published < b.published ? -1 : a.published > b.published ? 1 : 0);
  if (!sorted.length) throw new Error(key + ": no stable releases");
  for (let i = 1; i < sorted.length; ++i) {
    if (sorted[i].created === sorted[i-1].created &&
        sorted[i].published === sorted[i-1].published) {
      throw new Error(key + ": ambiguous chronology");
    }
  }
  let tags = sorted.map(x => x.tag);
  if (!overlapped) {
    const first = known[0] || anchor;
    const minimum = tags.indexOf(first);
    if (minimum < 0) throw new Error(identity + ": historical anchor not found: " + first);
    tags = tags.slice(minimum);
  }
  if (overlapped) {
    const boundary = tags.indexOf(known[known.length - 1]);
    if (boundary < 0) throw new Error(identity + ": known boundary was not stable");
    const oldPrefix = tags.slice(0, boundary + 1).filter(tag => known.includes(tag));
    let cursor = 0;
    for (const tag of oldPrefix) {
      const position = known.indexOf(tag, cursor);
      if (position < 0) throw new Error(identity + ": old releases changed order; use full reconciliation");
      cursor = position + 1;
    }
    if (tags.slice(0, boundary).some(tag => !known.includes(tag))) {
      throw new Error(identity + ": inserted older release; use full reconciliation");
    }
    tags = known.concat(tags.slice(boundary + 1).filter(tag => !known.includes(tag)));
  }
  histories.set(key, tags);
  return tags;
}

async function optionalRead(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

for (const pkg of await readdir("pkg", { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  for (const stream of await readdir(join("pkg", pkg.name), { withFileTypes: true })) {
    if (!stream.isDirectory()) continue;
    const repositoryDir = join("pkg", pkg.name, stream.name, "repository");
    if (await optionalRead(join(repositoryDir, "type")) !== "github\n") continue;
    const owner = (await readFile(join(repositoryDir, "owner"), "utf8")).trim();
    const repository = (await readFile(join(repositoryDir, "repository"), "utf8")).trim();
    const file = join(repositoryDir, "versions");
    const old = await optionalRead(file);
    // Preserve the on-disk line protocol; malformed history cannot be repaired silently.
    const known = old === null ? [] : old.endsWith("\n") ? old.slice(0, -1).split("\n") : [];
    if (old !== null && (!old.endsWith("\n") || known.length === 0 ||
        new Set(known).size !== known.length ||
        known.some(v => !versionPattern.test(v)))) {
      throw new Error(file + ": invalid saved history");
    }
    const rangeNames = await readdir(join("pkg", pkg.name, stream.name));
    const anchors = rangeNames.filter(name => /^n0001=/.test(name));
    if (anchors.length !== 1 || !versionPattern.test(anchors[0].slice(6))) {
      throw new Error(file + ": missing or invalid first range anchor");
    }
    const live = await history(owner, repository, known, anchors[0].slice(6));
    let cursor = 0;
    for (const tag of known) {
      const position = live.indexOf(tag, cursor);
      if (position < 0) {
        throw new Error(file + ": known version " + tag +
          " is absent or reordered upstream; manual reconciliation required");
      }
      cursor = position + 1;
    }
    const next = live.join("\n") + "\n";
    if (old !== next) changes.push({ file, next });
  }
}

// A failed upstream inspection changes no catalog files.
for (const { file, next } of changes) {
  await writeFile(file, next, "utf8");
  process.stdout.write("Updated " + file + "\n");
}
process.stdout.write("Mode: " + (full ? "full" : "incremental") + "; repositories checked: " + histories.size +
  "; histories updated: " + changes.length + "\n");
