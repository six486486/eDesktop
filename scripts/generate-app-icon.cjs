const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const outputDirectory = path.join(__dirname, '..', 'assets')
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const trayIconSizes = [16, 20, 24, 32]

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  return value >>> 0
})

const crc32 = (buffer) => {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const typeBuffer = Buffer.from(type, 'ascii')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([size, typeBuffer, data, checksum])
}

const encodePng = (width, height, pixels) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    rows[rowOffset] = 0
    pixels.copy(rows, rowOffset + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND'),
  ])
}

const blend = (base, overlay) => {
  const alpha = overlay[3] / 255
  const baseAlpha = base[3] / 255
  const outputAlpha = alpha + baseAlpha * (1 - alpha)
  if (!outputAlpha) return [0, 0, 0, 0]
  return [
    Math.round((overlay[0] * alpha + base[0] * baseAlpha * (1 - alpha)) / outputAlpha),
    Math.round((overlay[1] * alpha + base[1] * baseAlpha * (1 - alpha)) / outputAlpha),
    Math.round((overlay[2] * alpha + base[2] * baseAlpha * (1 - alpha)) / outputAlpha),
    Math.round(outputAlpha * 255),
  ]
}

const mix = (start, end, amount) => Math.round(start + (end - start) * Math.max(0, Math.min(1, amount)))

const mixColor = (start, end, amount, alpha = 255) => [
  mix(start[0], end[0], amount),
  mix(start[1], end[1], amount),
  mix(start[2], end[2], amount),
  alpha,
]

const roundedRectDistance = (x, y, left, top, right, bottom, radius) => {
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  const halfWidth = (right - left) / 2
  const halfHeight = (bottom - top) / 2
  const offsetX = Math.abs(x - centerX) - (halfWidth - radius)
  const offsetY = Math.abs(y - centerY) - (halfHeight - radius)
  return Math.hypot(Math.max(offsetX, 0), Math.max(offsetY, 0))
    + Math.min(Math.max(offsetX, offsetY), 0)
    - radius
}

const paintRoundedRect = (color, x, y, bounds, fill, border = null, borderWidth = 1.5) => {
  const [left, top, right, bottom, radius] = bounds
  const distance = roundedRectDistance(x, y, left, top, right, bottom, radius)
  if (distance <= 0) color = blend(color, typeof fill === 'function' ? fill(x, y) : fill)
  if (border && distance <= 0 && distance >= -borderWidth) color = blend(color, border)
  return color
}

const paintShadow = (color, x, y, bounds, offsetY, spread, shadowColor) => {
  const [left, top, right, bottom, radius] = bounds
  const distance = roundedRectDistance(x, y - offsetY, left, top, right, bottom, radius)
  if (distance <= 0 || distance > spread) return color
  const strength = (1 - distance / spread) ** 2
  return blend(color, [...shadowColor.slice(0, 3), Math.round(shadowColor[3] * strength)])
}

const iconColorAt = (x, y) => {
  let color = [0, 0, 0, 0]

  const baseBounds = [18, 18, 238, 238, 52]
  const backPaneBounds = [91, 56, 208, 179, 28]
  const frontPaneBounds = [49, 79, 190, 220, 31]

  color = paintShadow(color, x, y, baseBounds, 7, 13, [20, 54, 112, 68])
  color = paintRoundedRect(
    color,
    x,
    y,
    baseBounds,
    (sampleX, sampleY) => {
      const amount = ((sampleX - 18) * 0.42 + (sampleY - 18) * 0.58) / 220
      return mixColor([105, 203, 255], [39, 89, 201], amount)
    },
    [255, 255, 255, 130],
  )

  const shine = ((x - 70) / 148) ** 2 + ((y - 18) / 78) ** 2
  if (shine <= 1 && roundedRectDistance(x, y, ...baseBounds) <= 0) {
    color = blend(color, [255, 255, 255, Math.round((1 - shine) * 56)])
  }

  color = paintShadow(color, x, y, backPaneBounds, 6, 10, [17, 47, 112, 82])
  color = paintRoundedRect(
    color,
    x,
    y,
    backPaneBounds,
    (_sampleX, sampleY) => mixColor([56, 125, 225], [25, 66, 164], (sampleY - 56) / 123, 236),
    [255, 255, 255, 82],
  )

  color = paintShadow(color, x, y, frontPaneBounds, 7, 11, [12, 42, 103, 92])
  color = paintRoundedRect(
    color,
    x,
    y,
    frontPaneBounds,
    (_sampleX, sampleY) => mixColor([252, 254, 255], [210, 235, 253], (sampleY - 79) / 141, 248),
    [255, 255, 255, 230],
  )

  color = paintRoundedRect(
    color,
    x,
    y,
    [72, 101, 136, 114, 6.5],
    (sampleX) => mixColor([43, 105, 208], [100, 189, 248], (sampleX - 72) / 64),
    [255, 255, 255, 80],
  )

  const tileBounds = [
    [72, 129, 111, 160, 8, [104, 201, 255], [47, 119, 224]],
    [121, 129, 160, 160, 8, [238, 249, 255], [178, 219, 249]],
    [72, 170, 111, 201, 8, [218, 241, 255], [139, 199, 242]],
    [121, 170, 160, 201, 8, [70, 148, 236], [37, 91, 193]],
  ]
  for (const [left, top, right, bottom, radius, start, end] of tileBounds) {
    color = paintShadow(color, x, y, [left, top, right, bottom, radius], 2, 4, [34, 82, 151, 34])
    color = paintRoundedRect(
      color,
      x,
      y,
      [left, top, right, bottom, radius],
      (_sampleX, sampleY) => mixColor(start, end, (sampleY - top) / (bottom - top), 250),
      [255, 255, 255, 125],
    )
  }

  return color
}

// Windows renders shell, taskbar, and notification-area icons at only 16-64 physical
// pixels. The full acrylic artwork is too detailed at those sizes, so use a
// pixel-hinted, high-contrast variant instead of shrinking the 256px artwork.
const smallIconColorAt = (x, y, size) => {
  let color = [0, 0, 0, 0]
  const scale = (value) => Math.round((value / 256) * size)
  const baseBounds = [
    Math.max(1, scale(18)),
    Math.max(1, scale(18)),
    size - Math.max(1, scale(18)),
    size - Math.max(1, scale(18)),
    Math.max(3, scale(52)),
  ]
  const borderWidth = size <= 20 ? 0.7 : 0.9
  color = paintRoundedRect(
    color,
    x,
    y,
    baseBounds,
    (_sampleX, sampleY) => mixColor([77, 178, 246], [35, 91, 205], (sampleY - 1) / (size - 2)),
    [219, 242, 255, 210],
    borderWidth,
  )

  const backPaneBounds = [
    scale(91),
    scale(56),
    scale(208),
    scale(179),
    Math.max(1.5, scale(28)),
  ]
  color = paintRoundedRect(
    color,
    x,
    y,
    backPaneBounds,
    (_sampleX, sampleY) => mixColor([52, 126, 228], [27, 70, 171], (sampleY - backPaneBounds[1]) / (backPaneBounds[3] - backPaneBounds[1]), 248),
    [203, 231, 255, 165],
    borderWidth,
  )

  const frontPaneBounds = [
    scale(49),
    scale(79),
    scale(190),
    scale(220),
    Math.max(1.5, scale(31)),
  ]
  color = paintRoundedRect(
    color,
    x,
    y,
    frontPaneBounds,
    [247, 252, 255, 255],
    [255, 255, 255, 235],
    borderWidth,
  )

  color = paintRoundedRect(
    color,
    x,
    y,
    [scale(72), scale(101), scale(136), scale(101) + Math.max(1, scale(13)), Math.max(0.6, scale(6))],
    [43, 116, 220, 255],
  )

  const tileLeft = scale(72)
  const tileTop = scale(129)
  const tileSize = Math.max(2, scale(39))
  const tileGapX = Math.max(1, scale(10))
  const tileGapY = Math.max(1, scale(10))
  const secondLeft = tileLeft + tileSize + tileGapX
  const secondTop = tileTop + tileSize + tileGapY
  const cellRadius = size <= 20 ? 0.75 : Math.max(1, scale(8))
  const cells = [
    [tileLeft, tileTop, tileLeft + tileSize, tileTop + tileSize, [38, 111, 220, 255]],
    [secondLeft, tileTop, secondLeft + tileSize, tileTop + tileSize, [100, 197, 247, 255]],
    [tileLeft, secondTop, tileLeft + tileSize, secondTop + tileSize, [105, 201, 247, 255]],
    [secondLeft, secondTop, secondLeft + tileSize, secondTop + tileSize, [34, 91, 204, 255]],
  ]
  for (const [left, top, right, bottom, fill] of cells) {
    color = paintRoundedRect(color, x, y, [left, top, right, bottom, cellRadius], fill)
  }
  return color
}

const renderIcon = (size) => {
  const pixels = Buffer.alloc(size * size * 4)
  const samples = 4
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0]
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const physicalX = x + (sampleX + 0.5) / samples
          const physicalY = y + (sampleY + 0.5) / samples
          const color = size <= 64
            ? smallIconColorAt(physicalX, physicalY, size)
            : iconColorAt((physicalX / size) * 256, (physicalY / size) * 256)
          for (let channel = 0; channel < 4; channel += 1) totals[channel] += color[channel]
        }
      }
      const offset = (y * size + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[offset + channel] = Math.round(totals[channel] / (samples * samples))
      }
    }
  }
  return encodePng(size, size, pixels)
}

const encodeIco = (entries) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach(({ size, png }, index) => {
    const entryOffset = index * 16
    directory[entryOffset] = size >= 256 ? 0 : size
    directory[entryOffset + 1] = size >= 256 ? 0 : size
    directory.writeUInt16LE(1, entryOffset + 4)
    directory.writeUInt16LE(32, entryOffset + 6)
    directory.writeUInt32LE(png.length, entryOffset + 8)
    directory.writeUInt32LE(offset, entryOffset + 12)
    offset += png.length
  })
  return Buffer.concat([header, directory, ...entries.map(({ png }) => png)])
}

fs.mkdirSync(outputDirectory, { recursive: true })
const entries = iconSizes.map((size) => ({ size, png: renderIcon(size) }))
fs.writeFileSync(path.join(outputDirectory, 'app-icon.png'), entries.at(-1).png)
fs.writeFileSync(path.join(outputDirectory, 'app-icon.ico'), encodeIco(entries))
for (const size of trayIconSizes) {
  fs.writeFileSync(path.join(outputDirectory, `app-icon-${size}.png`), entries.find((entry) => entry.size === size).png)
}
console.log(`[icon] generated ${entries.length} ICO sizes and ${trayIconSizes.length} DPI-aware tray PNGs`)
