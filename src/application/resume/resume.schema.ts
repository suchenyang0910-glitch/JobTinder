import { z } from 'zod';

export const ResumeExperienceZod = z.object({
  company: z.string().max(256).nullable().default(null),
  title: z.string().max(256).nullable().default(null),
  start: z.string().max(64).nullable().default(null),
  end: z.string().max(64).nullable().default(null),
  responsibilities: z.array(z.string().max(1024)).max(20).default([]),
});

export const ResumeEducationZod = z.object({
  school: z.string().max(256).nullable().default(null),
  degree: z.string().max(256).nullable().default(null),
  major: z.string().max(256).nullable().default(null),
  start: z.string().max(64).nullable().default(null),
  end: z.string().max(64).nullable().default(null),
});

export const ResumeCertificateZod = z.object({
  name: z.string().max(256),
  issuer: z.string().max(256).nullable().default(null),
  year: z.string().max(64).nullable().default(null),
});

export const ResumeDraftZod = z.object({
  fullName: z.string().max(256).nullable().default(null),
  headline: z.string().max(256).nullable().default(null),
  summary: z.string().max(2048).nullable().default(null),
  phone: z.string().max(128).nullable().default(null),
  email: z.string().max(256).nullable().default(null),
  location: z.string().max(256).nullable().default(null),
  targetRoles: z.array(z.string().max(128)).max(10).default([]),
  experiences: z.array(ResumeExperienceZod).max(10).default([]),
  education: z.array(ResumeEducationZod).max(5).default([]),
  skills: z.array(z.string().max(128)).max(50).default([]),
  languages: z.array(z.string().max(128)).max(10).default([]),
  certificates: z.array(ResumeCertificateZod).max(10).default([]),
  warnings: z.array(z.string().max(512)).max(10).default([]),
  sourceLanguage: z.enum(['en', 'zh_CN', 'km', 'mixed']).nullable().default(null),
});

export type ResumeDraft = z.infer<typeof ResumeDraftZod>;
