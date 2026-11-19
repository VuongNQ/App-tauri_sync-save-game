/** Validate a trusted Auth lookup before preparing a protected role write. */
export function rolePlan({ project, uid, googleId, role, user, apply = false }) {
  if (!project || !uid || !/^\d+$/.test(googleId ?? '') || !['admin', 'user'].includes(role)) {
    throw new Error('Explicit project, Firebase UID, numeric Google ID and role are required');
  }
  if (user.uid !== uid || user.disabled || !user.providerData.some(p => p.providerId === 'google.com' && p.uid === googleId)) {
    throw new Error('Firebase UID is not linked to the expected active Google account');
  }
  return { project, path: `roles/${googleId}`, data: { role }, apply: apply === true };
}
