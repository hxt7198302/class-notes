// png.js —— 零依赖 PNG 解码(zlib 内置), 输出 {width,height,data:RGBA Buffer}
'use strict';
const zlib = require('zlib');

function decodePNG(buf) {
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) throw new Error('不是PNG文件');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持位深${bitDepth}(仅支持8)`);
  if (interlace !== 0) throw new Error('不支持交错PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持颜色类型${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = raw[inPos + i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      cur[i] = v;
    }
    inPos += stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (colorType === 6) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (colorType === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else if (colorType === 3) {
        const pi = cur[s] * 3;
        out[o] = palette[pi]; out[o + 1] = palette[pi + 1]; out[o + 2] = palette[pi + 2];
        out[o + 3] = trns ? trns[cur[s]] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

module.exports = { decodePNG, encodePNGRGB, cropResizeBilinear };

// ---------- 编码( RGB8, filter 0 ) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePNGRGB(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 裁剪+双线性缩放: img={width,height,data:RGBA}, 返回 {img, mapBack(x,y)->原坐标}
function cropResizeBilinear(img, x0, y0, x1, y1, scale) {
  const cw = Math.max(1, Math.round((x1 - x0) * scale)), ch = Math.max(1, Math.round((y1 - y0) * scale));
  const out = Buffer.alloc(cw * ch * 3);
  const W = img.width, H = img.height, d = img.data;
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(H - 1, y0 + y / scale), fy = Math.floor(sy), gy = Math.min(H - 1, fy + 1), wy = sy - fy;
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(W - 1, x0 + x / scale), fx = Math.floor(sx), gx = Math.min(W - 1, fx + 1), wx = sx - fx;
      const o = (y * cw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = d[(fy * W + fx) * 4 + c], p10 = d[(fy * W + gx) * 4 + c];
        const p01 = d[(gy * W + fx) * 4 + c], p11 = d[(gy * W + gx) * 4 + c];
        out[o + c] = Math.round(p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy);
      }
    }
  }
  return { width: cw, height: ch, rgb: out, mapBack: (x, y) => [x / scale + x0, y / scale + y0] };
}
