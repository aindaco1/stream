// A tiny Blu-ray PGS display set with an opaque white 32x12 rectangle on a 160x90 canvas.
// The display events include explicit clears, so tests can distinguish a visible cue from a stale frame.
export function pictureSubtitles(events = [[0,false],[2,true],[4,false],[13,true],[19,false]]) {
  const chunks = [];
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  function packet(time, type, payload) {
    const header = Buffer.alloc(13);
    header.write('PG');
    header.writeUInt32BE(time * 90000, 2);
    header.writeUInt32BE(time * 90000, 6);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    chunks.push(header, payload);
  }
  for (const [number, [time, visible]] of events.entries()) {
    const composition = Buffer.concat([u16(160), u16(90), Buffer.from([0x20]), u16(number),
      Buffer.from([visible ? 0x80 : 0, 0, 0, Number(visible)]),
      ...(visible ? [u16(0), Buffer.from([0,0]), u16(16), u16(40)] : [])]);
    packet(time, 0x16, composition);
    if (visible) {
      packet(time, 0x17, Buffer.concat([Buffer.from([1,0]), u16(16), u16(40), u16(32), u16(12)]));
      packet(time, 0x14, Buffer.from([0,0,0,16,128,128,0,1,235,128,128,255]));
      const rle = Buffer.concat(Array.from({length:12}, () => Buffer.from([0,0xa0,1,0,0])));
      const length = Buffer.alloc(3);
      length.writeUIntBE(4 + rle.length, 0, 3);
      packet(time, 0x15, Buffer.concat([u16(0),Buffer.from([0,0xc0]),length,u16(32),u16(12),rle]));
    }
    packet(time, 0x80, Buffer.alloc(0));
  }
  return Buffer.concat(chunks);
}
