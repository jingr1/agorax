import fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCollabDbPath } from '../collab-db'
import {
  hashSkillTree,
  normalizeSkillFilePath,
  readSkillMarker,
  readSkillTree,
  recoverSkillTree,
  writeSkillTree,
} from './skill-tree'
import type { SkillTree } from './skill-tree'
import type { SkillDeploymentMode } from './types'

export function skillWorkingDirectory(skillId: string): string {
  const segment = normalizeSkillFilePath(skillId)
  if (segment.includes('/')) throw new Error('Invalid skill identifier')
  return path.join(
    path.dirname(getCollabDbPath()),
    'platform-skills',
    'library',
    segment,
  )
}

export function skillPathExists(directory: string): boolean {
  try {
    fs.lstatSync(directory)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function isOwnedSkillLink(directory: string, skillId: string): boolean {
  if (!skillPathExists(directory) || !fs.lstatSync(directory).isSymbolicLink())
    return false
  const destination = fs.readlinkSync(directory)
  const resolved = path.resolve(path.dirname(directory), destination)
  return path.relative(resolved, skillWorkingDirectory(skillId)) === ''
}

export function readSkillDeployment(
  directory: string,
  skillId: string,
): SkillTree {
  if (fs.lstatSync(directory).isSymbolicLink()) {
    if (!isOwnedSkillLink(directory, skillId))
      throw new Error('Foreign skill link was preserved')
    directory = skillWorkingDirectory(skillId)
  }
  return readSkillTree(directory)
}

export function removeSkillDeployment(
  directory: string,
  skillId: string,
): boolean {
  if (!skillPathExists(directory)) return true
  if (fs.lstatSync(directory).isSymbolicLink()) {
    if (!isOwnedSkillLink(directory, skillId)) return false
    if (process.platform === 'win32') fs.rmdirSync(directory)
    else fs.unlinkSync(directory)
    return true
  }
  const marker = readSkillMarker(directory)
  if (
    marker?.skillId !== skillId ||
    hashSkillTree(readSkillTree(directory)) !== marker.baseHash
  )
    return false
  fs.rmSync(directory, { recursive: true })
  return true
}

export function recoverSkillDeployment(
  directory: string,
  skillId: string,
): void {
  const backup = `${directory}.agorax-backup`
  if (!skillPathExists(backup)) return
  if (fs.lstatSync(backup).isSymbolicLink()) {
    if (!isOwnedSkillLink(backup, skillId))
      throw new Error('Pending recovery link has an unknown owner')
    if (!skillPathExists(directory)) fs.renameSync(backup, directory)
    else {
      const marker = readSkillMarker(directory)
      if (!isOwnedSkillLink(directory, skillId) && marker?.skillId !== skillId)
        throw new Error('Pending recovery conflicts with an external path')
      removeSkillDeployment(backup, skillId)
    }
    return
  }
  if (isOwnedSkillLink(directory, skillId)) {
    const marker = readSkillMarker(backup)
    const hash = hashSkillTree(readSkillTree(backup))
    if (
      marker?.skillId !== skillId ||
      (hash !== marker.baseHash &&
        hash !== hashSkillTree(readSkillDeployment(directory, skillId)))
    )
      throw new Error('Pending backup contains unpublished edits')
    fs.rmSync(backup, { recursive: true })
    return
  }
  recoverSkillTree(directory, skillId)
}

export function deploySkillTree(
  directory: string,
  skillId: string,
  tree: SkillTree,
  input: {
    mode: SkillDeploymentMode
    allowCopyFallback: boolean
    expectedHash?: string
  },
): { actualMode: SkillDeploymentMode; message?: string } {
  const source = skillWorkingDirectory(skillId)
  const linked = isOwnedSkillLink(directory, skillId)
  if (input.mode === 'symlink' && linked) return { actualMode: 'symlink' }
  const exists = skillPathExists(directory)
  if (exists) {
    if (fs.lstatSync(directory).isSymbolicLink() && !linked)
      throw new Error('Foreign skill link was preserved')
    if (
      input.expectedHash === undefined ||
      hashSkillTree(readSkillDeployment(directory, skillId)) !==
        input.expectedHash
    )
      throw new Error('Skill changed during synchronization')
    if (!linked) {
      const marker = readSkillMarker(directory)
      if (marker && marker.skillId !== skillId)
        throw new Error('Skill deployment identity mismatch')
      if (
        !marker &&
        fs
          .readFileSync(path.join(directory, '.agorax-platform-skill'), 'utf8')
          .trim() !== '1'
      )
        throw new Error('Unmanaged skill directory was preserved')
    }
  } else if (input.expectedHash !== undefined)
    throw new Error('Skill disappeared during synchronization')
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  const staging = `${directory}.agorax-link-${randomUUID()}`
  const backup = `${directory}.agorax-backup`
  if (skillPathExists(backup))
    throw new Error('Pending skill deployment recovery')
  let actualMode = input.mode
  let message: string | undefined
  try {
    if (input.mode === 'symlink') {
      try {
        try {
          fs.symlinkSync(source, staging, 'dir')
        } catch (error) {
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error
          fs.symlinkSync(source, staging, 'junction')
        }
      } catch (error) {
        if (
          !input.allowCopyFallback ||
          !['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        actualMode = 'copy'
        message = `Symlink unavailable (${(error as NodeJS.ErrnoException).code}); deployed Copy instead`
      }
    }
    if (actualMode === 'copy') {
      if (!linked) {
        const hash = hashSkillTree(tree)
        if (
          exists &&
          input.expectedHash === hash &&
          readSkillMarker(directory)?.baseHash === hash
        )
          return { actualMode, message }
        writeSkillTree(directory, skillId, tree, input.expectedHash)
        return { actualMode, message }
      }
      writeSkillTree(staging, skillId, tree)
    }
    if (exists) {
      if (
        hashSkillTree(readSkillDeployment(directory, skillId)) !==
        input.expectedHash
      )
        throw new Error('Skill changed during synchronization')
      fs.renameSync(directory, backup)
    }
    try {
      fs.renameSync(staging, directory)
    } catch (error) {
      if (skillPathExists(backup) && !skillPathExists(directory))
        fs.renameSync(backup, directory)
      throw error
    }
    if (skillPathExists(backup)) {
      if (fs.lstatSync(backup).isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(backup)
        else fs.unlinkSync(backup)
      } else fs.rmSync(backup, { recursive: true })
    }
    return { actualMode, message }
  } finally {
    if (skillPathExists(staging)) {
      if (fs.lstatSync(staging).isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(staging)
        else fs.unlinkSync(staging)
      } else fs.rmSync(staging, { recursive: true })
    }
  }
}
