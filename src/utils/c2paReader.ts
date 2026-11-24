import type { C2paMetadataSummary } from '../types/analysis.ts';

// Standard C2PA ISO-BMFF JUMBF box UUID: d8fec3d6-1b0e-483c-9297-5828877ec481
const C2PA_UUID_BYTES = new Uint8Array([
  0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
]);

function equalsBytes(a: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset + expected.length > a.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (a[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Pure byte-level scan checking whether an ISO-BMFF (MP4/MOV) buffer contains
 * a C2PA UUID box or JUMBF (`jumb`) / `c2pa` container marker.
 */
export function hasC2paMarkerInBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 16) return false;

  // Walk top-level ISO-BMFF boxes cleanly when ftyp header is present
  let offset = 0;
  let validIsoWalk = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (offset + 8 <= bytes.length) {
    const size32 = view.getUint32(offset, false);
    const boxType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );

    let boxSize = size32;
    let headerSize = 8;
    if (size32 === 1 && offset + 16 <= bytes.length) {
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      boxSize = high * 4294967296 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = bytes.length - offset;
    }

    if (boxSize < 8) break;
    if (boxType === 'ftyp') validIsoWalk = true;

    if (boxType === 'jumb') {
      return true;
    }
    if (boxType === 'uuid' && offset + headerSize + 16 <= bytes.length) {
      if (equalsBytes(bytes, offset + headerSize, C2PA_UUID_BYTES)) {
        return true;
      }
    }

    if (offset + boxSize > bytes.length) break;
    offset += boxSize;
  }

  if (validIsoWalk) {
    // Also check for nested C2PA UUID or 'c2pa' JUMBF labels anywhere in moov/meta
    for (let i = 0; i <= bytes.length - 16; i += 1) {
      if (equalsBytes(bytes, i, C2PA_UUID_BYTES)) return true;
      if (
        bytes[i] === 0x6a &&
        bytes[i + 1] === 0x75 &&
        bytes[i + 2] === 0x6d &&
        bytes[i + 3] === 0x62
      ) {
        return true;
      }
    }
    return false;
  }

  // Fallback raw UUID scan
  for (let i = 0; i <= bytes.length - 16; i += 1) {
    if (equalsBytes(bytes, i, C2PA_UUID_BYTES)) return true;
  }
  return false;
}

/**
 * Fast Blob-slice ISO-BMFF top-level box scanner so 300MB videos without C2PA
 * don't need to allocate full-file memory or boot the C2PA WASM engine.
 */
async function blobHasTopLevelC2paCandidate(blob: Blob): Promise<boolean> {
  try {
    // For small files (<= 30MB), scan bytes directly before booting the C2PA WASM engine
    if (blob.size <= 30 * 1024 * 1024) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      return hasC2paMarkerInBytes(buf);
    }
    let offset = 0;
    while (offset + 8 <= blob.size) {
      const headerBuf = await blob.slice(offset, Math.min(blob.size, offset + 32)).arrayBuffer();
      const bytes = new Uint8Array(headerBuf);
      if (bytes.length < 8) break;
      const view = new DataView(headerBuf);
      const size32 = view.getUint32(0, false);
      const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);

      let boxSize = size32;
      let headerSize = 8;
      if (size32 === 1 && bytes.length >= 16) {
        const high = view.getUint32(8, false);
        const low = view.getUint32(12, false);
        boxSize = high * 4294967296 + low;
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = blob.size - offset;
      }
      if (boxSize < 8) break;

      if (boxType === 'jumb') return true;
      if (boxType === 'uuid' && bytes.length >= headerSize + 16) {
        if (equalsBytes(bytes, headerSize, C2PA_UUID_BYTES)) {
          return true;
        }
      }
      // Also inspect moov/meta boxes if relatively compact (< 20MB)
      if ((boxType === 'moov' || boxType === 'meta') && boxSize < 20 * 1024 * 1024) {
        const boxBuf = await blob.slice(offset, offset + boxSize).arrayBuffer();
        if (hasC2paMarkerInBytes(new Uint8Array(boxBuf))) {
          return true;
        }
      }
      offset += boxSize;
    }
    return false;
  } catch {
    return false;
  }
}

export function summarizeC2paManifest(rawManifest: unknown, validationState?: string): C2paMetadataSummary | null {
  if (!rawManifest || typeof rawManifest !== 'object') return null;
  const manifest = rawManifest as {
    title?: string;
    claim_generator?: string;
    claim_generator_info?: Array<{ name?: string; version?: string }>;
    signature_info?: { issuer?: string; time?: string };
    assertions?: Array<{ label?: string; data?: Record<string, unknown> }>;
  };

  const genInfo = manifest.claim_generator_info?.[0];
  const claimGenerator =
    (genInfo?.name ? `${genInfo.name}${genInfo.version ? ` ${genInfo.version}` : ''}` : '') ||
    manifest.claim_generator?.trim() ||
    undefined;

  const actions: string[] = [];
  let digitalSourceType: string | undefined;
  let isAiGeneratedClaim = false;

  if (Array.isArray(manifest.assertions)) {
    for (const assertion of manifest.assertions) {
      if (assertion?.label?.startsWith('c2pa.actions') && assertion.data) {
        const actionList = assertion.data.actions;
        if (Array.isArray(actionList)) {
          for (const act of actionList) {
            if (!act || typeof act !== 'object') continue;
            const actionObj = act as { action?: string; digitalSourceType?: string };
            if (actionObj.action && !actions.includes(actionObj.action)) {
              actions.push(actionObj.action);
            }
            if (actionObj.digitalSourceType && !digitalSourceType) {
              digitalSourceType = actionObj.digitalSourceType;
            }
            if (
              actionObj.digitalSourceType &&
              /trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmic/i.test(
                actionObj.digitalSourceType
              )
            ) {
              isAiGeneratedClaim = true;
            }
          }
        }
      }
    }
  }

  return {
    hasManifest: true,
    claimGenerator,
    title: manifest.title?.trim() || undefined,
    issuer: manifest.signature_info?.issuer?.trim() || undefined,
    signedAt: manifest.signature_info?.time?.trim() || undefined,
    digitalSourceType,
    isAiGeneratedClaim,
    actions: actions.slice(0, 6),
    validationState,
  };
}

/**
 * Reads C2PA Content Credentials in the browser BEFORE video re-encoding strips them.
 * Gracefully skips and returns null when the file has no C2PA manifest or cannot be parsed.
 */
export async function extractC2paMetadataInBrowser(file: File): Promise<C2paMetadataSummary | null> {
  if (typeof window === 'undefined' || !file || file.size <= 0) {
    return null;
  }

  try {
    const hasCandidate = await blobHasTopLevelC2paCandidate(file);
    if (!hasCandidate) {
      return null;
    }

    const { createC2pa, Reader } = await import('@contentauth/c2pa-web/inline');
    const c2pa = await createC2pa();
    let reader: Awaited<ReturnType<typeof Reader.fromBlob>> = null;
    try {
      reader = await Reader.fromBlob(c2pa, file.type || undefined, file);
      if (!reader) {
        return null;
      }
      const store = await reader.manifestStore();
      const activeLabel = store?.active_manifest;
      const activeManifest =
        (activeLabel && store?.manifests?.[activeLabel]) || (await reader.activeManifest());
      return summarizeC2paManifest(activeManifest, store?.validation_state ?? undefined);
    } finally {
      if (reader) {
        await reader.free().catch(() => undefined);
      }
      try {
        c2pa.dispose();
      } catch {
        // Ignore worker dispose errors
      }
    }
  } catch {
    // Gracefully skip if C2PA data is unreadable or absent
    return null;
  }
}
