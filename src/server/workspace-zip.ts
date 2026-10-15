import fs from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

export const MAX_FOLDER_ZIP_FILES = 5_000
export const MAX_FOLDER_ZIP_BYTES = 512 * 1024 * 1024

type ZipEntry = {
  name: string
  data: Buffer
  crc: number
  compressed: Buffer
  method: number
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(n: number) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

export async function zipLocalFolder(folderPath: string): Promise<Buffer> {
  const root = await fs.realpath(folderPath)
  const st = await fs.stat(root)
  if (!st.isDirectory()) {
    throw new Error('path must be a directory')
  }

  const files: Array<{ abs: string; arc: string }> = []
  const state = { files: 0, bytes: 0 }

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      let real: string
      try {
        real = await fs.realpath(abs)
      } catch {
        continue
      }
      const relCheck = path.relative(root, real)
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const info = await fs.stat(abs)
      state.files += 1
      state.bytes += info.size
      if (state.files > MAX_FOLDER_ZIP_FILES) {
        throw Object.assign(new Error('too many files'), {
          code: 'MAX_FILES',
          limit: MAX_FOLDER_ZIP_FILES,
        })
      }
      if (state.bytes > MAX_FOLDER_ZIP_BYTES) {
        throw Object.assign(new Error('folder too large'), {
          code: 'MAX_BYTES',
          limit: MAX_FOLDER_ZIP_BYTES,
        })
      }
      files.push({
        abs,
        arc: path.relative(root, abs).split(path.sep).join('/'),
      })
    }
  }
  await walk(root)

  const zipEntries: Array<ZipEntry> = []
  for (const file of files) {
    const data = await fs.readFile(file.abs)
    const compressed = deflateRawSync(data)
    zipEntries.push({
      name: file.arc || path.basename(file.abs),
      data,
      crc: crc32(data),
      compressed,
      method: 8,
    })
  }

  const parts: Array<Buffer> = []
  const central: Array<Buffer> = []
  let offset = 0
  for (const entry of zipEntries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(entry.method),
      u16(0),
      u16(0),
      u32(entry.crc),
      u32(entry.compressed.length),
      u32(entry.data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      entry.compressed,
    ])
    const centralHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0),
      u16(entry.method),
      u16(0),
      u16(0),
      u32(entry.crc),
      u32(entry.compressed.length),
      u32(entry.data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ])
    parts.push(local)
    central.push(centralHeader)
    offset += local.length
  }
  const centralDir = Buffer.concat(central)
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(zipEntries.length),
    u16(zipEntries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...parts, centralDir, end])
}
