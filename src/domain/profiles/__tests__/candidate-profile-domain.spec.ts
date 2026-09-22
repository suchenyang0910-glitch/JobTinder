import { describe, it, expect } from 'vitest';
import {
  applyUserEdits,
  isProfileReadyToConfirm,
  mergeAIDraftIntoConfirmed,
  type CandidateProfileState,
} from '@src/domain/profiles/candidate-profile-domain';

const BASE_CONFIRMED: CandidateProfileState = {
  userId: 1,
  version: 3,
  status: 'CONFIRMED',
  fields: {
    targetRoles: ['Barista'],
    skills: ['Coffee', 'Customer service'],
    industries: ['F&B'],
    locations: ['Phnom Penh'],
  },
  fieldSources: {
    targetRoles: 'user_confirmed',
    skills: 'user_confirmed',
    industries: 'ai_extracted',
    locations: 'user_confirmed',
  },
  confirmedAt: new Date(),
  draftSource: 'manual',
};

describe('mergeAIDraftIntoConfirmed - never overwrites user_confirmed fields', () => {
  it('keeps targetRoles and skills untouched (user_confirmed)', () => {
    const aiDraft = {
      targetRoles: ['Hotel receptionist'],
      skills: ['Reception'],
      industries: ['Hotel'],
    };
    const { next, nextSources, changedFields } = mergeAIDraftIntoConfirmed(
      BASE_CONFIRMED,
      aiDraft,
      'mock',
    );
    expect(next.targetRoles).toEqual(['Barista']); // preserved
    expect(next.skills).toEqual(['Coffee', 'Customer service']); // preserved
    expect(next.industries).toEqual(['Hotel']); // updated (was ai_extracted)
    expect(changedFields).toEqual(['industries']);
    expect(nextSources.targetRoles).toBe('user_confirmed');
    expect(nextSources.industries).toBe('ai_extracted');
  });

  it('does not produce phantom changes when AI draft empty', () => {
    const { changedFields } = mergeAIDraftIntoConfirmed(BASE_CONFIRMED, {}, 'mock');
    expect(changedFields).toEqual([]);
  });
});

describe('applyUserEdits', () => {
  it('applies edits and reports changed fields', () => {
    const { next, changedFields } = applyUserEdits(
      { targetRoles: ['Barista'], skills: ['Coffee'] },
      { skills: ['Coffee', 'English'], industries: ['F&B'] },
    );
    expect(next.skills).toEqual(['Coffee', 'English']);
    expect(next.industries).toEqual(['F&B']);
    expect(next.targetRoles).toEqual(['Barista']);
    expect(changedFields.sort()).toEqual(['industries', 'skills']);
  });
});

describe('isProfileReadyToConfirm', () => {
  it('requires skills + targetRoles at minimum', () => {
    expect(isProfileReadyToConfirm({}).ok).toBe(false);
    expect(isProfileReadyToConfirm({ targetRoles: ['a'] }).ok).toBe(false);
    expect(isProfileReadyToConfirm({ skills: ['a'] }).ok).toBe(false);
    expect(isProfileReadyToConfirm({ targetRoles: ['a'], skills: ['b'] }).ok).toBe(true);
  });
});
