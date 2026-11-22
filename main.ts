// Tiny stack VM for make.fun tiny-stack-vm-01 (ISA v1, kit program/generator/subject/ISA.md):
// runs each /input/<id>/program.bin on its input.bin, writes /output/<id>/stdout.bin and
// exit.txt. Full ISA: wrapping 32-bit arithmetic, 256-value stack, 64-deep calls, 256 words
// of memory, all ten traps, step/output limits. Pure and deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_MAX = 65536;
const STEP_MAX = 1000000;

// Runs one program: what it wrote and its exit code (a trap's code included).
// Step order is ISA.md's: step limit, pc in range, known opcode, immediate fits,
// count the step, stack needs, then the instruction's own traps and effect.
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const D = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(OUT_MAX);
  let sp = 0, cp = 0, pc = 0, ip = 0, ol = 0, st = 0;
  const n = p.length;
  const done = (code: number) => ({ out: out.subarray(0, ol), code });
  for (;;) {
    if (st === STEP_MAX) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = p[pc];
    let im = 0, po = 0, pu = 0; // immediate bytes, pops, pushes
    switch (op) {
      case 0x00: break; // HALT
      case 0x01: im = 1; pu = 1; break; // PUSH8
      case 0x02: im = 4; pu = 1; break; // PUSH32
      case 0x03: po = 1; break;
      case 0x04: po = 1; pu = 2; break;
      case 0x05: po = 2; pu = 2; break;
      case 0x06: po = 2; pu = 3; break;
      case 0x07: po = 3; pu = 3; break;
      case 0x17: case 0x1b: po = 1; pu = 1; break; // NEG, NOT
      case 0x30: case 0x33: im = 2; break; // JMP, CALL
      case 0x31: case 0x32: im = 2; po = 1; break; // JZ, JNZ
      case 0x34: break; // RET
      case 0x40: po = 1; pu = 1; break; // LOAD
      case 0x41: po = 2; break; // STORE
      case 0x50: case 0x51: case 0x53: po = 1; break; // PRINT, PUTC, EXIT
      case 0x52: pu = 1; break; // IN
      default:
        if (op < 0x10 || op > 0x22 || op === 0x1f) return done(5); // 0x1f names no opcode
        po = 2; pu = 1;
    }
    if (pc + im >= n) return done(9);
    st++;
    const nx = pc + 1 + im;
    if (sp < po) return done(2);
    if (sp - po + pu > 256) return done(3);
    pc = nx;
    switch (op) {
      case 0x00: return done(0);
      case 0x01: D[sp++] = (p[nx - 1] << 24) >> 24; break;
      case 0x02: D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break;
      case 0x03: sp--; break;
      case 0x04: D[sp] = D[sp - 1]; sp++; break;
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; }
      case 0x06: D[sp] = D[sp - 2]; sp++; break;
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; }
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break;
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel; // unchecked target traps 9 at the next step
        break;
      }
      case 0x33:
        if (cp === 64) return done(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: {
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: {
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: {
        const s = String(D[sp - 1]);
        if (ol + s.length > OUT_MAX) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (ol + 1 > OUT_MAX) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break;
      case 0x53: return done(D[--sp] & 255);
      default: {
        // Two-operand ops 0x10-0x22; a is below b; every result wraps to 32 bits.
        const b = D[sp - 1], a = D[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { if (b === 0) return done(4); r = (a / b) | 0; } // |0 wraps -2147483648 / -1 to itself
        else if (op === 0x14) { if (b === 0) return done(4); r = (a % b) | 0; } // sign of a; x % -1 is 0
        else if (op === 0x15) { if (b === 0) return done(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { if (b === 0) return done(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31); // only the low 5 bits of the shift count
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  let prog = new Uint8Array(0);
  let inp = new Uint8Array(0);
  try { prog = new Uint8Array(readFileSync(join(I, id, 'program.bin'))); } catch { /* no program: empty, traps 9 */ }
  try { inp = new Uint8Array(readFileSync(join(I, id, 'input.bin'))); } catch { /* no input: empty */ }
  const r = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
