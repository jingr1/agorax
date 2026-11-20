
export const MAX_ATTACHMENT_FILE_SIZE = 50 * 1024 * 1024

export const MAX_IMAGE_DIMENSION = 1920

export const IMAGE_QUALITY = 0.85

export const MAX_TRANSPORT_IMAGE_SIZE = 1 * 1024 * 1024

export const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export const TEXT_EXTENSION_TO_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  py: 'text/plain',
}

export function normalizeMimeType(value: string): string {
  return value.trim().toLowerCase()
}

export function isImageMimeType(value: string): boolean {
  const normalized = normalizeMimeType(value)
  return normalized.startsWith('image/')
}

export function inferImageMimeTypeFromFileName(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim())
  if (!match?.[1]) return ''
  return IMAGE_EXTENSION_TO_MIME[match[1].toLowerCase()] || ''
}

export function inferTextMimeTypeFromFileName(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim())
  if (!match?.[1]) return ''
  return TEXT_EXTENSION_TO_MIME[match[1].toLowerCase()] || ''
}

export function isTextMimeType(value: string): boolean {
  const normalized = normalizeMimeType(value)
  return normalized.startsWith('text/') || normalized === 'application/json'
}

export function isImageFile(file: File): boolean {
  if (isImageMimeType(file.type)) return true
  return inferImageMimeTypeFromFileName(file.name).length > 0
}

export function isTextFile(file: File): boolean {
  if (isTextMimeType(file.type)) return true
  return inferTextMimeTypeFromFileName(file.name).length > 0
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = size
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

export function hasAttachableData(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const items = Array.from(dt.items)
  if (
    items.some(
      (item) =>
        item.kind === 'file' &&
        (isImageMimeType(item.type) ||
          isTextMimeType(item.type) ||
          item.type.trim().length === 0),
    )
  )
    return true
  const files = Array.from(dt.files)
  return files.some(
    (file) =>
      isImageFile(file) || isTextFile(file) || file.type.trim().length === 0,
  )
}

export function collectFilesFromDataTransfer(dt: DataTransfer | null): Array<File> {
  if (!dt) return []
  const files: Array<File> = []
  const seen = new Set<string>()

  const pushFile = (file: File | null) => {
    if (!file) return
    const key = `${file.name}:${file.size}:${file.lastModified}:${file.type}`
    if (seen.has(key)) return
    seen.add(key)
    files.push(file)
  }

  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue
    pushFile(item.getAsFile())
  }

  for (const file of Array.from(dt.files)) {
    pushFile(file)
  }

  return files
}

export async function readFileAsDataUrl(file: File): Promise<string | null> {
  return await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export async function readFileAsText(file: File): Promise<string | null> {
  return await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsText(file)
  })
}

export function isCanvasSupported(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('2d'))
  } catch {
    return false
  }
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
  if (!base64) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function readDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;]+);base64,/.exec(dataUrl)
  return match?.[1]?.trim() || null
}

export async function compressImageToDataUrl(file: File): Promise<string> {
  if (!isCanvasSupported()) {
    throw new Error('Image compression not available')
  }

  return await new Promise((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)
    const cleanup = () => URL.revokeObjectURL(objectUrl)

    image.onload = () => {
      try {
        let width = image.width
        let height = image.height

        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          if (width > height) {
            height = Math.round((height * MAX_IMAGE_DIMENSION) / width)
            width = MAX_IMAGE_DIMENSION
          } else {
            width = Math.round((width * MAX_IMAGE_DIMENSION) / height)
            height = MAX_IMAGE_DIMENSION
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          cleanup()
          reject(new Error('Failed to get canvas context'))
          return
        }

        context.drawImage(image, 0, 0, width, height)

        let quality = IMAGE_QUALITY
        let dataUrl = canvas.toDataURL('image/jpeg', quality)
        let bytes = estimateDataUrlBytes(dataUrl)

        while (bytes > MAX_TRANSPORT_IMAGE_SIZE && quality > 0.4) {
          quality -= 0.08
          dataUrl = canvas.toDataURL('image/jpeg', quality)
          bytes = estimateDataUrlBytes(dataUrl)
        }

        cleanup()
        resolve(dataUrl)
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error('Compression failed'))
      }
    }

    image.onerror = () => {
      cleanup()
      reject(new Error('Failed to load image'))
    }

    image.src = objectUrl
  })
}
