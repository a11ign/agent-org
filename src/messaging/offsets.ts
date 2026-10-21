// THE LISTENER'S OFFSET, KEPT IN A FILE (a11ign/a11ign#2907; moved out of the Telegram provider by A11-162). A provider that listens asks for updates from an offset and moves it as it handles
// them, and where the offset is kept is the core's: one small file per host, owned by the listener, whichever provider is listening.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const OFFSET_FILE_MODE = 0o600;
const OFFSET_DIRECTORY_MODE = 0o700;

/**
 * Where the offset is kept, so a restart asks from it. A corrupt or unreadable file is "no offset": the ledger's dedupe makes asking from
 * the beginning of what Telegram still holds safe, and a listener that refuses to start over a bad cache is worse than one that replays.
 */
export function createOffsetStore(path: string, { log = () => {} }: { log?: (line: string) => void; } = {}): { path: string; read: () => number | undefined; write: (offset: number) => void; } {
  return {
    path,
    read() {
      let stored: unknown;
      try {
        stored = JSON.parse(readFileSync(path, "utf8")).offset;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`offset file ${path} is unreadable (${(error as Error).message}); asking from the start`);
        return undefined;
      }
      if (Number.isSafeInteger(stored) && (stored as number) >= 0) return stored as number;
      log(`offset file ${path} does not hold an offset; asking from the start`);
      return undefined;
    },
    write(offset) {
      mkdirSync(dirname(path), { recursive: true, mode: OFFSET_DIRECTORY_MODE });
      // Created 0600 under a temporary name and renamed into place: a crash leaves the old file or the whole new one, never half of one.
      const temporary = `${path}.${process.pid}.tmp`;
      const descriptor = openSync(temporary, "w", OFFSET_FILE_MODE);
      try {
        writeSync(descriptor, `${JSON.stringify({ offset })}\n`);
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(temporary);
        throw error;
      }
      closeSync(descriptor);
      renameSync(temporary, path);
    },
  };
}
