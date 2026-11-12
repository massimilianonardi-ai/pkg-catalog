import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  graalvmTargets,
  normalizeReleases,
  normalizeTag,
  syncVersionHistories,
  validateGraalvmAsset
} from "../sync-version-history.mjs";

const archivePatterns = new Map([
  ["linux-arm64", "^graalvm-community-jdk-25[A-Za-z0-9._+~-]*_linux-aarch64_bin\\.tar\\.gz$"],
  ["linux-x86_64", "^graalvm-community-jdk-25[A-Za-z0-9._+~-]*_linux-x64_bin\\.tar\\.gz$"],
  ["macos-arm64", "^graalvm-community-jdk-25[A-Za-z0-9._+~-]*_macos-aarch64_bin\\.tar\\.gz$"],
  ["windows-x86_64", "^graalvm-community-jdk-25[A-Za-z0-9._+~-]*_windows-x64_bin\\.zip$"]
]);
const chronology = {
  "vm-21.0.0": ["2021-01-01T00:00:00Z", "2021-01-02T00:00:00Z"],
  "jdk-21.0.0": ["2023-09-01T00:00:00Z", "2023-09-02T00:00:00Z"],
  "graal-23.0.2": ["2023-10-24T00:00:00Z", "2023-10-25T00:00:00Z"],
  "jdk-23.0.2": ["2025-01-21T00:00:00Z", "2025-01-22T00:00:00Z"],
  "graal-25.3.4.1": ["2025-10-24T00:00:00Z", "2025-10-25T00:00:00Z"],
  "graal-25.4.4.1.1": ["2025-11-01T00:00:00Z", "2025-11-02T00:00:00Z"],
  "graal-25.5.5.0.3": ["2025-11-03T00:00:00Z", "2025-11-04T00:00:00Z"]
};

function assetFor(name, tag) {
  return {
    name,
    size: 123456,
    digest: "sha256:" + "a".repeat(64),
    browser_download_url: "https://github.com/graalvm/graalvm-ce-builds/releases/download/" + tag + "/" + name
  };
}

function assetsFor(tag) {
  const releaseName = "graalvm-community-jdk-25i5-25.0.5.0.3";
  return [
    assetFor(releaseName + "_linux-aarch64_bin.tar.gz", tag),
    assetFor(releaseName + "_linux-aarch64_bin.tar.gz.sha256", tag),
    assetFor(releaseName + "_linux-x64_bin.tar.gz", tag),
    assetFor(releaseName + "_macos-aarch64_bin.tar.gz", tag),
    assetFor(releaseName + "_windows-x64_bin.zip", tag)
  ];
}

function release(tag, { draft = false, prerelease = false } = {}) {
  const [created_at, published_at] = chronology[tag] || ["2025-12-01T00:00:00Z", "2025-12-02T00:00:00Z"];
  return { tag_name: tag, draft, prerelease, created_at, published_at, assets: assetsFor(tag) };
}

const releases = Object.keys(chronology).reverse().map(tag => release(tag));

async function makeCatalogFixture(t) {
  const tempParent = join(process.cwd(), ".tmp");
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(join(tempParent, "graalvm-history-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "v1", "pkg");
  for (const target of graalvmTargets) {
    const stream = join(packageDirectory, target);
    const repository = join(stream, "repository");
    const range = join(stream, "n0001=25.3.4.1");
    await mkdir(repository, { recursive: true });
    await mkdir(range, { recursive: true });
    await writeFile(join(repository, "type"), "graalvm\n");
    await writeFile(join(repository, "owner"), "graalvm\n");
    await writeFile(join(repository, "repository"), "graalvm-ce-builds\n");
    await writeFile(join(range, "archive_regex"), archivePatterns.get(target.slice("graalvm/".length)) + "\n");
  }
  return { root, packageDirectory };
}

test("normalizes only one official GraalVM tag prefix", () => {
  assert.equal(normalizeTag("graal-25.3.4.1", "graalvm"), "25.3.4.1");
  assert.equal(normalizeTag("jdk-25.4.4.1.1", "graalvm"), "25.4.4.1.1");
  assert.equal(normalizeTag("vm-21.0.0", "graalvm"), "21.0.0");
  assert.equal(normalizeTag("graal-jdk-25.3.4.1", "graalvm"), null);
  assert.equal(normalizeTag("other-25.3.4.1", "graalvm"), null);
  assert.equal(normalizeTag("graal-25.3.4.1", "github"), null);
});

test("chooses the newest stable release for real GraalVM alias pairs deterministically", () => {
  const input = [release("jdk-23.0.2"), release("graal-23.0.2"), release("jdk-21.0.0"), release("vm-21.0.0")];
  const normalized = normalizeReleases(input, "graalvm", "fixture");
  assert.deepEqual(normalized.map(record => [record.tag, record.upstreamTag]), [
    ["21.0.0", "jdk-21.0.0"],
    ["23.0.2", "jdk-23.0.2"]
  ]);
  assert.deepEqual(
    normalizeReleases([...input].reverse(), "graalvm", "fixture").map(record => record.upstreamTag),
    normalized.map(record => record.upstreamTag)
  );
});

test("rejects unknown stable tags and equal-chronology aliases", () => {
  assert.throws(() => normalizeReleases([release("unknown-25.0.0")], "graalvm"), /invalid stable release/);
  const duplicateTime = [
    { ...release("graal-23.0.2"), created_at: "2025-01-01T00:00:00Z", published_at: "2025-01-02T00:00:00Z" },
    { ...release("jdk-23.0.2"), created_at: "2025-01-01T00:00:00Z", published_at: "2025-01-02T00:00:00Z" }
  ];
  assert.throws(() => normalizeReleases(duplicateTime, "graalvm"), /equal-chronology normalized version alias/);
});

test("requires one exact official binary with size and SHA-256 digest", () => {
  const target = "graalvm/linux-arm64";
  const record = { assets: assetsFor("graal-25.5.5.0.3") };
  const regex = archivePatterns.get("linux-arm64");
  assert.equal(validateGraalvmAsset(record, regex, target).name.endsWith("_linux-aarch64_bin.tar.gz"), true);
  assert.throws(() => validateGraalvmAsset({ assets: [] }, regex, target), /exactly one matching binary/);
  assert.throws(() => validateGraalvmAsset({ assets: [record.assets[0], record.assets[0]] }, regex, target), /exactly one matching binary/);
  assert.throws(() => validateGraalvmAsset({ assets: [{ ...record.assets[0], digest: "sha1:" + "a".repeat(40) }] }, regex, target), /valid size, SHA-256 digest/);
});

test("synchronizes identical histories for all four official platform streams", async t => {
  const { packageDirectory } = await makeCatalogFixture(t);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/graalvm\/graalvm-ce-builds\/releases\?/);
    return { ok: true, json: async () => releases };
  };
  const result = await syncVersionHistories({ packageDirectory, fetchImpl });
  assert.equal(result.updated, 4);
  assert.equal(requests.length, 1);
  const outputs = [];
  for (const target of graalvmTargets) {
    outputs.push(await readFile(join(packageDirectory, target, "repository", "versions"), "utf8"));
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(outputs[0], "25.3.4.1\n25.4.4.1.1\n25.5.5.0.3\n");
  const second = await syncVersionHistories({ packageDirectory, fetchImpl });
  assert.equal(second.updated, 0);
});

test("rejects non-official sources and unsupported GraalVM target streams before HTTP", async t => {
  const { packageDirectory, root } = await makeCatalogFixture(t);
  const wrongOwner = join(packageDirectory, "graalvm", "linux-arm64", "repository", "owner");
  await writeFile(wrongOwner, "untrusted\n");
  let calls = 0;
  await assert.rejects(syncVersionHistories({ packageDirectory, fetchImpl: async () => { calls++; throw new Error("unexpected request"); } }), /official release source/);
  assert.equal(calls, 0);
  await writeFile(wrongOwner, "graalvm\n");
  const unsupported = join(packageDirectory, "graalvm", "freebsd-x86_64");
  await mkdir(join(unsupported, "repository"), { recursive: true });
  await writeFile(join(unsupported, "repository", "type"), "graalvm\n");
  await writeFile(join(unsupported, "repository", "owner"), "graalvm\n");
  await writeFile(join(unsupported, "repository", "repository"), "graalvm-ce-builds\n");
  await assert.rejects(syncVersionHistories({ packageDirectory, fetchImpl: async () => { calls++; throw new Error("unexpected request"); } }), /unsupported GraalVM target/);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(root, "v1", "pkg", "graalvm", "linux-arm64", "repository", "versions"), "utf8").catch(() => null), null);
});
