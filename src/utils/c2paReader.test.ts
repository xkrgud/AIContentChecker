import test from 'node:test';
import assert from 'node:assert/strict';
import { hasC2paMarkerInBytes, summarizeC2paManifest } from './c2paReader.ts';

function buildMinimalMp4Box(type: string, payload: Uint8Array): Uint8Array {
  const totalSize = 8 + payload.length;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalSize, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(payload, 8);
  return out;
}

test('hasC2paMarkerInBytes detects C2PA UUID box in MP4 and returns false when absent', () => {
  const ftyp = buildMinimalMp4Box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const c2paUuid = new Uint8Array([
    0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81,
    0x00, 0x00, 0x00, 0x01,
  ]);
  const uuidBox = buildMinimalMp4Box('uuid', c2paUuid);

  const withC2pa = new Uint8Array(ftyp.length + uuidBox.length);
  withC2pa.set(ftyp, 0);
  withC2pa.set(uuidBox, ftyp.length);

  assert.equal(hasC2paMarkerInBytes(withC2pa), true);

  const plainMdat = buildMinimalMp4Box('mdat', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  const withoutC2pa = new Uint8Array(ftyp.length + plainMdat.length);
  withoutC2pa.set(ftyp, 0);
  withoutC2pa.set(plainMdat, ftyp.length);

  assert.equal(hasC2paMarkerInBytes(withoutC2pa), false);
});

test('summarizeC2paManifest extracts generator, issuer, and trainedAlgorithmicMedia AI disclosure cleanly', () => {
  const summary = summarizeC2paManifest(
    {
      title: 'sample-reel.mp4',
      claim_generator_info: [{ name: 'OpenAI Sora', version: '1.0' }],
      signature_info: { issuer: 'OpenAI', time: '2026-10-01T12:00:00Z' },
      assertions: [
        {
          label: 'c2pa.actions.v2',
          data: {
            actions: [
              {
                action: 'c2pa.created',
                digitalSourceType:
                  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
              },
            ],
          },
        },
      ],
    },
    'Valid'
  );

  assert.ok(summary);
  assert.equal(summary.hasManifest, true);
  assert.equal(summary.claimGenerator, 'OpenAI Sora 1.0');
  assert.equal(summary.issuer, 'OpenAI');
  assert.equal(summary.isAiGeneratedClaim, true);
  assert.deepEqual(summary.actions, ['c2pa.created']);
  assert.equal(summary.validationState, 'Valid');
});
