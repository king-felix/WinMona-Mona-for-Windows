import { z } from 'zod';
import { ProjectId, TaskId } from './ids.js';

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');

export const GitState = z
  .object({
    isRepository: z.boolean(),
    branch: z.string().min(1).nullable(),
    head: z.string().min(1).nullable(),
    dirty: z.boolean().nullable(),
  })
  .strict();
export type GitState = z.infer<typeof GitState>;

/** A catalog entry. The source folder is canonical; deleting a entry never deletes it. */
export const Project = z
  .object({
    id: ProjectId,
    label: z.string().min(1).max(120),
    canonicalPath: z.string().min(1),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    pinned: z.boolean(),
    archived: z.boolean(),
    git: GitState,
  })
  .strict();
export type Project = z.infer<typeof Project>;

export const TaskStatus = z.enum(['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ProjectTask = z
  .object({
    id: TaskId,
    projectId: ProjectId,
    title: z.string().min(1).max(200),
    status: TaskStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type ProjectTask = z.infer<typeof ProjectTask>;
