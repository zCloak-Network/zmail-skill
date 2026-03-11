import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, loadPemUserFromFile } from './identity.mjs';
import { resolveClientHome } from './runtime-paths.mjs';

const registryVersion = 1;
const legacyWorkspaceDirs = ['.zmail', 'zmail'];

function defaultRegistry() {
  return {
    version: registryVersion,
    default: null,
    identities: {}
  };
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  return resolveClientHome(cwd);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingWorkspaceRoot(cwd = process.cwd()) {
  const preferred = resolveWorkspaceRoot(cwd);
  if (await pathExists(preferred)) {
    return preferred;
  }
  for (const legacyDir of legacyWorkspaceDirs) {
    const candidate = path.join(cwd, legacyDir);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return preferred;
}

export function resolveRegistryPath(cwd = process.cwd()) {
  return path.join(resolveWorkspaceRoot(cwd), 'config', 'identities.json');
}

export async function loadIdentityRegistry(cwd = process.cwd()) {
  const workspaceRoot = await resolveExistingWorkspaceRoot(cwd);
  const registryPath = path.join(workspaceRoot, 'config', 'identities.json');
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid_identity_registry');
    }
    const identities = parsed.identities;
    return {
      version: Number(parsed.version) || registryVersion,
      default: typeof parsed.default === 'string' ? parsed.default : null,
      identities: identities && typeof identities === 'object' ? identities : {}
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return defaultRegistry();
    }
    throw error;
  }
}

export async function saveIdentityRegistry(registry, cwd = process.cwd()) {
  const registryPath = resolveRegistryPath(cwd);
  await ensureDir(path.dirname(registryPath));
  const payload = {
    version: registryVersion,
    default: registry.default ?? null,
    identities: registry.identities ?? {}
  };
  const tempPath = `${registryPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tempPath, registryPath);
  return registryPath;
}

function isAllowedAiNameChar(char) {
  return (
    (char >= 'a' && char <= 'z')
    || (char >= '0' && char <= '9')
    || char === '-'
  );
}

export function validateAiName(aiName) {
  if (aiName === undefined || aiName === null || aiName === '') {
    return { ok: true, value: null };
  }
  if (typeof aiName !== 'string') {
    return { ok: false, reason: 'ai_name_must_be_string' };
  }
  const trimmed = aiName.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  for (const char of trimmed) {
    if (!isAllowedAiNameChar(char)) {
      return { ok: false, reason: 'ai_name_must_use_lowercase_letters_numbers_or_dash' };
    }
  }
  return { ok: true, value: trimmed };
}

function validateAlias(alias) {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    throw new Error('alias_required');
  }
  const trimmed = alias.trim();
  for (const char of trimmed) {
    if (!isAllowedAiNameChar(char)) {
      throw new Error('alias_must_use_lowercase_letters_numbers_or_dash');
    }
  }
  return trimmed;
}

export async function addIdentityRecord({ alias, pemPath, aiName, makeDefault = false }, cwd = process.cwd()) {
  const normalizedAlias = validateAlias(alias);
  if (typeof pemPath !== 'string' || pemPath.trim().length === 0) {
    throw new Error('pem_path_required');
  }
  const aiNameValidation = validateAiName(aiName);
  if (!aiNameValidation.ok) {
    throw new Error(aiNameValidation.reason);
  }

  const registry = await loadIdentityRegistry(cwd);
  if (registry.identities[normalizedAlias]) {
    throw new Error('identity_alias_exists');
  }

  const user = await loadPemUserFromFile(normalizedAlias, pemPath.trim());
  registry.identities[normalizedAlias] = {
    pem_path: user.file_path,
    ai_id: user.ai_id,
    ai_name: aiNameValidation.value
  };

  if (makeDefault || !registry.default) {
    registry.default = normalizedAlias;
  }

  const registryPath = await saveIdentityRegistry(registry, cwd);
  return {
    alias: normalizedAlias,
    identity: registry.identities[normalizedAlias],
    default: registry.default,
    registry_path: registryPath
  };
}

export async function useIdentityAlias(alias, cwd = process.cwd()) {
  const normalizedAlias = validateAlias(alias);
  const registry = await loadIdentityRegistry(cwd);
  if (!registry.identities[normalizedAlias]) {
    throw new Error('identity_alias_not_found');
  }
  registry.default = normalizedAlias;
  const registryPath = await saveIdentityRegistry(registry, cwd);
  return {
    alias: normalizedAlias,
    identity: registry.identities[normalizedAlias],
    default: registry.default,
    registry_path: registryPath
  };
}

export async function updateIdentityRecord({ alias, pemPath, aiName, makeDefault = false }, cwd = process.cwd()) {
  const normalizedAlias = validateAlias(alias);
  const registry = await loadIdentityRegistry(cwd);
  const existing = registry.identities[normalizedAlias];
  if (!existing) {
    throw new Error('identity_alias_not_found');
  }

  const nextPemPath = typeof pemPath === 'string' && pemPath.trim().length > 0
    ? pemPath.trim()
    : existing.pem_path;
  const user = await loadPemUserFromFile(normalizedAlias, nextPemPath);

  let nextAiName = existing.ai_name ?? null;
  if (aiName !== undefined) {
    const aiNameValidation = validateAiName(aiName);
    if (!aiNameValidation.ok) {
      throw new Error(aiNameValidation.reason);
    }
    nextAiName = aiNameValidation.value;
  }

  registry.identities[normalizedAlias] = {
    pem_path: user.file_path,
    ai_id: user.ai_id,
    ai_name: nextAiName
  };

  if (makeDefault) {
    registry.default = normalizedAlias;
  }

  const registryPath = await saveIdentityRegistry(registry, cwd);
  return {
    alias: normalizedAlias,
    identity: registry.identities[normalizedAlias],
    default: registry.default,
    registry_path: registryPath
  };
}

export async function removeIdentityRecord(alias, { force = false } = {}, cwd = process.cwd()) {
  const normalizedAlias = validateAlias(alias);
  const registry = await loadIdentityRegistry(cwd);
  const existing = registry.identities[normalizedAlias];
  if (!existing) {
    throw new Error('identity_alias_not_found');
  }

  const aliases = Object.keys(registry.identities);
  if (aliases.length === 1 && !force) {
    throw new Error('cannot_remove_last_identity_without_force');
  }

  delete registry.identities[normalizedAlias];

  if (registry.default === normalizedAlias) {
    const remainingAliases = Object.keys(registry.identities).sort();
    registry.default = remainingAliases[0] ?? null;
  }

  const registryPath = await saveIdentityRegistry(registry, cwd);
  return {
    alias: normalizedAlias,
    removed: true,
    default: registry.default,
    registry_path: registryPath
  };
}

export async function listIdentityRecords(cwd = process.cwd()) {
  const registry = await loadIdentityRegistry(cwd);
  return {
    default: registry.default,
    identities: Object.entries(registry.identities).map(([alias, record]) => ({
      alias,
      ...record
    }))
  };
}

export async function resolveIdentityAlias(alias, cwd = process.cwd()) {
  const registry = await loadIdentityRegistry(cwd);
  const record = registry.identities[alias];
  if (!record) {
    return null;
  }
  return {
    alias,
    pemPath: record.pem_path,
    aiId: record.ai_id,
    aiName: record.ai_name ?? null,
    isDefault: registry.default === alias
  };
}

export async function getCurrentIdentity(cwd = process.cwd()) {
  const registry = await loadIdentityRegistry(cwd);
  if (!registry.default) {
    return null;
  }
  const record = registry.identities[registry.default];
  if (!record) {
    return null;
  }
  return {
    alias: registry.default,
    pemPath: record.pem_path,
    aiId: record.ai_id,
    aiName: record.ai_name ?? null,
    isDefault: true
  };
}
