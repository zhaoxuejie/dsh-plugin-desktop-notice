// dsh-plugin-desktop-notice — 内置音效生成（自制合成，CC0，无许可负担——spec §7）
// 运行：npm run gen:wav  →  assets/{success,notice,alert}.wav（22050Hz / 16bit / mono）
// success：上行双音（完成）  notice：双 ping（等待输入）  alert：低鸣（失败）

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SR = 22050;
const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "assets");

/** notes: [{ f: 频率Hz, d: 时长s, gap: 后置静音s, shape: 'plain'|'low' }] */
function synth(notes) {
  const chunks = [];
  let total = 0;
  for (const n of notes) {
    const len = Math.floor(n.d * SR);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.min(1, i / (0.008 * SR)) * Math.exp(-3.2 * (i / len));
      let v = Math.sin(2 * Math.PI * n.f * t);
      if (n.shape === "low") {
        // 叠加谐波模拟"低沉"而非刺耳的方波感
        v = 0.6 * Math.sin(2 * Math.PI * n.f * t) + 0.25 * Math.sin(4 * Math.PI * n.f * t) + 0.15 * Math.sin(6 * Math.PI * n.f * t);
      }
      buf[i] = v * env * 0.55;
    }
    const gap = Math.floor((n.gap ?? 0) * SR);
    chunks.push({ buf, gap });
    total += len + gap;
  }
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.buf.length; i++) {
      pcm[off + i] = Math.max(-1, Math.min(1, c.buf[i])) * 32767;
    }
    off += c.buf.length + c.gap;
  }
  return pcm;
}

function wav(pcm) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length * 2, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);  // PCM
  hdr.writeUInt16LE(1, 22);  // mono
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([hdr, Buffer.from(pcm.buffer)]);
}

const specs = {
  success: [{ f: 784, d: 0.16 }, { f: 1175, d: 0.32, gap: 0.02 }],
  notice: [{ f: 988, d: 0.11 }, { f: 988, d: 0.18, gap: 0.14 }],
  alert: [{ f: 233, d: 0.22, shape: "low" }, { f: 196, d: 0.34, shape: "low", gap: 0.02 }],
};

fs.mkdirSync(dir, { recursive: true });
for (const [name, notes] of Object.entries(specs)) {
  const out = path.join(dir, `${name}.wav`);
  fs.writeFileSync(out, wav(synth(notes)));
  console.log(`gen ${out}`);
}
