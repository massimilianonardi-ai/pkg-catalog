import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const graalvmVersionPattern = /^[0-9][A-Za-z0-9._+~-]*$/;
export const graalvmTargets = Object.freeze([
  "graalvm/linux-arm64",
  "graalvm/linux-x86_64",
  "graalvm/macos-arm64",
  "graalvm/windows-x86_64"
]);
const graalvmTargetSet = new Set(graalvmTargets);
const graalvmAnchor = "25.3.4.1";
const graalvmOwner = "graalvm";
const graalvmRepository = "graalvm-ce-builds";

export function normalizeTag(tag, type) {
  if (type === "github") return versionPattern.test(tag) ? tag : null;
  if (type !== "graalvm") return null;
  const match = /^(?:graal|jdk|vm)-([A-Za-z0-9][A-Za-z0-9._+~-]*)$/.exec(tag);
  if (!match || !graalvmVersionPattern.test(match[1]) || /^(?:graal|jdk|vm)-/.test(match[1])) return null;
  return match[1];
}

function compareChronology(left, right) {
  if (left.created !== right.created) return left.created < right.created ? -1 : 1;
  if (left.published !== right.published) return left.published < right.published ? -1 : 1;
  if (left.upstreamTag !== right.upstreamTag) return left.upstreamTag < right.upstreamTag ? -1 : 1;
  return 0;
}

function sameChronology(left, right) {
  return left.created === right.created && left.published === right.published;
}

export function normalizeReleases(releases, type, identity = "release history") {
  if (type !== "github" && type !== "graalvm") throw new Error(identity + ": unsupported repository type");
  const seenTags = new Set();
  const stable = releases.filter(release => !release.draft && !release.prerelease).map(release => {
    const tag = normalizeTag(release.tag_name, type);
    if (!tag || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(release.created_at) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(release.published_at) ||
        seenTags.has(release.tag_name)) {
      throw new Error(identity + ": invalid stable release");
    }
    seenTags.add(release.tag_name);
    return {
      tag,
      upstreamTag: release.tag_name,
      created: release.created_at,
      published: release.published_at,
      assets: Array.isArray(release.assets) ? release.assets : []
    };
  }).sort(compareChronology);
  if (!stable.length) throw new Error(identity + ": no stable releases");

  const selectedByVersion = new Map();
  for (const release of stable) {
    const previous = selectedByVersion.get(release.tag);
    if (previous && sameChronology(previous, release)) {
      throw new Error(identity + ": equal-chronology normalized version alias");
    }
    // Stable aliases are normal upstream history: keep the newest release record
    // for each package version, matching the runtime adapter's exact/latest view.
    selectedByVersion.set(release.tag, release);
  }
  const selected = [...selectedByVersion.values()].sort(compareChronology);
  for (let i = 1; i < selected.length; ++i) {
    if (sameChronology(selected[i - 1], selected[i])) {
      throw new Error(identity + ": ambiguous release chronology");
    }
  }
  return selected;
}

export function validateGraalvmAsset(release, archivePattern, target) {
  let expression;
  try { expression = new RegExp(archivePattern); }
  catch { throw new Error(target + ": invalid catalog archive pattern"); }
  const matches = release.assets.filter(asset => typeof asset.name === "string" && expression.test(asset.name));
  if (matches.length !== 1) throw new Error(target + ": selected release must have exactly one matching binary asset");
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(asset.digest) ||
      typeof asset.browser_download_url !== "string" ||
      !asset.browser_download_url.startsWith("https://github.com/graalvm/graalvm-ce-builds/releases/download/")) {
    throw new Error(target + ": selected binary asset lacks valid size, SHA-256 digest, or official URL");
  }
  return asset;
}

export async function syncVersionHistories({ packageDirectory = "v1/pkg", fetchImpl = fetch, full = false } = {}) {
  const histories = new Map();
  const changes = [];
  const graalvmResults = new Map();

  async function history(owner, repository, known, anchor, type, forceFull = false) {
    const identity = owner + "/" + repository;
    const scanFull = full || forceFull;
    const key = identity + ":" + type + ":" + (scanFull ? "full" : "incremental") + ":" + anchor + ":" + known.join(",");
    const stopTag = scanFull ? (known[0] || anchor) : (known[known.length - 1] || anchor);
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
      const response = await fetchImpl(url, { headers });
      if (!response.ok) throw new Error(key + ": release discovery failed: HTTP " + response.status);
      const pageItems = await response.json();
      if (!Array.isArray(pageItems)) throw new Error(key + ": invalid release response");
      releases.push(...pageItems);
      if (pageItems.some(item => normalizeTag(item.tag_name, type) === stopTag && !item.draft && !item.prerelease)) {
        overlapped = !scanFull && known.length > 0;
        break;
      }
      if (pageItems.length < 100) break;
    }

    const selected = normalizeReleases(releases, type, key);
    let tags = selected.map(release => release.tag);
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
        if (position < 0) return history(owner, repository, known, anchor, type, true);
        cursor = position + 1;
      }
      if (tags.slice(0, boundary).some(tag => !known.includes(tag))) {
        return history(owner, repository, known, anchor, type, true);
      }
      tags = known.concat(tags.slice(boundary + 1).filter(tag => !known.includes(tag)));
    }
    const result = { tags, selected };
    histories.set(key, result);
    return result;
  }

  async function optionalRead(path) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  const streams = [];
  const presentGraalvmTargets = new Set();
  for (const pkg of await readdir(packageDirectory, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const stream of await readdir(join(packageDirectory, pkg.name), { withFileTypes: true })) {
      if (!stream.isDirectory()) continue;
      const streamDirectory = join(packageDirectory, pkg.name, stream.name);
      const repositoryDir = join(streamDirectory, "repository");
      const typeFile = await optionalRead(join(repositoryDir, "type"));
      if (typeFile !== "github\n" && typeFile !== "graalvm\n") continue;
      const type = typeFile.slice(0, -1);
      const owner = (await readFile(join(repositoryDir, "owner"), "utf8")).trim();
      const repository = (await readFile(join(repositoryDir, "repository"), "utf8")).trim();
      const streamName = pkg.name + "/" + stream.name;
      if (type === "graalvm" && !graalvmTargetSet.has(streamName)) {
        throw new Error(streamName + ": unsupported GraalVM target stream");
      }
      const rangeNames = await readdir(streamDirectory);
      const anchors = rangeNames.filter(name => /^n0001=/.test(name));
      const file = join(repositoryDir, "versions");
      if (anchors.length !== 1 || !versionPattern.test(anchors[0].slice(6))) {
        throw new Error(file + ": missing or invalid first range anchor");
      }
      const anchor = anchors[0].slice(6);
      let archivePattern = null;
      if (type === "graalvm") {
        if (owner !== graalvmOwner || repository !== graalvmRepository) {
          throw new Error(streamName + ": GraalVM history must use the official release source");
        }
        if (anchor !== graalvmAnchor) throw new Error(streamName + ": unexpected GraalVM catalog anchor");
        const archivePatternText = await optionalRead(join(streamDirectory, anchors[0], "archive_regex"));
        if (!archivePatternText || !archivePatternText.endsWith("\n")) {
          throw new Error(streamName + ": missing catalog archive pattern");
        }
        archivePattern = archivePatternText.slice(0, -1);
        try { new RegExp(archivePattern); }
        catch { throw new Error(streamName + ": invalid catalog archive pattern"); }
        presentGraalvmTargets.add(streamName);
      }
      streams.push({ type, owner, repository, streamName, streamDirectory, repositoryDir, file, anchor, archivePattern });
    }
  }
  if (presentGraalvmTargets.size > 0) {
    const missing = graalvmTargets.filter(target => !presentGraalvmTargets.has(target));
    if (missing.length) throw new Error("incomplete GraalVM catalog streams: " + missing.join(", "));
  }

  for (const stream of streams) {
    const old = await optionalRead(stream.file);
    const known = old === null ? [] : old.endsWith("\n") ? old.slice(0, -1).split("\n") : [];
    if (old !== null && (!old.endsWith("\n") || known.length === 0 ||
        new Set(known).size !== known.length || known.some(version => !versionPattern.test(version)))) {
      throw new Error(stream.file + ": invalid saved history");
    }
    const { tags, selected } = await history(stream.owner, stream.repository, known, stream.anchor, stream.type);
    let cursor = 0;
    for (const version of known) {
      const position = tags.indexOf(version, cursor);
      if (position < 0) {
        throw new Error(stream.file + ": known version " + version +
          " is absent or reordered upstream; manual reconciliation required");
      }
      cursor = position + 1;
    }
    if (stream.type === "graalvm") {
      const latestVersion = tags[tags.length - 1];
      const latestRelease = selected.find(release => release.tag === latestVersion);
      const anchorRelease = selected.find(release => release.tag === graalvmAnchor);
      if (!latestRelease) throw new Error(stream.streamName + ": selected latest release record is missing");
      validateGraalvmAsset(latestRelease, stream.archivePattern, stream.streamName + " latest");
      if (anchorRelease) validateGraalvmAsset(anchorRelease, stream.archivePattern, stream.streamName + " anchor");
      graalvmResults.set(stream.streamName.slice("graalvm/".length), tags.join("\n") + "\n");
    }
    const next = tags.join("\n") + "\n";
    if (old !== next) changes.push({ file: stream.file, next });
  }

  if (histories.size === 0) throw new Error("no GitHub catalog streams were inspected");
  if (graalvmResults.size > 0) {
    const missing = graalvmTargets.filter(target => !graalvmResults.has(target.slice("graalvm/".length)));
    if (missing.length) throw new Error("incomplete GraalVM history streams: " + missing.join(", "));
    const distinct = new Set(graalvmResults.values());
    if (distinct.size !== 1) throw new Error("GraalVM platform release histories diverge");
  }

  // No catalog files are changed until every upstream stream and fixture is valid.
  for (const { file, next } of changes) {
    await writeFile(file, next, "utf8");
    process.stdout.write("Updated " + file + "\n");
  }
  process.stdout.write("Mode: " + (full ? "full" : "incremental") + "; repositories checked: " + histories.size +
    "; histories updated: " + changes.length + "\n");
  return { repositories: histories.size, updated: changes.length };
}

async function main() {
  const full = process.argv.length === 3 && process.argv[2] === "--full";
  if (process.argv.length > (full ? 3 : 2)) throw new Error("usage: node sync-version-history.mjs [--full]");
  await syncVersionHistories({ full });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
