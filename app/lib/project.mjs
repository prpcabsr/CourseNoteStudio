// 项目（一节课的任务）存储：目录结构、状态、断点续跑。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR } from './paths.mjs';

export function projectDir(id) {
  return path.join(PROJECTS_DIR, id);
}

export function projectPaths(id) {
  const dir = projectDir(id);
  return {
    dir,
    media: path.join(dir, 'media'),
    work: path.join(dir, 'work'),
    figures: path.join(dir, 'figures'),
    out: path.join(dir, 'out'),
    state: path.join(dir, 'state.json'),
  };
}

export function createProject({ input, options, title }) {
  const id = 'p' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const p = projectPaths(id);
  for (const d of [p.media, p.work, p.figures, p.out]) fs.mkdirSync(d, { recursive: true });
  const state = {
    id,
    title: title || '',
    input,
    options: options || {},
    stage: 'created',
    stages: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
  saveState(id, state);
  return state;
}

export function loadState(id) {
  const p = projectPaths(id);
  try {
    return JSON.parse(fs.readFileSync(p.state, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(id, state) {
  const p = projectPaths(id);
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.state, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function patchState(id, patch) {
  const s = loadState(id) || { id };
  const next = { ...s, ...patch, stages: { ...(s.stages || {}), ...(patch.stages || {}) } };
  return saveState(id, next);
}

export function listProjects() {
  let ids = [];
  try {
    ids = fs.readdirSync(PROJECTS_DIR).filter((d) => d.startsWith('p'));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const s = loadState(id);
    if (!s) continue;
    const p = projectPaths(id);
    let pdf = null;
    try {
      const f = fs.readdirSync(p.out).find((x) => x.endsWith('.pdf'));
      if (f) pdf = path.join(p.out, f);
    } catch {}
    out.push({ ...s, hasPdf: !!pdf, pdfFile: pdf ? path.basename(pdf) : null });
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

export function deleteProject(id) {
  const p = projectPaths(id);
  fs.rmSync(p.dir, { recursive: true, force: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
