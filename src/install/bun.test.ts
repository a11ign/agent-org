// no-token: none -- the download is a zip made in memory, and the binary is written to a map
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { bunAsset, bunReleaseUrl, ensureBun, findBun, zipEntry, type BunDeps } from "./bun.ts";

/** A zip holding `entries`, each deflated or stored, as `zip` would write it. */
function makeZip(entries: Record<string, Buffer>, store = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const body = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const BINARY = Buffer.from("\x7fELF pretend bun ".repeat(200));

test("the bun binary is read out of the release zip, deflated or stored, by its name under the release's folder", () => {
  const zip = makeZip({ "bun-linux-x64/": Buffer.alloc(0), "bun-linux-x64/bun": BINARY });
  assert.deepEqual(zipEntry(zip, "bun"), BINARY);
  assert.deepEqual(zipEntry(makeZip({ "bun-darwin-aarch64/bun": BINARY }, true), "bun"), BINARY);
});

test("a zip that is cut short, damaged or without bun is refused, never written as a bun that will not start", () => {
  const zip = makeZip({ "bun-linux-x64/bun": BINARY }, true);
  assert.throws(() => zipEntry(zip.subarray(0, zip.length - 30), "bun"), /not a zip file/);
  const corrupt = Buffer.from(zip);
  corrupt[60] ^= 0xff; // inside the stored data, after the 30-byte header and the 17-byte name
  assert.throws(() => zipEntry(corrupt, "bun"), /does not match its checksum/);
  assert.throws(() => zipEntry(makeZip({ "bun-linux-x64/bunx": BINARY }), "bun"), /holds no bun/);
  assert.throws(() => zipEntry(Buffer.from("<html>rate limited</html>"), "bun"), /not a zip file/);
});

test("the release asset is named as bun names it, and an unsupported machine is refused", () => {
  assert.equal(bunAsset("darwin", "arm64"), "bun-darwin-aarch64");
  assert.equal(bunAsset("linux", "x64"), "bun-linux-x64");
  assert.equal(bunAsset("linux", "arm64"), "bun-linux-aarch64");
  assert.equal(bunReleaseUrl("bun-linux-x64"), "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip");
  assert.throws(() => bunAsset("win32", "x64"), /no build for win32/);
  assert.throws(() => bunAsset("linux", "ia32"), /no build for linux on ia32/);
});

function deps(present: string[], over: Partial<BunDeps> = {}) {
  const written = new Map<string, Buffer>();
  const asked: string[] = [];
  const value: BunDeps = {
    home: "/h", env: { PATH: "/usr/local/bin:/usr/bin" }, platform: "linux", arch: "x64",
    exists: (path) => present.includes(path),
    download: async (url) => { asked.push(url); return makeZip({ "bun-linux-x64/bun": BINARY }); },
    writeExecutable: (path, data) => { written.set(path, data); },
    ...over,
  };
  return { deps: value, written, asked };
}

test("ensureBun downloads nothing when ~/.bun/bin/bun or a bun on PATH is there", async () => {
  for (const present of ["/h/.bun/bin/bun", "/usr/bin/bun"]) {
    const { deps: d, asked } = deps([present]);
    assert.deepEqual(await ensureBun(d), { path: present, installed: false });
    assert.deepEqual(asked, []);
  }
  assert.equal(findBun("/h", "relative:/usr/bin", (path) => path === "relative/bun"), null, "a relative PATH entry is not looked in");
});

test("ensureBun installs the release's bun into ~/.bun/bin when there is none, with no unzip and no sudo", async () => {
  const { deps: d, written, asked } = deps([]);
  assert.deepEqual(await ensureBun(d), { path: "/h/.bun/bin/bun", installed: true });
  assert.deepEqual(asked, ["https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"]);
  assert.deepEqual(written.get("/h/.bun/bin/bun"), BINARY);
});
