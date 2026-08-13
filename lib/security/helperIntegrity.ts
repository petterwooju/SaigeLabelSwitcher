export const EXPECTED_HELPER_SIZE = 6_908_928;
export const EXPECTED_HELPER_SHA256 =
  "A9831278CB21D6AFD627ABB55344545800829F2F5866AA34738609DD446F3A94";

export class HelperIntegrityError extends Error {
  readonly code = "HELPER_INTEGRITY_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "HelperIntegrityError";
  }
}

/** Verify the exact, release-pinned helper before placing it in an SVPA ZIP. */
export async function assertHelperIntegrity(blob: Blob): Promise<void> {
  if (blob.size !== EXPECTED_HELPER_SIZE) {
    throw new HelperIntegrityError(
      `路径修复工具大小不正确（实际 ${blob.size}，预期 ${EXPECTED_HELPER_SIZE} 字节）。`,
    );
  }

  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  if (actual !== EXPECTED_HELPER_SHA256) {
    throw new HelperIntegrityError(
      `路径修复工具校验失败（SHA-256 ${actual}）。`,
    );
  }
}
