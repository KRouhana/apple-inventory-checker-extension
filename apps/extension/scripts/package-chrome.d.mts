export const chromeArchiveFiles: readonly string[];

export function assertExactChromeArchiveFiles(files: Iterable<string>): void;

export function listZipEntries(archivePath: string): Promise<string[]>;

export function createChromeArchive(options?: {
  projectRoot?: string;
  sourceDirectory?: string;
}): Promise<{
  archiveName: string;
  archivePath: string;
  checksum: string;
  checksumPath: string;
  version: string;
}>;
