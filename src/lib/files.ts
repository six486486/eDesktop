import {
  Archive,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import type { DesktopFile } from '../types'

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'psd', 'ai', 'sketch'])
const documentExtensions = new Set(['doc', 'docx', 'pdf', 'txt', 'md', 'rtf'])
const sheetExtensions = new Set(['xls', 'xlsx', 'csv'])
const presentationExtensions = new Set(['ppt', 'pptx', 'key'])
const videoExtensions = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm'])
const archiveExtensions = new Set(['zip', 'rar', '7z', 'tar', 'gz'])
const codeExtensions = new Set(['js', 'ts', 'tsx', 'jsx', 'html', 'css', 'json', 'py', 'java', 'cpp', 'c'])

export function iconForFile(file: DesktopFile): LucideIcon {
  if (file.isDirectory || file.extension === 'folder') return Folder
  if (imageExtensions.has(file.extension)) return FileImage
  if (sheetExtensions.has(file.extension)) return FileSpreadsheet
  if (presentationExtensions.has(file.extension)) return Presentation
  if (videoExtensions.has(file.extension)) return FileVideo2
  if (archiveExtensions.has(file.extension)) return FileArchive
  if (codeExtensions.has(file.extension)) return FileCode2
  if (documentExtensions.has(file.extension)) return FileText
  if (file.extension === 'lnk') return Archive
  return File
}

export function displayFileName(file: DesktopFile) {
  if (file.isDirectory || file.shellClsid) return file.name
  const extension = file.extension.trim().replace(/^\./, '')
  if (!extension) return file.name
  const suffix = `.${extension}`
  if (!file.name.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())) return file.name
  return file.name.slice(0, -suffix.length) || file.name
}
