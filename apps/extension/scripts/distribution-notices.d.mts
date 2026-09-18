export type BundledPackage = {
  declaredLicense: string;
  licenseText: string;
  name: string;
  version: string;
};

type EsbuildMetafile = {
  inputs: Record<string, unknown>;
};

export function assertSafeDistributionDestination(options: {
  destination: string;
  projectRoot: string;
}): Promise<string>;

export function collectBundledPackages(options: {
  extensionRoot: string;
  metafile: EsbuildMetafile;
}): Promise<BundledPackage[]>;

export function formatThirdPartyNotices(
  bundledPackages: BundledPackage[],
): string;

export function writeDistributionNotices(options: {
  destination: string;
  extensionRoot: string;
  metafile: EsbuildMetafile;
  projectRoot: string;
}): Promise<BundledPackage[]>;

export const distributionNoticeFiles: readonly [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.txt",
];
