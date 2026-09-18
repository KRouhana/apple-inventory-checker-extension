export const targets: readonly ["chrome"];

export function validateManifest(
  target: (typeof targets)[number],
  manifest: Record<string, unknown>,
): void;
